import { db, Timestamp } from './firebase.ts';
import { env } from './env.ts';
import { log, errFields } from './log.ts';
import { TelegramApiError } from './telegram/types.ts';
import { outboundChannelFor, lectureChannelFor, onConfigChange, getConfig } from './config.ts';
import { sendLectureToTelegram, type LectureDoc } from './sync/lectures.ts';
import { queueFor } from './queue.ts';
import { MIRROR_STAGE_IDS } from '../../shared/telegramMirror.ts';
import {
  hashOf, sendAnnouncement, editAnnouncement, deleteAnnouncementMessages,
  type OutboundDoc,
} from './sync/outbound.ts';
import { noteOutbound, markChannel } from './status.ts';
import { firestoreStreamsEnabled } from './firestoreTransport.ts';

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
const retryTimers = new Map<string, NodeJS.Timeout>();
const retryAttempts = new Map<string, number>();
const knownDocs = new Map<string, Map<string, { version: number; data: Record<string, unknown> }>>();
const WATCHER_POLL_MS = 30_000;

function clearRetry(announcementId: string): void {
  const timer = retryTimers.get(announcementId);
  if (timer) clearTimeout(timer);
  retryTimers.delete(announcementId);
  retryAttempts.delete(announcementId);
}

/** Firestore remains the durable outbound queue: an unstamped document is retried. */
function scheduleRetry(announcementId: string, stageId: string): void {
  if (retryTimers.has(announcementId)) return;
  const attempt = (retryAttempts.get(announcementId) ?? 0) + 1;
  retryAttempts.set(announcementId, attempt);
  const delayMs = Math.min(5 * 60_000, 2 ** Math.min(attempt, 8) * 1_000);
  const timer = setTimeout(() => {
    retryTimers.delete(announcementId);
    void db.collection('announcements').doc(announcementId).get()
      .then(snap => {
        if (snap.exists && outboundChannelFor(stageId)) {
          return handleUpsert(snap.id, snap.data()!, stageId);
        }
        clearRetry(announcementId);
        return undefined;
      })
      .catch(error => {
        log.error('tg.out.retry_failed', { stageId, announcementId, ...errFields(error) });
        scheduleRetry(announcementId, stageId);
      });
  }, delayMs + Math.random() * 0.2 * delayMs);
  timer.unref();
  retryTimers.set(announcementId, timer);
  log.warn('tg.out.retry_scheduled', { stageId, announcementId, attempt, delayMs });
}

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
    clearRetry(id);
    log.debug('tg.out.skipped', { reason: 'opted_out', announcementId: id });
    return;
  }

  // A post the bot itself ingested is already in the channel by definition.
  if (doc.telegramMirror?.origin === 'telegram' && isUpToDate(doc)) {
    clearRetry(id);
    return;
  }

  if (isUpToDate(doc)) {
    clearRetry(id);
    log.debug('tg.out.skipped', { reason: 'hash_unchanged', announcementId: id });
    return;
  }

  const age = Date.now() - createdAtMs(data);
  if (age > env.mirrorMaxAgeMs) {
    clearRetry(id);
    log.debug('tg.out.skipped', { reason: 'too_old', announcementId: id, ageMs: age });
    return;
  }

  const channel = outboundChannelFor(stageId);
  if (!channel) {
    clearRetry(id);
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
      clearRetry(id);
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
      scheduleRetry(id, stageId);
    }
  });
}


const lectureWatchers = new Map<string, () => void>();
const knownLectures = new Map<string, Set<string>>();

