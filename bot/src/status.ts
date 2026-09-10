import { db, FieldValue } from './firebase.ts';
import { env } from './env.ts';
import { log } from './log.ts';
import { queueDepths } from './queue.ts';
import { getConfigError } from './config.ts';

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
  channels[stageId] = {
    ...previous,
    ...patch,
    ...(patch.lastError ? { lastErrorAt: new Date().toISOString() } : {}),
  };
  if (patch.state && patch.state !== previous.state) void flush(true);
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

export const snapshot = () => ({ pollState, channels, counters, queueDepth: queueDepths() });
