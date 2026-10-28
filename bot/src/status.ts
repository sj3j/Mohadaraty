import { db } from './firebase.ts';
import { env } from './env.ts';
import { log } from './log.ts';
import { queueDepths, queueOldestPendingAges } from './queue.ts';
import { getConfigError } from './config.ts';
import { holdsLease, leaseGeneration, leaseHealth } from './state.ts';
import { statusWriteAllowed } from './statusOwnership.ts';

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
export type RuntimePhase = 'starting' | 'polling' | 'backoff' | 'stalled' | 'recovering';
let pollState: RuntimePhase = 'starting';
let inboxMetrics: Record<string, unknown> = {};
let reporting = false;
let bootedAt: string | null = null;

export function updateInboxMetrics(next: Record<string, unknown>): void {
  inboxMetrics = next;
  schedule();
}

export function setPollState(next: typeof pollState): void {
  if (next !== pollState) {
    pollState = next;
    // A state transition is worth reporting immediately rather than waiting
    // out the debounce - it is exactly what someone opening the screen wants.
    if (canWriteStatus()) void flush(true);
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
let heartbeatTimer: NodeJS.Timeout | null = null;
let flushInFlight: Promise<void> | null = null;

export function canWriteStatus(): boolean {
  return statusWriteAllowed(reporting, holdsLease(), leaseGeneration());
}

function schedule(): void {
  if (!canWriteStatus()) return;
  if (timer) return;
  const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastWriteAt));
  timer = setTimeout(() => { timer = null; void flush(); }, wait);
  timer.unref();
}

async function flush(immediate = false): Promise<void> {
  if (!canWriteStatus()) return;
  if (!immediate && Date.now() - lastWriteAt < MIN_INTERVAL_MS) return schedule();
  if (flushInFlight) return;
  lastWriteAt = Date.now();

  const activeGeneration = leaseGeneration();
  flushInFlight = (async () => {
    try {
      await db.collection('admin_config').doc('telegram_status').set({
      instanceId: env.instanceId,
      version: env.version,
      bootedAt,
      transport: env.firestoreTransport,
      generation: activeGeneration,
      runtimePhase: pollState,
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
      }, { merge: false });
    } catch (error) {
      log.warn('status.write_failed', {
        generation: activeGeneration,
        transport: env.firestoreTransport,
        err: String(error),
      });
    }
  })();

  try {
    await flushInFlight;
  } finally {
    flushInFlight = null;
  }
}

function clearRecord(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) delete record[key];
}

/** Starts the single lease owner's complete, non-merge status heartbeat. */
export async function startStatusReporting(): Promise<void> {
  reporting = true;
  bootedAt = new Date().toISOString();
  pollState = 'starting';
  clearRecord(channels as Record<string, unknown>);
  clearRecord(counters as Record<string, unknown>);
  inboxMetrics = {};
  lastWriteAt = 0;
  if (timer) clearTimeout(timer);
  timer = null;
  if (heartbeatTimer) clearInterval(heartbeatTimer);

  await flush(true);
  heartbeatTimer = setInterval(() => { void flush(true); }, MIN_INTERVAL_MS);
  heartbeatTimer.unref();
}

/** Prevents a stale or recovering generation from refreshing global status. */
export async function stopStatusReporting(): Promise<void> {
  reporting = false;
  if (timer) clearTimeout(timer);
  timer = null;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  await flushInFlight;
}

export const snapshot = () => ({
  pollState,
  runtimePhase: pollState,
  transport: env.firestoreTransport,
  generation: leaseGeneration(),
  channels,
  counters,
  queueDepth: queueDepths(),
  queueOldestPendingAgeMs: queueOldestPendingAges(),
  inbox: inboxMetrics,
  lease: leaseHealth(),
});
