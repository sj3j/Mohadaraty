import { db, FieldValue } from '../firebase.ts';
import { log, errFields } from '../log.ts';
import { blocksToPlainText, safeUrl } from '../../../src/lib/richText.ts';
import type { Attachment, RichBlock } from '../../../src/types/announcement.types.ts';
import { telegramAnnouncementId, type TelegramChannel } from '../../../shared/telegramMirror.ts';
import type { TgMessage } from '../telegram/types.ts';
import { tgMessageToBlocks } from './entities.ts';
import { mirrorHash } from './hash.ts';
import { mappingRef, getMapping, wasRecentlySent, type TelegramMapping } from './mapping.ts';
import { filesInMessage, ingestTelegramFile, humanSize } from './media.ts';

/**
 * Telegram -> the announcements feed.
 *
 * Two invariants govern everything here:
 *
 *  1. The announcement document and its mapping document are written in ONE
 *     batch. Writing the announcement first and stamping its hash second means
 *     the outbound watcher observes an unstamped document and immediately posts
 *     it straight back to Telegram. One batch or nothing.
 *
 *  2. An update is never silently dropped. Even a post that produces no
 *     announcement writes a mapping with `announcementId: null`, so a
 *     redelivery after a crash is recognised as already consumed.
 */

export interface IngestContext {
  stageId: string;
  channel: TelegramChannel;
}

/** The body of a message and the entities over it, whichever field carries them. */
function bodyOf(message: TgMessage) {
  const text = message.text ?? message.caption ?? '';
  const entities = message.text ? message.entities : message.caption_entities;
  return { text, entities };
}

/**
 * A note standing in for a file too large to pull through the Bot API.
 *
 * Better than dropping it silently: the reader is told something exists and,
 * for a public channel, given a link straight to it. Never fails the whole
 * announcement over one attachment.
 */
function oversizeBlock(
  skipped: { name: string; size: number }[],
  message: TgMessage,
): RichBlock | null {
  if (!skipped.length) return null;

  const names = skipped.map(f => `${f.name} (${humanSize(f.size)})`).join('، ');
  const text = `📎 ${names} — متاح على قناة تيليجرام`;
  const block: RichBlock = { type: 'p', text };

  // Only a public channel has a resolvable t.me link; a private one has none,
  // and a broken link is worse than no link.
  if (message.chat.username) {
    const url = safeUrl(`https://t.me/${message.chat.username}/${message.message_id}`);
    if (url) block.entities = [{ type: 'link', offset: 0, length: text.length, url }];
  }
  return block;
}

interface BuiltPayload {
  blocks: RichBlock[];
  attachments: Attachment[];
  oversize: { name: string; size: number }[];
  fileUniqueIds: string[];
  linkUrl: string | null;
}

/** Downloads every file in the messages and assembles the announcement body. */
async function buildPayload(messages: TgMessage[], ctx: IngestContext): Promise<BuiltPayload> {
  // The caption of an album rides on whichever item carries one.
  const captionCarrier = messages.find(m => bodyOf(m).text) ?? messages[0];
  const { text, entities } = bodyOf(captionCarrier);

  const attachments: Attachment[] = [];
  const oversize: { name: string; size: number }[] = [];
  const fileUniqueIds: string[] = [];

  for (const message of messages) {
    for (const file of filesInMessage(message)) {
      fileUniqueIds.push(file.fileUniqueId);
      try {
        const result = await ingestTelegramFile(file, ctx.stageId);
        if (result.attachment) attachments.push(result.attachment);
        if (result.oversize) oversize.push(result.oversize);
      } catch (error) {
        log.warn('tg.in.file_failed', { name: file.name, ...errFields(error) });
        oversize.push({ name: file.name, size: file.size });
      }
    }
  }

  const blocks = tgMessageToBlocks(text, entities);
  const note = oversizeBlock(oversize, captionCarrier);
  if (note) blocks.push(note);

  return {
    blocks,
    attachments,
    oversize,
    fileUniqueIds,
    linkUrl: safeUrl(captionCarrier.link_preview_options?.url) ?? null,
  };
}

