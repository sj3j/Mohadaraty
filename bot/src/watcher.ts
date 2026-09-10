import { db, Timestamp } from './firebase.ts';
import { env } from './env.ts';
import { log, errFields } from './log.ts';
import { TelegramApiError } from './telegram/types.ts';
import { outboundChannelFor, onConfigChange, getConfig } from './config.ts';
import { queueFor } from './queue.ts';
import { MIRROR_STAGE_IDS } from '../../shared/telegramMirror.ts';
import {
  hashOf, sendAnnouncement, editAnnouncement, deleteAnnouncementMessages,
  type OutboundDoc,
} from './sync/outbound.ts';
import { noteOutbound, markChannel } from './status.ts';

/**
 * Firestore -> Telegram.
 *
 * One onSnapshot per mirrored stage, each bounded by createdAt so a restart
 * cannot re-post the back catalogue. The listener replays `added` for every
 * matching document on reconnect, which is exactly why every send is gated on
 * the mirror hash: on a reconnect the whole window hashes equal and nothing is
 * sent.
 */

const watchers = new Map<string, () => void>();

/** True when the document already reflects what is live in Telegram. */
function isUpToDate(doc: OutboundDoc): boolean {
  return doc.telegramMirror?.appliedHash === hashOf(doc);
}

function createdAtMs(data: Record<string, unknown>): number {
  const created = data.createdAt as Timestamp | undefined;
  return created?.toMillis ? created.toMillis() : 0;
}

async function handleUpsert(id: string, data: Record<string, unknown>, stageId: string): Promise<void> {
  const doc: OutboundDoc = { id, ...(data as Omit<OutboundDoc, 'id'>) };

  // The per-post opt-out. `enabled: false` means the moderator deliberately
  // kept this one inside the app.
  if (doc.telegramMirror?.enabled === false) {
    log.debug('tg.out.skipped', { reason: 'opted_out', announcementId: id });
    return;
  }

  // A post the bot itself ingested is already in the channel by definition.
  if (doc.telegramMirror?.origin === 'telegram' && isUpToDate(doc)) return;

  if (isUpToDate(doc)) {
    log.debug('tg.out.skipped', { reason: 'hash_unchanged', announcementId: id });
    return;
  }

  const age = Date.now() - createdAtMs(data);
  if (age > env.mirrorMaxAgeMs) {
    log.debug('tg.out.skipped', { reason: 'too_old', announcementId: id, ageMs: age });
    return;
  }

  const channel = outboundChannelFor(stageId);
  if (!channel) {
    log.debug('tg.out.skipped', { reason: 'stage_unmapped', announcementId: id, stageId });
    return;
  }

  // The chat id is resolved ONCE here and carried into the job. If the config
  // is repointed while this is queued, the job still completes against the
  // channel it was resolved for - which is correct, because that is where the
  // message will actually be, and where a later edit must find it.
  const chatId = channel.chatId;

  await queueFor(chatId).push(`out:${id}`, async () => {
    try {
      const alreadySent = (doc.telegramMirror?.messageIds?.length ?? 0) > 0;
      if (alreadySent) await editAnnouncement(doc, chatId);
      else await sendAnnouncement(doc, chatId, stageId);
      noteOutbound(stageId);
      markChannel(stageId, { state: 'ok', lastError: null });
    } catch (error) {
      if (error instanceof TelegramApiError && error.isAccessProblem) {
        // Fail the STAGE, not the process. The other four keep running, and the
        // admin screen shows the verbatim reason next to that channel's row.
        markChannel(stageId, { state: 'parked', lastError: error.description });
        log.error('tg.out.access_problem', { stageId, chatId, description: error.description });
        return;
      }
      markChannel(stageId, { state: 'degraded', lastError: String(error) });
      log.error('tg.out.failed', { stageId, announcementId: id, ...errFields(error) });
    }
  });
}

function attach(stageId: string): void {
  detach(stageId);

  // Bounded by createdAt: without this, attaching a listener would deliver
  // every announcement the stage has ever had as `added`. The hash gate would
  // skip them all, but at the cost of a full read of the collection on every
  // boot and every reconnect.
  const cutoff = Timestamp.fromMillis(Date.now() - env.mirrorMaxAgeMs);

  const unsubscribe = db.collection('announcements')
    .where('stageId', '==', stageId)
    .where('createdAt', '>=', cutoff)
    .onSnapshot(
      snapshot => {
        for (const change of snapshot.docChanges()) {
          if (change.type === 'removed') {
            void handleRemoval(change.doc.id, change.doc.data());
          } else {
            void handleUpsert(change.doc.id, change.doc.data(), stageId);
          }
        }
      },
      error => {
        // A terminal listener error (PERMISSION_DENIED, UNAUTHENTICATED) is not
        // retried by the SDK - the listener is simply dead. Re-attach with a
        // delay rather than leaving the stage silently unmirrored.
        log.error('listener.error', { stageId, ...errFields(error) });
        markChannel(stageId, { state: 'degraded', lastError: String(error) });
        setTimeout(() => { if (outboundChannelFor(stageId)) attach(stageId); }, 15_000);
      },
    );

  watchers.set(stageId, unsubscribe);
  log.info('watcher.attached', { stageId, cutoff: cutoff.toDate().toISOString() });
}

/**
 * `removed` is NOT the same as deleted.
 *
 * Firestore fires it when a document stops matching the query - a stageId
 * change, or ageing past the createdAt cutoff - as well as on a real delete.
 * Deleting the channel message on an age-out would silently erase history, so
 * this confirms with a point read first.
 */
async function handleRemoval(id: string, cached: Record<string, unknown>): Promise<void> {
  try {
    const snap = await db.collection('announcements').doc(id).get();
    if (snap.exists) {
      log.debug('tg.out.removal_ignored', { announcementId: id, reason: 'still_exists' });
      return;
    }

    const mirror = cached.telegramMirror as { chatId?: number; messageIds?: number[] } | undefined;
    if (!mirror?.chatId || !mirror.messageIds?.length) {
      await deleteAnnouncementMessages(id);
      return;
    }
    await queueFor(mirror.chatId).push(`del:${id}`, () =>
      deleteAnnouncementMessages(id, { chatId: mirror.chatId, messageIds: mirror.messageIds }));
  } catch (error) {
    log.error('tg.out.removal_failed', { announcementId: id, ...errFields(error) });
  }
}

function detach(stageId: string): void {
  const unsubscribe = watchers.get(stageId);
  if (unsubscribe) {
    unsubscribe();
    watchers.delete(stageId);
    log.info('watcher.detached', { stageId });
  }
}

export const attachedStages = (): string[] => [...watchers.keys()];

/** Attaches a watcher per outbound-enabled stage, and keeps that in step with
 *  the config. Detaching does NOT cancel queued jobs - they were resolved
 *  against a real chat id and remain valid. */
export function startWatchers(): () => void {
  const sync = () => {
    for (const stageId of MIRROR_STAGE_IDS) {
      const wanted = !!outboundChannelFor(stageId);
      const attached = watchers.has(stageId);
      if (wanted && !attached) attach(stageId);
      if (!wanted && attached) detach(stageId);
    }
  };

  sync();
  const off = onConfigChange(sync);

  return () => {
    off();
    for (const stageId of [...watchers.keys()]) detach(stageId);
  };
}

export const configuredStageCount = (): number =>
  MIRROR_STAGE_IDS.filter(s => !!getConfig().channels[s]?.enabled).length;