async function handleLectureUpsert(id: string, data: Record<string, unknown>, stageId: string): Promise<void> {
  if ((data.telegramPost as any)?.messageId) return;

  const age = Date.now() - createdAtMs(data);
  if (age > env.mirrorMaxAgeMs) {
    log.debug('tg.lecture.skipped', { reason: 'too_old', lectureId: id, ageMs: age });
    return;
  }

  const chatId = lectureChannelFor(stageId);
  if (!chatId) {
    log.debug('tg.lecture.skipped', { reason: 'stage_unmapped', lectureId: id, stageId });
    return;
  }

  const lecture: LectureDoc = {
    id,
    title: String(data.title || ''),
    subjectName: data.subjectName ? String(data.subjectName) : undefined,
    subjectId: data.subjectId ? String(data.subjectId) : undefined,
    stageId,
    type: data.type as any,
    number: typeof data.number === 'number' ? data.number : null,
    pdfUrl: data.pdfUrl ? String(data.pdfUrl) : undefined,
    youtubeUrl: data.youtubeUrl ? String(data.youtubeUrl) : undefined,
    telegramPost: data.telegramPost as any,
  };

  await queueFor(chatId).push(`lec:${id}`, async () => {
    try {
      await sendLectureToTelegram(lecture, chatId);
      noteOutbound(stageId);
      markChannel(stageId, { state: 'ok', lastError: null });
    } catch (error) {
      if (error instanceof TelegramApiError && error.isAccessProblem) {
        markChannel(stageId, { state: 'parked', lastError: error.description });
        log.error('tg.lecture.access_problem', { stageId, chatId, description: error.description });
        return;
      }
      markChannel(stageId, { state: 'degraded', lastError: String(error) });
      log.error('tg.lecture.failed', { stageId, lectureId: id, ...errFields(error) });
    }
  });
}

function attachLecture(stageId: string): void {
  detachLecture(stageId);
  const cutoff = Timestamp.fromMillis(Date.now() - env.mirrorMaxAgeMs);

  const query = db.collection('lectures')
    .where('stageId', '==', stageId)
    .where('createdAt', '>=', cutoff);

  const known = new Set<string>();
  knownLectures.set(stageId, known);
  let stopped = false;
  let pollRunning = false;

  const applyUpsert = async (id: string, data: Record<string, unknown>) => {
    if (known.has(id)) return;
    known.add(id);
    try {
      await handleLectureUpsert(id, data, stageId);
    } catch (error) {
      known.delete(id);
      throw error;
    }
  };

  const poll = async () => {
    if (stopped || pollRunning) return;
    pollRunning = true;
    try {
      const snapshot = await query.get();
      for (const doc of snapshot.docs) {
        await applyUpsert(doc.id, doc.data());
      }
    } catch (error) {
      log.error('watcher.lecture_poll_failed', { stageId, ...errFields(error) });
    } finally {
      pollRunning = false;
    }
  };

  const unsubscribe = firestoreStreamsEnabled(env.firestoreTransport)
    ? query.onSnapshot(
        snapshot => {
          void (async () => {
            for (const change of snapshot.docChanges()) {
              if (change.type !== 'removed') {
                await applyUpsert(change.doc.id, change.doc.data());
              }
            }
          })().catch(error => {
            log.error('watcher.lecture_snapshot_failed', { stageId, ...errFields(error) });
          });
        },
        error => {
          log.error('listener.lecture_error', { stageId, ...errFields(error) });
          void poll();
        },
      )
    : () => {};

  void poll();
  const pollTimer = setInterval(() => { void poll(); }, WATCHER_POLL_MS);
  pollTimer.unref();

  lectureWatchers.set(stageId, () => {
    stopped = true;
    clearInterval(pollTimer);
    unsubscribe();
    knownLectures.delete(stageId);
  });
  log.info('watcher.lecture_attached', { stageId });
}

function detachLecture(stageId: string): void {
  const unsubscribe = lectureWatchers.get(stageId);
  if (unsubscribe) {
    unsubscribe();
    lectureWatchers.delete(stageId);
    log.info('watcher.lecture_detached', { stageId });
  }
}