/**
 * Ingests one channel post, or one whole album.
 *
 * `messages` is either a single message or every member of a media group the
 * poll loop has buffered. Album membership can straddle two getUpdates batches,
 * so this is written to be re-entrant: a second call with more members of the
 * same album appends to the announcement the first call created.
 */
export async function ingestMessages(messages: TgMessage[], ctx: IngestContext): Promise<void> {
  if (!messages.length) return;

  const ordered = [...messages].sort((a, b) => a.message_id - b.message_id);
  const first = ordered[0];
  const chatId = first.chat.id;

  // Guard 1 of 3: this process sent it moments ago. Guard 2 is the mapping
  // lookup below; guard 3 is the per-chat serial queue that orders them.
  if (wasRecentlySent(chatId, first.message_id)) {
    log.debug('tg.in.skipped', { reason: 'echo_of_app_send', chatId, messageId: first.message_id });
    return;
  }

  const existing = await getMapping(chatId, first.message_id);
  if (existing && !isAlbumGrowth(existing, ordered)) {
    log.debug('tg.in.skipped', { reason: 'already_seen', chatId, messageId: first.message_id });
    return;
  }

  // A poll-only post has nothing to mirror: polls are excluded in both
  // directions, since Telegram gives bots no vote data for channel polls.
  const pollOnly = ordered.every(m => m.poll && !bodyOf(m).text && filesInMessage(m).length === 0);
  if (pollOnly) {
    await recordSkip(chatId, ordered, ctx, 'poll_only');
    return;
  }

  const built = await buildPayload(ordered, ctx);
  const plain = blocksToPlainText(built.blocks);

  /*
   * Never create an empty announcement.
   *
   * An empty document still fires sendAnnouncementNotificationV3, which falls
   * through to the generic 'إعلان جديد' and pushes a content-free notification
   * to an entire stage. Recording it as consumed-but-skipped keeps idempotency
   * without that harm - and an edit that later gives it real content promotes
   * it into a real announcement (see applyEdit).
   */
  if (!plain && built.attachments.length === 0) {
    await recordSkip(chatId, ordered, ctx, 'empty');
    return;
  }

  const announcementId = telegramAnnouncementId(chatId, first.message_id);
  const messageIds = ordered.map(m => m.message_id);
  const hash = mirrorHash({
    text: plain,
    richBlocks: built.blocks,
    attachments: built.attachments,
    linkUrl: built.linkUrl,
  });

  const announcement = {
    text: plain,
    // Written alongside `text` because functions/index.js builds the push body
    // from `text || content`.
    content: plain,
    richBlocks: built.blocks,
    attachments: built.attachments,
    embeddedLectures: [],
    linkUrl: built.linkUrl,
    linkTitle: null,
    stageId: ctx.stageId,
    createdBy: 'telegram_bot',
    authorName: ctx.channel.displayName || first.author_signature || first.chat.title || 'Telegram',
    // serverTimestamp, NOT message.date. The feed orders by createdAt and the
    // unread badge compares against a last-read marker, so a late-delivered
    // post carrying its original Telegram time would insert mid-history and
    // silently fail to register as unread.
    createdAt: FieldValue.serverTimestamp(),
    telegramMirror: {
      enabled: true,
      origin: 'telegram',
      chatId,
      messageIds,
      captionMessageId: first.message_id,
      appliedHash: hash,
      tgDate: first.date,
      syncedAt: FieldValue.serverTimestamp(),
      error: built.oversize.length ? 'oversize_skipped' : null,
    },
  };

  const mapping: TelegramMapping = {
    chatId,
    messageIds,
    captionMessageId: first.message_id,
    captionKind: first.text ? 'text' : 'caption',
    mediaGroupId: first.media_group_id ?? null,
    tgFileUniqueIds: built.fileUniqueIds,
    announcementId,
    stageId: ctx.stageId,
    origin: 'telegram',
    appliedFromTelegram: hash,
    appliedFromApp: null,
    oversizeSkipped: built.oversize,
    lastError: null,
  };

  const batch = db.batch();
  batch.set(db.collection('announcements').doc(announcementId), announcement, { merge: true });
  for (const messageId of messageIds) {
    batch.set(
      mappingRef(chatId, messageId),
      { ...mapping, isAlbumMember: messageId !== first.message_id, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  }
  await batch.commit();

  log.info('tg.in.created', {
    chatId, stageId: ctx.stageId, announcementId, messageIds,
    attachments: built.attachments.length, oversize: built.oversize.length,
  });
}

/** True when this call carries album members the stored mapping has not seen. */
function isAlbumGrowth(mapping: TelegramMapping, messages: TgMessage[]): boolean {
  if (!mapping.mediaGroupId) return false;
  return messages.some(m => !mapping.messageIds.includes(m.message_id));
}

/** Records an update as consumed without creating an announcement. */
async function recordSkip(
  chatId: number,
  messages: TgMessage[],
  ctx: IngestContext,
  reason: string,
): Promise<void> {
  const batch = db.batch();
  for (const message of messages) {
    batch.set(mappingRef(chatId, message.message_id), {
      chatId,
      messageIds: messages.map(m => m.message_id),
      captionMessageId: messages[0].message_id,
      captionKind: message.text ? 'text' : 'caption',
      mediaGroupId: message.media_group_id ?? null,
      tgFileUniqueIds: [],
      announcementId: null,
      stageId: ctx.stageId,
      origin: 'telegram',
      appliedFromTelegram: null,
      appliedFromApp: null,
      skipped: reason,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  await batch.commit();
  log.info('tg.in.skipped', { reason, chatId, messageIds: messages.map(m => m.message_id) });
}

/**
 * An edit made inside Telegram.
 *
 * Writes ONLY the fields the edited message actually carries. Telegram edits
 * cannot add media, so rebuilding `attachments` from a text-only edit would
 * wipe every attachment the post has - the single most destructive mistake
 * available on this path.
 */
export async function applyEdit(message: TgMessage, ctx: IngestContext): Promise<void> {
  const chatId = message.chat.id;
  const mapping = await getMapping(chatId, message.message_id);

  if (!mapping) {
    // An edit to something never ingested - most likely posted while the bot
    // was down. Treat it as new so the content is not lost.
    log.info('tg.in.edit_unmapped_ingesting', { chatId, messageId: message.message_id });
    await ingestMessages([message], ctx);
    return;
  }

  // Promotion: a message previously skipped as empty has been given content.
  if (!mapping.announcementId) {
    log.info('tg.in.edit_promoting', { chatId, messageId: message.message_id, was: mapping.skipped });
    await ingestMessages([message], ctx);
    return;
  }

  const { text, entities } = bodyOf(message);
  const blocks = tgMessageToBlocks(text, entities);
  const plain = blocksToPlainText(blocks);

  const snap = await db.collection('announcements').doc(mapping.announcementId).get();
  if (!snap.exists) {
    log.warn('tg.in.edit_target_missing', { announcementId: mapping.announcementId });
    return;
  }
  const current = snap.data()!;

  const hash = mirrorHash({
    text: plain,
    richBlocks: blocks,
    // Unchanged by an edit - carried through so the hash reflects the whole doc.
    attachments: current.attachments ?? [],
    linkUrl: safeUrl(message.link_preview_options?.url) ?? current.linkUrl ?? null,
  });

  // This edit is the echo of the bot's own editMessageText. Stop here.
  if (hash === mapping.appliedFromApp) {
    log.debug('tg.in.skipped', { reason: 'echo_of_app_edit', chatId, messageId: message.message_id });
    return;
  }
  if (hash === mapping.appliedFromTelegram) return;

  const batch = db.batch();
  batch.update(snap.ref, {
    text: plain,
    content: plain,
    richBlocks: blocks,
    linkUrl: safeUrl(message.link_preview_options?.url) ?? null,
    updatedAt: FieldValue.serverTimestamp(),
    'telegramMirror.appliedHash': hash,
    'telegramMirror.tgDate': message.edit_date ?? message.date,
    'telegramMirror.syncedAt': FieldValue.serverTimestamp(),
  });
  batch.update(mappingRef(chatId, message.message_id), {
    appliedFromTelegram: hash,
    updatedAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  log.info('tg.in.edited', { chatId, messageId: message.message_id, announcementId: mapping.announcementId });
}
