import { db, FieldValue } from './firebase.ts';
import { env } from './env.ts';
import { log } from './log.ts';
import { queueDepths, queueOldestPendingAges } from './queue.ts';
import { getConfigError } from './config.ts';
import { leaseHealth } from './state.ts';

/**
 * The bot's self-reported health, written to `admin_config/telegram_status`.
 *
 * This document is the whole reason the admin screen is not a black box. The
 * master admin is not on the Docker host and has no `docker logs`, so without
 * it "is the mirror working?" has no answer short of posting a test message.
 *
 * Rules make it master-admin read and NOBODY write, because the bot writes it
 * through the Admin SDK - if a client could write it, "the bot is healthy"
 * would be forgeable.
 */

interface ChannelStatus {
  chatId?: number;
  title?: string;
  adminOk?: boolean;
  missingRights?: string[];
  lastInboundAt?: string | null;
  lastOutboundAt?: string | null;
  inbound24h?: number;
  outbound24h?: number;
  state?: 'ok' | 'degraded' | 'parked';
  lastError?: string | null;
  lastErrorAt?: string | null;
}

const channels: Record<string, ChannelStatus> = {};
const counters: Record<string, number> = {};
let pollState: 'polling' | 'backoff' | 'stalled' = 'polling';
let inboxMetrics: Record<string, unknown> = {};

export function updateInboxMetrics(next: Record<string, unknown>): void {
  inboxMetrics = next;
  schedule();
}

export function setPollState(next: typeof pollState): void {
  if (next !== pollState) {
    pollState = next;
    // A state transition is worth reporting immediately rather than waiting
    // out the debounce - it is exactly what someone opening the screen wants.
    void flush(true);
  }
}

export function markChannel(stageId: string, patch: Partial<ChannelStatus>): void {
  const previous = channels[stageId] ?? {};
  // Firestore rejects `undefined` anywhere in a document. Telegram omits a
  // title when getChat fails (for example, a stale/private chat id), so do not
  // let a diagnostic field prevent the entire heartbeat from being written.
  const definedPatch = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<ChannelStatus>;
  channels[stageId] = {
    ...previous,
    ...definedPatch,
    ...(definedPatch.lastError ? { lastErrorAt: new Date().toISOString() } : {}),
  };
  if (definedPatch.state && definedPatch.state !== previous.state) void flush(true);
  else schedule();
}

export function noteInbound(stageId: string): void {
  const entry = channels[stageId] ?? (channels[stageId] = {});
  entry.lastInboundAt = new Date().toISOString();
  entry.inbound24h = (entry.inbound24h ?? 0) + 1;
  schedule();
}

export function noteOutbound(stageId: string): void {
  const entry = channels[stageId] ?? (channels[stageId] = {});
  entry.lastOutboundAt = new Date().toISOString();
  entry.outbound24h = (entry.outbound24h ?? 0) + 1;
  schedule();
}

export function bump(counter: string): void {
  counters[counter] = (counters[counter] ?? 0) + 1;
  schedule();
}

/** Rolled at midnight so the 24h counters mean what they say. */
setInterval(() => {
  for (const entry of Object.values(channels)) {
    entry.inbound24h = 0;
    entry.outbound24h = 0;
  }
  for (const key of Object.keys(counters)) counters[key] = 0;
}, 24 * 60 * 60 * 1000).unref();

let timer: NodeJS.Timeout | null = null;
let lastWriteAt = 0;
/** At most one write every 30s. ~2,880/day, which is negligible - and enough
 *  for the UI to call the bot offline after two missed beats. */
const MIN_INTERVAL_MS = 30_000;

// Keep the admin screen truthful even when both directions are idle. Without
// this heartbeat, `updatedAt` only changed when some other metric changed and
// the UI declared a perfectly healthy bot offline after two minutes.
const heartbeatTimer = setInterval(() => { void flush(true); }, MIN_INTERVAL_MS);
heartbeatTimer.unref();

function schedule(): void {
  if (timer) return;
  const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastWriteAt));
  timer = setTimeout(() => { timer = null; void flush(); }, wait);
  timer.unref();
}

async function flush(immediate = false): Promise<void> {
  if (!immediate && Date.now() - lastWriteAt < MIN_INTERVAL_MS) return schedule();
  lastWriteAt = Date.now();

  try {
    await db.collection('admin_config').doc('telegram_status').set({
      instanceId: env.instanceId,
      version: env.version,
      pollState,
      configError: getConfigError(),
      channels,
      counters24h: counters,
      queueDepth: queueDepths(),
      queueOldestPendingAgeMs: queueOldestPendingAges(),
      inbox: inboxMetrics,
      lease: leaseHealth(),
      // An ISO string, not serverTimestamp: the UI computes heartbeat age from
      // it, and a sentinel would read back as null until the write lands.
      updatedAt: new Date().toISOString(),
    }, { merge: true });
  } catch (error) {
    log.warn('status.write_failed', { err: String(error) });
  }
}

export async function reportBoot(): Promise<void> {
  await db.collection('admin_config').doc('telegram_status').set({
    instanceId: env.instanceId,
    version: env.version,
    bootedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pollState: 'polling',
    channels: {},
    startedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

export const snapshot = () => ({
  pollState,
  channels,
  counters,
  queueDepth: queueDepths(),
  queueOldestPendingAgeMs: queueOldestPendingAges(),
  inbox: inboxMetrics,
  lease: leaseHealth(),
});
