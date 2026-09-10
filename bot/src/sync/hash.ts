import { createHash } from 'node:crypto';
import type { RichBlock, RichEntity } from '../../../src/types/announcement.types.ts';

/**
 * The mirror hash: "is what I am about to send already what is there?"
 *
 * This single function is what stops app -> Telegram -> app -> Telegram cycles,
 * and it is a content hash rather than a `lastWriteBy: 'bot'` flag on purpose.
 * A flag is racy - two edits in flight, or an onSnapshot that coalesces two
 * writes into one event, and it is already stale. A hash is idempotent and
 * self-healing: it survives restarts because it lives in Firestore, and it
 * doubles as reconnect idempotency, because a listener that reconnects and
 * replays 300 documents as `added` finds all 300 hash-equal and sends nothing.
 *
 * WHAT IS EXCLUDED MATTERS MORE THAN WHAT IS INCLUDED. Each omission below is
 * load-bearing; adding any of them back turns an ordinary user action into a
 * storm of Telegram edits.
 */

/** Entities sorted into a canonical order, so two equal sets hash equal. */
function normEntities(entities: RichEntity[] | undefined): unknown[] {
  if (!entities?.length) return [];
  return [...entities]
    .map(e => [e.type, e.offset, e.length, e.url ?? ''])
    .sort((a, b) =>
      (a[1] as number) - (b[1] as number)
      || (a[2] as number) - (b[2] as number)
      || String(a[0]).localeCompare(String(b[0])));
}

function normBlocks(blocks: RichBlock[] | undefined): unknown[] {
  if (!blocks?.length) return [];
  return blocks.map(b => [b.type, b.text, normEntities(b.entities)]);
}

export interface HashableAnnouncement {
  text?: string;
  richBlocks?: RichBlock[];
  attachments?: { kind: string; name: string; size: number }[];
  linkUrl?: string | null;
}

export function mirrorHash(announcement: HashableAnnouncement): string {
  const canonical = {
    text: announcement.text ?? '',
    richBlocks: normBlocks(announcement.richBlocks),
    // Identity by (kind, name, size), never by url or id:
    //
    //   url  - differs per side by construction. A Telegram photo pulled in
    //          gets a fresh Storage download URL; an app image sent out gets a
    //          fresh Telegram file_id. Including it makes every mirrored post
    //          permanently hash-unequal, so it would edit forever.
    //   id   - minted from Date.now() at upload, so it differs on every retry.
    attachments: (announcement.attachments ?? []).map(a => [a.kind, a.name, a.size]),
    linkUrl: announcement.linkUrl ?? null,
  };

  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32);
}

/*
 * Deliberately NOT part of the hash:
 *
 *   reactions   - a student tapping an emoji does
 *                 updateDoc({'reactions.X': arrayUnion(uid)}), which fires a
 *                 `modified` event. Excluded, so a reaction storm on a popular
 *                 announcement costs ZERO Telegram calls.
 *
 *   poll        - tallyPollVotes rewrites poll.counts on EVERY ballot. Included,
 *                 a class poll would emit one editMessageText per vote and hit
 *                 429 within minutes. Polls are not mirrored at all, so their
 *                 content is irrelevant to what is in the channel anyway.
 *
 *   linkTitle   - app-only presentation; Telegram renders its own preview card.
 *
 *   embeddedLectures - never crosses to Telegram (see outbound.ts).
 *
 *   telegramMirror   - the bot's own write-back. Including it would mean the
 *                 bot's confirmation write changed the hash and re-triggered
 *                 the bot: a self-sustaining loop with no external input.
 *
 *   createdAt / updatedAt / authorName / createdBy / stageId - metadata that
 *                 says nothing about what a reader sees.
 */
