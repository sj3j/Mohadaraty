import { log, errFields } from './log.ts';
import { telegram } from './telegram/api.ts';
import type { TgMessage, TgUpdate } from './telegram/types.ts';
import { getConfig, stageForChat } from './config.ts';
import { queueFor } from './queue.ts';
import { loadOffset, saveOffset, holdsLease } from './state.ts';
import { ingestMessages, applyEdit } from './sync/inbound.ts';
import { noteInbound, setPollState } from './status.ts';

/**
 * The getUpdates long-poll loop.
 *
 * The rule that makes crash-safety work:
 *
 *   Process updates strictly in order, await each to durable completion, flush
 *   every open media group, and only THEN persist offset = max(update_id) + 1.
 *   Never persist optimistically.
 *
 * Telegram redelivers an update until a higher offset acknowledges it, so this
 * gives at-least-once delivery. Idempotency comes from the writes themselves -
 * deterministic announcement ids and hash-gated updates - not from the offset.
 */

/** Telegram gives no "album complete" signal, so members are gathered until a
 *  quiet period. 600ms is comfortably longer than the inter-item gap and short
 *  enough that a single post is not noticeably delayed. */
const ALBUM_DEBOUNCE_MS = 600;

interface OpenAlbum {
  messages: TgMessage[];
  timer: NodeJS.Timeout;
  chatId: number;
  stageId: string;
}

const openAlbums = new Map<string, OpenAlbum>();

let running = false;
let lastSuccessfulPollAt = Date.now();
export const lastPollAt = () => lastSuccessfulPollAt;

async function flushAlbum(key: string): Promise<void> {
  const album = openAlbums.get(key);
  if (!album) return;
  clearTimeout(album.timer);
  openAlbums.delete(key);

  const channel = getConfig().channels[album.stageId as never];
  if (!channel) return;

  await queueFor(album.chatId).push('album', async () => {
    await ingestMessages(album.messages, { stageId: album.stageId, channel });
    noteInbound(album.stageId);
  });
}

/** Every open album, flushed. Called before the offset advances, so a crash
 *  inside a debounce window loses nothing - Telegram simply redelivers. */
async function flushAllAlbums(): Promise<void> {
  await Promise.all([...openAlbums.keys()].map(flushAlbum));
}

async function handleMessage(message: TgMessage, isEdit: boolean): Promise<void> {
  const chatId = message.chat.id;
  const stageId = stageForChat(chatId);

  if (!stageId) {
    // Dropped, but the offset still advances: the update was seen and decided
    // upon. Not advancing would wedge the loop forever on a channel that was
    // removed from the configuration.
    log.debug('tg.in.skipped', { reason: 'unmapped_chat', chatId });
    return;
  }

  const channel = getConfig().channels[stageId];
  if (!channel) return;

  if (isEdit) {
    await queueFor(chatId).push('edit', async () => {
      await applyEdit(message, { stageId, channel });
      noteInbound(stageId);
    });
    return;
  }

  if (message.media_group_id) {
    const key = `${chatId}:${message.media_group_id}`;
    const existing = openAlbums.get(key);

    if (existing) {
      clearTimeout(existing.timer);
      existing.messages.push(message);
      existing.timer = setTimeout(() => void flushAlbum(key), ALBUM_DEBOUNCE_MS);
    } else {
      openAlbums.set(key, {
        messages: [message],
        chatId,
        stageId,
        timer: setTimeout(() => void flushAlbum(key), ALBUM_DEBOUNCE_MS),
      });
    }
    return;
  }

  await queueFor(chatId).push('post', async () => {
    await ingestMessages([message], { stageId, channel });
    noteInbound(stageId);
  });
}

async function applyUpdate(update: TgUpdate): Promise<void> {
  if (update.channel_post) return handleMessage(update.channel_post, false);
  if (update.edited_channel_post) return handleMessage(update.edited_channel_post, true);

  if (update.my_chat_member) {
    // The bot's own membership changed. Logged rather than acted on: the
    // periodic access check reports it to the admin UI, and reacting here
    // would race with a config edit already in flight.
    log.warn('tg.membership_changed', {
      chatId: update.my_chat_member.chat.id,
      status: update.my_chat_member.new_chat_member?.status,
    });
  }
}

export async function startPolling(): Promise<void> {
  running = true;
  let offset = await loadOffset();
  let backoffMs = 1000;

  while (running) {
    if (!holdsLease()) {
      log.error('poll.stopping_no_lease', {});
      return;
    }

    try {
      const updates = await telegram.getUpdates(offset);
      lastSuccessfulPollAt = Date.now();
      backoffMs = 1000;
      setPollState('polling');

      if (updates.length === 0) {
        // An idle long-poll changes nothing, so it writes nothing. This is what
        // keeps the Firestore cost of an idle bot at literally zero.
        continue;
      }

      for (const update of updates) {
        try {
          await applyUpdate(update);
        } catch (error) {
          // A single poisoned update must not stall the stream forever. It is
          // logged and acknowledged; the mapping documents mean a genuine retry
          // would be a no-op anyway.
          log.error('poll.update_failed', { updateId: update.update_id, ...errFields(error) });
        }
      }

      await flushAllAlbums();

      const highest = Math.max(...updates.map(u => u.update_id));
      offset = highest + 1;
      await saveOffset(offset);

      log.info('poll.batch', { count: updates.length, maxUpdateId: highest });
    } catch (error) {
      setPollState('backoff');
      log.warn('poll.error', { backoffMs, ...errFields(error) });
      // Jittered so a restarting fleet does not synchronise its retries.
      const jitter = Math.random() * 0.3 * backoffMs;
      await new Promise(resolve => setTimeout(resolve, backoffMs + jitter));
      backoffMs = Math.min(60_000, backoffMs * 2);
      if (Date.now() - lastSuccessfulPollAt > 5 * 60_000) setPollState('stalled');
    }
  }
}

export async function stopPolling(): Promise<void> {
  running = false;
  await flushAllAlbums();
}
