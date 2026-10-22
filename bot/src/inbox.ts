import { createHash } from 'node:crypto';
import { db, FieldValue, Timestamp } from './firebase.ts';
import { env } from './env.ts';
import { getConfig, stageForChat } from './config.ts';
import { log, errFields } from './log.ts';
import { queueFor } from './queue.ts';
import { assertLeaseOwner, leaseGeneration, LeaseFencedError, STATE } from './state.ts';
import { noteInbound, bump, updateInboxMetrics } from './status.ts';
import { albumIsReady, retryDelayMs } from './reliabilityCore.ts';
import { ingestMessages, applyEdit } from './sync/inbound.ts';
import { FileIngestError } from './sync/media.ts';
import { TelegramApiError, type TgMessage, type TgUpdate } from './telegram/types.ts';
import type { TelegramChannel } from '../../shared/telegramMirror.ts';

export const INBOX_COLLECTION = 'telegramInboundUpdates';
export const ALBUM_COLLECTION = 'telegramInboundAlbums';

const inbox = db.collection(INBOX_COLLECTION);
const albums = db.collection(ALBUM_COLLECTION);
const ALBUM_INACTIVITY_MS = env.albumInactivityMs;
const ALBUM_MAX_ASSEMBLY_MS = env.albumMaxAssemblyMs;
const CLAIM_STALE_MS = 5 * 60_000;
const MAX_ATTEMPTS = env.inboxMaxAttempts;

type InboxStatus = 'pending' | 'processing' | 'retry' | 'completed' | 'ignored' | 'dead_letter';

export interface StoredInboundUpdate {
  updateId: number;
  updateType: string;
  chatId: number | null;
  messageId: number | null;
  mediaGroupId: string | null;
  albumRefId: string | null;
  stageId: string | null;
  channel: TelegramChannel | null;
  rawUpdate: TgUpdate;
  status: InboxStatus;
  attempts: number;
  receivedAtMs: number;
  nextAttemptAtMs: number;
  processingStartedAtMs?: number;
  workerToken?: string | null;
  lastError?: { code: string; message: string; retryable: boolean } | null;
}

interface StoredAlbum {
  key: string;
  chatId: number;
  mediaGroupId: string;
  stageId: string | null;
  channel: TelegramChannel | null;
  updateIds: number[];
  messageIds: number[];
  firstReceivedAtMs: number;
  lastMemberAtMs: number;
  status: 'assembling' | 'processing' | 'retry' | 'completed' | 'dead_letter';
  attempts: number;
  nextAttemptAtMs: number;
  workerToken?: string | null;
}

const metrics = {
  lastDurableReceiptAt: null as number | null,
  lastProcessedAt: null as number | null,
  pendingEstimate: 0,
  retryCount: 0,
  deadLetterCount: 0,
  oldestPendingReceivedAt: null as number | null,
};

export const inboxSnapshot = () => ({
  ...metrics,
  oldestPendingAgeMs: metrics.oldestPendingReceivedAt == null
    ? 0
    : Math.max(0, Date.now() - metrics.oldestPendingReceivedAt),
});

function publishMetrics(): void {
  updateInboxMetrics(inboxSnapshot());
}

const updateRef = (updateId: number) => inbox.doc(String(updateId));
const albumDocumentId = (key: string): string => createHash('sha256').update(key).digest('hex');

function messageOf(update: TgUpdate): TgMessage | undefined {
  return update.channel_post ?? update.edited_channel_post;
}

function updateTypeOf(update: TgUpdate): string {
  if (update.channel_post) return 'channel_post';
  if (update.edited_channel_post) return 'edited_channel_post';
  if (update.my_chat_member) return 'my_chat_member';
  return 'unsupported';
}

