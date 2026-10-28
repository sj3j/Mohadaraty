import { log, errFields } from './log.ts';
import { telegram } from './telegram/api.ts';
import { loadOffset, holdsLease } from './state.ts';
import { persistInboundBatch, runInboxWorker } from './inbox.ts';
import { durablyReceiveBatch } from './reliabilityCore.ts';
import { setPollState } from './status.ts';

/**
 * Receipt and processing are deliberately independent:
 *
 * Telegram -> atomic durable inbox + checkpoint -> next getUpdates ack
 * Durable inbox -> idempotent processor/retries -> completed/dead-letter
 */

let running = false;
let pollAbort: AbortController | null = null;
let lastSuccessfulPollAt = Date.now();
let lastReceivedAt = 0;
export const lastPollAt = (): number => lastSuccessfulPollAt;
export const lastReceiptAt = (): number | null => lastReceivedAt || null;
export const isPolling = (): boolean => running;

async function receiveLoop(): Promise<void> {
  let offset = await loadOffset();
  let backoffMs = 1_000;

  while (running && holdsLease()) {
    try {
      const updates = await telegram.getUpdates(offset, 50, pollAbort?.signal);
      lastSuccessfulPollAt = Date.now();
      backoffMs = 1_000;
      setPollState('polling');

      if (updates.length === 0) continue;
      for (const update of updates) {
        const message = update.channel_post ?? update.edited_channel_post;
        log.info('telegram.update.received', {
          updateId: update.update_id,
          chatId: message?.chat.id ?? update.my_chat_member?.chat.id,
          messageId: message?.message_id,
          mediaGroupId: message?.media_group_id,
        });
      }

      const checkpoint = await durablyReceiveBatch(updates, persistInboundBatch);
      if (checkpoint !== null) {
        offset = checkpoint;
        lastReceivedAt = Date.now();
      }
    } catch (error) {
      if (!running || !holdsLease()) break;
      setPollState('backoff');
      log.warn('poll.error', { backoffMs, ...errFields(error) });
      const jitter = Math.random() * 0.3 * backoffMs;
      await new Promise(resolve => setTimeout(resolve, backoffMs + jitter));
      backoffMs = Math.min(60_000, backoffMs * 2);
      if (Date.now() - lastSuccessfulPollAt > 5 * 60_000) setPollState('stalled');
    }
  }

  if (!holdsLease()) log.error('poll.stopping_no_lease', {});
}

export async function startPolling(): Promise<void> {
  if (running) throw new Error('Telegram polling is already running');
  running = true;
  pollAbort = new AbortController();
  try {
    await Promise.all([
      receiveLoop(),
      runInboxWorker(() => running && holdsLease()),
    ]);
  } finally {
    running = false;
    pollAbort = null;
  }
}

export async function stopPolling(): Promise<void> {
  running = false;
  pollAbort?.abort(new Error('Telegram polling stopped'));
}