function attach(stageId: string): void {
  detach(stageId);

  // Bounded by createdAt: without this, attaching a listener would deliver
  // every announcement the stage has ever had as `added`. The hash gate would
  // skip them all, but at the cost of a full read of the collection on every
  // boot and every reconnect.
  const cutoff = Timestamp.fromMillis(Date.now() - env.mirrorMaxAgeMs);

  const query = db.collection('announcements')
    .where('stageId', '==', stageId)
    .where('createdAt', '>=', cutoff);
  const known = new Map<string, { version: number; data: Record<string, unknown> }>();
  knownDocs.set(stageId, known);
  let stopped = false;
  let pollRunning = false;

  const applyUpsert = async (
    id: string,
    data: Record<string, unknown>,
    version: number,
    source: 'stream' | 'poll',
  ) => {
    if (known.get(id)?.version === version) return;
    // Claim the version before awaiting so a simultaneous stream/poll delivery
    // cannot enqueue the same unstamped announcement twice.
    known.set(id, { version, data });
    try {
      await handleUpsert(id, data, stageId);
    } catch (error) {
      known.delete(id);
      log.error('watcher.upsert_failed', { source, stageId, announcementId: id, ...errFields(error) });
      throw error;
    }
  };

  const poll = async () => {
    if (stopped || pollRunning) return;
    pollRunning = true;
    try {
      const snapshot = await query.get();
      const present = new Set<string>();
      for (const doc of snapshot.docs) {
        present.add(doc.id);
        await applyUpsert(doc.id, doc.data(), doc.updateTime.toMillis(), 'poll');
      }
      for (const [id, cached] of [...known]) {
        if (present.has(id)) continue;
        known.delete(id);
        await handleRemoval(id, cached.data);
      }
    } catch (error) {
      log.error('watcher.poll_failed', { stageId, ...errFields(error) });
      markChannel(stageId, { state: 'degraded', lastError: String(error) });
    } finally {
      pollRunning = false;
    }
  };

  const unsubscribe = firestoreStreamsEnabled(env.firestoreTransport)
    ? query.onSnapshot(
        snapshot => {
          // Apply one snapshot sequentially. This supplies real backpressure
          // to the bounded per-chat queue during reconnect bursts.
          void (async () => {
            for (const change of snapshot.docChanges()) {
              if (change.type === 'removed') {
                if (!known.has(change.doc.id)) continue;
                known.delete(change.doc.id);
                await handleRemoval(change.doc.id, change.doc.data());
              } else {
                await applyUpsert(
                  change.doc.id,
                  change.doc.data(),
                  change.doc.updateTime.toMillis(),
                  'stream',
                );
              }
            }
          })().catch(error => {
            log.error('watcher.snapshot_failed', { stageId, ...errFields(error) });
            markChannel(stageId, { state: 'degraded', lastError: String(error) });
          });
        },
        error => {
          log.error('listener.error', { stageId, ...errFields(error) });
          markChannel(stageId, { state: 'degraded', lastError: String(error) });
          void poll();
        },
      )
    : () => {};

  void poll();
  const pollTimer = setInterval(() => { void poll(); }, WATCHER_POLL_MS);
  pollTimer.unref();

  watchers.set(stageId, () => {
    stopped = true;
    clearInterval(pollTimer);
    unsubscribe();
    knownDocs.delete(stageId);
  });
  log.info('watcher.attached', {
    stageId,
    cutoff: cutoff.toDate().toISOString(),
    fallbackPollMs: WATCHER_POLL_MS,
    transport: env.firestoreTransport,
  });
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

      const wantedLecture = !!lectureChannelFor(stageId);
      const attachedLecture = lectureWatchers.has(stageId);
      if (wantedLecture && !attachedLecture) attachLecture(stageId);
      if (!wantedLecture && attachedLecture) detachLecture(stageId);
    }
  };

  sync();
  const off = onConfigChange(sync);

  return () => {
    off();
    for (const stageId of [...watchers.keys()]) detach(stageId);
    for (const stageId of [...lectureWatchers.keys()]) detachLecture(stageId);
    for (const announcementId of [...retryTimers.keys()]) clearRetry(announcementId);
  };
}

export const configuredStageCount = (): number =>
  MIRROR_STAGE_IDS.filter(s => !!getConfig().channels[s]?.enabled).length;

export const configuredOutboundStageCount = (): number =>
  MIRROR_STAGE_IDS.filter(s => !!outboundChannelFor(s)).length;