function receiptShape(update: TgUpdate, now: number): StoredInboundUpdate {
  const message = messageOf(update);
  const chatId = message?.chat.id ?? update.my_chat_member?.chat.id ?? null;
  const stageId = chatId == null ? null : (stageForChat(chatId) ?? null);
  const configuredChannel = stageId ? getConfig().channels[stageId] : null;
  const channel = configuredChannel ? {
    chatId: configuredChannel.chatId,
    enabled: configuredChannel.enabled,
    mirrorIn: configuredChannel.mirrorIn,
    mirrorOut: configuredChannel.mirrorOut,
    ...(configuredChannel.displayName ? { displayName: configuredChannel.displayName } : {}),
  } : null;
  const albumKey = message?.media_group_id ? `${message.chat.id}:${message.media_group_id}` : null;

  return {
    updateId: update.update_id,
    updateType: updateTypeOf(update),
    chatId,
    messageId: message?.message_id ?? null,
    mediaGroupId: message?.media_group_id ?? null,
    albumRefId: albumKey ? albumDocumentId(albumKey) : null,
    stageId,
    channel,
    rawUpdate: update,
    status: 'pending',
    attempts: 0,
    receivedAtMs: now,
    nextAttemptAtMs: now,
    workerToken: null,
    lastError: null,
  };
}

/**
 * Atomically records every update in a Telegram response and advances the
 * durable checkpoint. The next getUpdates call is the actual Telegram ack.
 */
export async function persistInboundBatch(updates: TgUpdate[], checkpoint: number): Promise<void> {
  if (!updates.length) return;
  const now = Date.now();
  const records = updates.map(update => receiptShape(update, now));

  const albumGroups = new Map<string, StoredInboundUpdate[]>();
  for (const record of records) {
    if (!record.albumRefId) continue;
    const group = albumGroups.get(record.albumRefId) ?? [];
    group.push(record);
    albumGroups.set(record.albumRefId, group);
  }

  let created = 0;
  await db.runTransaction(async tx => {
    const stateSnap = await tx.get(STATE);
    assertLeaseOwner(stateSnap.data() ?? {});

    const updateSnaps = await Promise.all(records.map(record => tx.get(updateRef(record.updateId))));
    const albumEntries = [...albumGroups.entries()];
    const albumSnaps = await Promise.all(albumEntries.map(([id]) => tx.get(albums.doc(id))));

    records.forEach((record, index) => {
      if (updateSnaps[index].exists) return;
      created += 1;
      tx.set(updateRef(record.updateId), {
        ...record,
        firstReceivedAt: FieldValue.serverTimestamp(),
        lastReceivedAt: FieldValue.serverTimestamp(),
        leaseGeneration: leaseGeneration(),
      });
    });

    albumEntries.forEach(([id, members], index) => {
      const existing = albumSnaps[index].data() as StoredAlbum | undefined;
      const updateIds = [...new Set([...(existing?.updateIds ?? []), ...members.map(member => member.updateId)])]
        .sort((a, b) => a - b);
      const messageIds = [...new Set([...(existing?.messageIds ?? []), ...members.map(member => member.messageId ?? 0)])]
        .filter(Boolean)
        .sort((a, b) => a - b);
      const first = members[0];
      tx.set(albums.doc(id), {
        key: `${first.chatId}:${first.mediaGroupId}`,
        chatId: first.chatId,
        mediaGroupId: first.mediaGroupId,
        stageId: existing?.stageId ?? first.stageId,
        channel: existing?.channel ?? first.channel,
        updateIds,
        messageIds,
        firstReceivedAtMs: existing?.firstReceivedAtMs ?? now,
        lastMemberAtMs: now,
        status: 'assembling',
        attempts: existing?.attempts ?? 0,
        nextAttemptAtMs: now,
        workerToken: null,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    const previous = Number(stateSnap.data()?.offset ?? 0);
    tx.set(STATE, {
      offset: Math.max(previous, checkpoint),
      ackCheckpointAt: FieldValue.serverTimestamp(),
      ackCheckpointGeneration: leaseGeneration(),
    }, { merge: true });
  });

  metrics.lastDurableReceiptAt = now;
  metrics.pendingEstimate += created;
  if (created > 0 && metrics.oldestPendingReceivedAt == null) metrics.oldestPendingReceivedAt = now;
  publishMetrics();
  for (const record of records) {
    log.info('telegram.update.persisted', {
      updateId: record.updateId,
      updateType: record.updateType,
      chatId: record.chatId,
      messageId: record.messageId,
      mediaGroupId: record.mediaGroupId,
      stageId: record.stageId,
      leaseGeneration: leaseGeneration(),
    });
  }
  log.info('telegram.update.ack_checkpointed', { checkpoint, count: updates.length });
}

function workerToken(): string {
  return `${env.instanceId}:${leaseGeneration()}`;
}

function due(record: StoredInboundUpdate, now: number): boolean {
  return record.status === 'pending' || (record.status === 'retry' && record.nextAttemptAtMs <= now);
}

async function recoverStaleClaims(now: number): Promise<void> {
  const snap = await inbox.where('status', '==', 'processing').limit(100).get();
  const stale = snap.docs.filter(doc => {
    const record = doc.data() as StoredInboundUpdate;
    return now - Number(record.processingStartedAtMs ?? 0) >= CLAIM_STALE_MS;
  });
  if (!stale.length) return;
  const batch = db.batch();
  for (const doc of stale) {
    batch.update(doc.ref, {
      status: 'retry',
      nextAttemptAtMs: now,
      workerToken: null,
      lastError: { code: 'STALE_CLAIM', message: 'recovered after worker interruption', retryable: true },
    });
  }
  await batch.commit();
  log.warn('telegram.update.stale_claims_recovered', { count: stale.length });
}

export interface ClaimedWork {
  records: StoredInboundUpdate[];
  claimedIds: number[];
  albumRefId: string | null;
  attempt: number;
  workerToken: string;
}

async function claimSingle(record: StoredInboundUpdate, now: number): Promise<ClaimedWork | null> {
  const token = workerToken();
  return db.runTransaction(async tx => {
    const ref = updateRef(record.updateId);
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const current = snap.data() as StoredInboundUpdate;
    if (!due(current, now)) return null;
    const attempt = Number(current.attempts ?? 0) + 1;
    tx.update(ref, {
      status: 'processing',
      attempts: attempt,
      nextAttemptAtMs: FieldValue.delete(),
      lastAttemptAt: FieldValue.serverTimestamp(),
      processingStartedAtMs: now,
      workerToken: token,
    });
    return { records: [current], claimedIds: [current.updateId], albumRefId: null, attempt, workerToken: token };
  });
}

async function claimAlbum(albumRefId: string, now: number): Promise<ClaimedWork | null> {
  const token = workerToken();
  return db.runTransaction(async tx => {
    const albumRef = albums.doc(albumRefId);
    const albumSnap = await tx.get(albumRef);
    if (!albumSnap.exists) return null;
    const album = albumSnap.data() as StoredAlbum;
    if (
      album.status === 'processing'
      || album.status === 'dead_letter'
      || (album.status === 'retry' && album.nextAttemptAtMs > now)
      || !albumIsReady(album.firstReceivedAtMs, album.lastMemberAtMs, now, ALBUM_INACTIVITY_MS, ALBUM_MAX_ASSEMBLY_MS)
    ) return null;

    const refs = album.updateIds.map(updateRef);
    const snaps = await Promise.all(refs.map(ref => tx.get(ref)));
    const records = snaps.filter(snap => snap.exists).map(snap => snap.data() as StoredInboundUpdate);
    const claimable = records.filter(record => record.status !== 'completed' && record.status !== 'ignored');
    if (!claimable.length) return null;
    const attempt = Number(album.attempts ?? 0) + 1;

    for (const record of claimable) {
      tx.update(updateRef(record.updateId), {
        status: 'processing',
        attempts: Math.max(Number(record.attempts ?? 0) + 1, attempt),
        nextAttemptAtMs: FieldValue.delete(),
        lastAttemptAt: FieldValue.serverTimestamp(),
        processingStartedAtMs: now,
        workerToken: token,
      });
    }
    tx.update(albumRef, {
      status: 'processing',
      attempts: attempt,
      nextAttemptAtMs: FieldValue.delete(),
      workerToken: token,
    });
    return {
      records: records.sort((a, b) => (a.messageId ?? 0) - (b.messageId ?? 0)),
      claimedIds: claimable.map(record => record.updateId),
      albumRefId,
      attempt,
      workerToken: token,
    };
  });
}

async function applyClaimed(work: ClaimedWork): Promise<'completed' | 'ignored'> {
  const first = work.records[0];
  if (!first) return 'ignored';

  if (first.updateType === 'my_chat_member' || first.updateType === 'unsupported') return 'ignored';
  if (!first.stageId || !first.channel) {
    log.warn('telegram.update.ignored', {
      updateId: first.updateId,
      reason: 'unmapped_chat_at_receipt',
      chatId: first.chatId,
    });
    return 'ignored';
  }

  const context = { stageId: first.stageId, channel: first.channel };
  if (work.albumRefId) {
    const messages = work.records.map(record => messageOf(record.rawUpdate)).filter(Boolean) as TgMessage[];
    await queueFor(first.chatId!).push(`inbox-album:${work.albumRefId}`, () => ingestMessages(messages, context));
  } else if (first.rawUpdate.edited_channel_post) {
    await queueFor(first.chatId!).push(`inbox-edit:${first.updateId}`, () =>
      applyEdit(first.rawUpdate.edited_channel_post!, context));
  } else if (first.rawUpdate.channel_post) {
    await queueFor(first.chatId!).push(`inbox-post:${first.updateId}`, () =>
      ingestMessages([first.rawUpdate.channel_post!], context));
  } else {
    return 'ignored';
  }
  noteInbound(first.stageId);
  return 'completed';
}

function classifyProcessingFailure(error: unknown): { code: string; retryable: boolean; message: string } {
  if (error instanceof FileIngestError) {
    return { code: error.code, retryable: error.retryable, message: error.message };
  }
  if (error instanceof TelegramApiError) {
    return { code: `TELEGRAM_${error.errorCode}`, retryable: error.isRetryable, message: error.description };
  }
  if (error instanceof LeaseFencedError) {
    return { code: 'LEASE_FENCED', retryable: true, message: error.message };
  }
  const rawCode = String((error as { code?: unknown } | null)?.code ?? 'PROCESSING_FAILED');
  const permanent = rawCode === '3' || rawCode === 'INVALID_ARGUMENT';
  return {
    code: rawCode.slice(0, 80),
    retryable: !permanent,
    message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
  };
}

async function finishWork(work: ClaimedWork, status: 'completed' | 'ignored'): Promise<void> {
  await db.runTransaction(async tx => {
    const refs = work.claimedIds.map(updateRef);
    const snaps = await Promise.all(refs.map(ref => tx.get(ref)));
    if (snaps.some(snap => snap.data()?.workerToken !== work.workerToken || snap.data()?.status !== 'processing')) {
      log.warn('telegram.update.completion_fenced', { updateIds: work.claimedIds });
      return;
    }
    for (const ref of refs) {
      tx.update(ref, {
        status,
        processedAt: FieldValue.serverTimestamp(),
        expireAt: Timestamp.fromMillis(Date.now() + env.inboxRetentionMs),
        nextAttemptAtMs: FieldValue.delete(),
        workerToken: null,
        lastError: null,
      });
    }
    if (work.albumRefId) {
      tx.update(albums.doc(work.albumRefId), {
        status: 'completed',
        completedAt: FieldValue.serverTimestamp(),
        expireAt: Timestamp.fromMillis(Date.now() + env.inboxRetentionMs),
        nextAttemptAtMs: FieldValue.delete(),
        workerToken: null,
        completedBy: work.workerToken,
      });
    }
  });
  metrics.lastProcessedAt = Date.now();
  metrics.pendingEstimate = Math.max(0, metrics.pendingEstimate - work.claimedIds.length);
  publishMetrics();
  bump(status === 'completed' ? 'inboxCompleted' : 'inboxIgnored');
  for (const updateId of work.claimedIds) {
    log.info('telegram.update.completed', { updateId, status, attempt: work.attempt });
  }
}

async function failWork(work: ClaimedWork, error: unknown): Promise<void> {
  const failure = classifyProcessingFailure(error);
  const dead = !failure.retryable || work.attempt >= MAX_ATTEMPTS;
  const nextAttemptAtMs = Date.now() + retryDelayMs(work.attempt);
  await db.runTransaction(async tx => {
    const refs = work.claimedIds.map(updateRef);
    const snaps = await Promise.all(refs.map(ref => tx.get(ref)));
    if (snaps.some(snap => snap.data()?.workerToken !== work.workerToken || snap.data()?.status !== 'processing')) {
      log.warn('telegram.update.failure_fenced', { updateIds: work.claimedIds });
      return;
    }
    for (const ref of refs) {
      tx.update(ref, {
        status: dead ? 'dead_letter' : 'retry',
        nextAttemptAtMs: dead ? FieldValue.delete() : nextAttemptAtMs,
        workerToken: null,
        lastError: failure,
        failedAt: FieldValue.serverTimestamp(),
      });
    }
    if (work.albumRefId) {
      tx.update(albums.doc(work.albumRefId), {
        status: dead ? 'dead_letter' : 'retry',
        nextAttemptAtMs: dead ? FieldValue.delete() : nextAttemptAtMs,
        workerToken: null,
        lastError: failure,
      });
    }
  });

  if (dead) {
    metrics.deadLetterCount += work.claimedIds.length;
    publishMetrics();
    bump('inboxDeadLettered');
    log.error('telegram.update.dead_lettered', {
      updateIds: work.claimedIds,
      attempt: work.attempt,
      errorCode: failure.code,
      retryable: failure.retryable,
      ...errFields(error),
    });
  } else {
    metrics.retryCount += 1;
    publishMetrics();
    bump('inboxRetries');
    log.warn('telegram.update.retry_scheduled', {
      updateIds: work.claimedIds,
      attempt: work.attempt,
      errorCode: failure.code,
      nextRetryAt: new Date(nextAttemptAtMs).toISOString(),
      ...errFields(error),
    });
  }
}

/** Processes a bounded amount of durable work; returns how many claims ran. */
export async function processAvailableWork(
  limit = 25,
  handler: (work: ClaimedWork) => Promise<'completed' | 'ignored'> = applyClaimed,
): Promise<number> {
  const now = Date.now();
  await recoverStaleClaims(now);
  const dueSnapshot = await inbox.where('nextAttemptAtMs', '<=', now).limit(100).get();
  const candidates = dueSnapshot.docs
    .map(doc => doc.data() as StoredInboundUpdate)
    .filter(record => due(record, now))
    .sort((a, b) => a.updateId - b.updateId);

  let processed = 0;
  const seenAlbums = new Set<string>();
  for (const candidate of candidates) {
    if (processed >= limit) break;
    if (candidate.albumRefId && seenAlbums.has(candidate.albumRefId)) continue;
    if (candidate.albumRefId) seenAlbums.add(candidate.albumRefId);

    const work = candidate.albumRefId
      ? await claimAlbum(candidate.albumRefId, now)
      : await claimSingle(candidate, now);
    if (!work) continue;
    processed += 1;
    log.info('telegram.update.processing', {
      updateIds: work.claimedIds,
      mediaGroupId: work.records[0]?.mediaGroupId,
      stageId: work.records[0]?.stageId,
      attempt: work.attempt,
    });
    try {
      await finishWork(work, await handler(work));
    } catch (error) {
      await failWork(work, error);
    }
  }
  return processed;
}

export async function runInboxWorker(shouldRun: () => boolean): Promise<void> {
  while (shouldRun()) {
    try {
      const processed = await processAvailableWork();
      if (processed === 0) await new Promise(resolve => setTimeout(resolve, 1_000));
    } catch (error) {
      log.warn('telegram.inbox.worker_failed', { ...errFields(error) });
      await new Promise(resolve => setTimeout(resolve, 2_000));
    }
  }
}
