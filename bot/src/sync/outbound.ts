import { db, FieldValue } from '../firebase.ts';
import { log, errFields } from '../log.ts';
import { plainTextToBlocks } from '../../../src/lib/richText.ts';
import type { Attachment, RichBlock } from '../../../src/types/announcement.types.ts';
import { telegram, TG_LIMITS } from '../telegram/api.ts';
import { TelegramApiError, type TgInputMedia, type TgMessage } from '../telegram/types.ts';
import { blocksToTgText, splitTgText, type TgText } from './entities.ts';
import { mirrorHash } from './hash.ts';
import {
  mappingRef, getMapping, mappingsForAnnouncement, deleteMappings, rememberSent,
  type TelegramMapping,
} from './mapping.ts';
import { canSendByUrl, isSendable, readAttachmentBytes } from './media.ts';

/**
 * The announcements feed -> Telegram.
 *
 * Everything is sent with explicit `entities` arrays and never with
 * `parse_mode`. That is the single most important decision on this path: a
 * Markdown or HTML string would require escaping every `_`, `*` and `[` in
 * Arabic bodies and student names, and one missed escape is a hard
 * `400 can't parse entities` that silently drops the whole post. Entity arrays
 * need no escaping at all.
 */

export interface OutboundDoc {
  id: string;
  text?: string;
  richBlocks?: RichBlock[];
  attachments?: Attachment[];
  poll?: unknown;
  linkUrl?: string | null;
  telegramMirror?: {
    enabled?: boolean;
    origin?: string;
    chatId?: number | null;
    messageIds?: number[];
    captionMessageId?: number | null;
    appliedHash?: string | null;
  };
}

export const hashOf = (doc: OutboundDoc): string => mirrorHash({
  text: doc.text,
  richBlocks: doc.richBlocks,
  attachments: doc.attachments,
  linkUrl: doc.linkUrl,
});

/** A stable identity for the attachment set, so a media change is detectable. */
const attachmentDigest = (attachments: Attachment[] = []): string =>
  attachments.map(a => `${a.kind}:${a.name}:${a.size}`).join('|');

function bodyOf(doc: OutboundDoc): TgText {
  const blocks = doc.richBlocks?.length
    ? doc.richBlocks
    : plainTextToBlocks(doc.text ?? '');
  return blocksToTgText(blocks);
}

/**
 * Groups attachments the way Telegram will accept them.
 *
 * Photos and videos may share a media group; documents may not mix with them.
 * MAX_ATTACHMENTS is 10 and a group holds 10, so in practice this yields at
 * most one visual group and one document group.
 */
function partition(attachments: Attachment[]): { visual: Attachment[][]; docs: Attachment[][] } {
  const chunk = (items: Attachment[]) => {
    const out: Attachment[][] = [];
    for (let i = 0; i < items.length; i += TG_LIMITS.mediaGroupItems) {
      out.push(items.slice(i, i + TG_LIMITS.mediaGroupItems));
    }
    return out;
  };
  return {
    visual: chunk(attachments.filter(a => a.kind === 'image' || a.kind === 'video').filter(isSendable)),
    docs: chunk(attachments.filter(a => a.kind === 'file').filter(isSendable)),
  };
}

const mediaTypeOf = (attachment: Attachment): TgInputMedia['type'] =>
  attachment.kind === 'image' ? 'photo' : attachment.kind === 'video' ? 'video' : 'document';

/** Sends one group, preferring URL-passing so no bytes flow through the bot. */
async function sendGroup(chatId: number, group: Attachment[], caption?: TgText): Promise<TgMessage[]> {
  if (group.length === 0) return [];

  const byUrl = group.every(canSendByUrl);

  if (group.length === 1) {
    const only = group[0];
    const method = only.kind === 'image' ? 'sendPhoto' : only.kind === 'video' ? 'sendVideo' : 'sendDocument';
    const field = only.kind === 'image' ? 'photo' : only.kind === 'video' ? 'video' : 'document';

    if (byUrl) {
      try {
        const sent = await telegram.sendByUrl(method, {
          chat_id: chatId,
          [field]: only.url,
          ...(caption ? { caption: caption.text, caption_entities: caption.entities } : {}),
        });
        return [sent];
      } catch (error) {
        // A legacy attachment whose URL carries no download token 403s for
        // Telegram. Falling back to bytes we can read ourselves recovers it.
        if (!(error instanceof TelegramApiError) || !isUrlFetchFailure(error)) throw error;
        log.warn('tg.out.url_fetch_failed_retrying_multipart', { name: only.name });
      }
    }

    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) {
      form.append('caption', caption.text);
      form.append('caption_entities', JSON.stringify(caption.entities));
    }
    form.append(field, new Blob([await readAttachmentBytes(only)], { type: only.mime }), only.name);
    const sent = await telegram.sendMultipart(method, form);
    return Array.isArray(sent) ? sent : [sent];
  }

  if (byUrl) {
    const media: TgInputMedia[] = group.map((attachment, index) => ({
      type: mediaTypeOf(attachment),
      media: attachment.url,
      ...(index === 0 && caption
        ? { caption: caption.text, caption_entities: caption.entities }
        : {}),
    }));
    return telegram.sendMediaGroup({ chat_id: chatId, media });
  }

  const form = new FormData();
  form.append('chat_id', String(chatId));
  const media: TgInputMedia[] = [];
  for (const [index, attachment] of group.entries()) {
    const partName = `file${index}`;
    media.push({
      type: mediaTypeOf(attachment),
      media: `attach://${partName}`,
      ...(index === 0 && caption
        ? { caption: caption.text, caption_entities: caption.entities }
        : {}),
    });
    form.append(partName, new Blob([await readAttachmentBytes(attachment)], { type: attachment.mime }), attachment.name);
  }
  form.append('media', JSON.stringify(media));
  const sent = await telegram.sendMultipart('sendMediaGroup', form);
  return Array.isArray(sent) ? sent : [sent];
}

const isUrlFetchFailure = (error: TelegramApiError): boolean => {
  const d = error.description.toLowerCase();
  return d.includes('failed to get http url content')
    || d.includes('wrong file identifier')
    || d.includes('webpage_curl_failed');
};

/** Where the body ended up, so a later edit targets the right message. */
interface SendOutcome {
  messageIds: number[];
  captionMessageId: number | null;
  captionKind: 'text' | 'caption';
}

async function sendAll(chatId: number, doc: OutboundDoc): Promise<SendOutcome> {
  const attachments = (doc.attachments ?? []).filter(isSendable);
  const { visual, docs } = partition(attachments);
  const hasMedia = visual.length > 0 || docs.length > 0;

  const body = bodyOf(doc);
  const linkPreview = doc.linkUrl
    // The preview card carries the link WITHOUT putting the URL in the text,
    // so the round trip back through link_preview_options is exactly clean.
    ? { url: doc.linkUrl, prefer_large_media: true }
    : undefined;

  const messageIds: number[] = [];
  let captionMessageId: number | null = null;
  let captionKind: 'text' | 'caption' = 'text';

  // Caption rides the first media item when it fits; otherwise the body is sent
  // as its own message first. Truncating a body to 1024 to make it fit would
  // lose content, which is worse than an extra message.
  const captionFits = hasMedia && body.text.length > 0 && body.text.length <= TG_LIMITS.captionChars;

  if (body.text.length > 0 && !captionFits) {
    for (const part of splitTgText(body)) {
      const sent = await telegram.sendMessage({
        chat_id: chatId,
        text: part.text,
        entities: part.entities,
        ...(linkPreview ? { link_preview_options: linkPreview } : {}),
      });
      messageIds.push(sent.message_id);
      if (captionMessageId === null) captionMessageId = sent.message_id;
    }
    captionKind = 'text';
  }

  let caption: TgText | undefined = captionFits ? body : undefined;

  for (const group of visual) {
    const sent = await sendGroup(chatId, group, caption);
    for (const message of sent) messageIds.push(message.message_id);
    if (caption && sent.length) {
      captionMessageId = sent[0].message_id;
      captionKind = 'caption';
      caption = undefined;
    }
  }
  for (const group of docs) {
    const sent = await sendGroup(chatId, group, caption);
    for (const message of sent) messageIds.push(message.message_id);
    if (caption && sent.length) {
      captionMessageId = sent[0].message_id;
      captionKind = 'caption';
      caption = undefined;
    }
  }

  return { messageIds, captionMessageId, captionKind };
}

/** Publishes an announcement that has never been mirrored. */
export async function sendAnnouncement(doc: OutboundDoc, chatId: number, stageId: string): Promise<void> {
  const hash = hashOf(doc);

  // A poll-only post has nothing to send. Stamped anyway, or the watcher would
  // retry it on every incoming vote.
  const hasBody = (doc.text ?? '').trim().length > 0 || (doc.richBlocks?.length ?? 0) > 0;
  if (!hasBody && !(doc.attachments?.length)) {
    await db.collection('announcements').doc(doc.id).update({
      'telegramMirror.appliedHash': hash,
      'telegramMirror.error': doc.poll ? 'poll_only_not_mirrored' : 'nothing_to_send',
      'telegramMirror.syncedAt': FieldValue.serverTimestamp(),
    });
    log.info('tg.out.skipped', { reason: doc.poll ? 'poll_only' : 'empty', announcementId: doc.id });
    return;
  }

  const outcome = await sendAll(chatId, doc);
  if (!outcome.messageIds.length) return;

  // Populated synchronously before the queue releases, so the inbound handler
  // cannot see this message before the mapping exists.
  rememberSent(chatId, outcome.messageIds);

  const oversize = (doc.attachments ?? []).filter(a => !isSendable(a));

  const mapping: TelegramMapping = {
    chatId,
    messageIds: outcome.messageIds,
    captionMessageId: outcome.captionMessageId,
    captionKind: outcome.captionKind,
    mediaGroupId: null,
    tgFileUniqueIds: [],
    announcementId: doc.id,
    stageId,
    origin: 'app',
    appliedFromTelegram: null,
    appliedFromApp: hash,
    lastError: oversize.length ? 'oversize_outbound' : null,
  };

  const batch = db.batch();
  for (const messageId of outcome.messageIds) {
    batch.set(mappingRef(chatId, messageId), {
      ...mapping,
      isAlbumMember: messageId !== outcome.messageIds[0],
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  batch.update(db.collection('announcements').doc(doc.id), {
    telegramMirror: {
      enabled: true,
      origin: doc.telegramMirror?.origin ?? 'app',
      chatId,
      messageIds: outcome.messageIds,
      captionMessageId: outcome.captionMessageId,
      appliedHash: hash,
      attachmentDigest: attachmentDigest(doc.attachments),
      syncedAt: FieldValue.serverTimestamp(),
      error: oversize.length ? 'oversize_outbound' : null,
    },
  });
  await batch.commit();

  log.info('tg.out.sent', {
    chatId, stageId, announcementId: doc.id, messageIds: outcome.messageIds,
  });
}

/** Applies an app-side edit to the message already in the channel. */
export async function editAnnouncement(doc: OutboundDoc, chatId: number): Promise<void> {
  const captionMessageId = doc.telegramMirror?.captionMessageId
    ?? doc.telegramMirror?.messageIds?.[0];
  if (!captionMessageId) {
    log.warn('tg.out.edit_no_target', { announcementId: doc.id });
    return;
  }

  const mapping = await getMapping(chatId, captionMessageId);
  const hash = hashOf(doc);
  const body = bodyOf(doc);

  /*
   * A media change is NOT re-sent.
   *
   * Telegram cannot add or remove media from an existing message, so the only
   * way to reflect it would be delete-and-repost - which burns the message id,
   * loses the post's views, reactions and comment thread, and re-notifies every
   * channel subscriber. Surfacing it as an error the admin UI shows is the
   * better trade.
   */
  const digest = attachmentDigest(doc.attachments);
  const previousDigest = (doc.telegramMirror as any)?.attachmentDigest;
  if (previousDigest !== undefined && previousDigest !== digest) {
    await db.collection('announcements').doc(doc.id).update({
      'telegramMirror.appliedHash': hash,
      'telegramMirror.error': 'media_edit_unsupported',
      'telegramMirror.syncedAt': FieldValue.serverTimestamp(),
    });
    log.warn('tg.out.media_edit_unsupported', { announcementId: doc.id, chatId });
    return;
  }

  try {
    if (mapping?.captionKind === 'caption') {
      await telegram.editMessageCaption({
        chat_id: chatId,
        message_id: captionMessageId,
        caption: body.text.slice(0, TG_LIMITS.captionChars),
        caption_entities: body.entities,
      });
    } else {
      const [firstPart] = splitTgText(body);
      await telegram.editMessageText({
        chat_id: chatId,
        message_id: captionMessageId,
        text: firstPart.text,
        entities: firstPart.entities,
        ...(doc.linkUrl ? { link_preview_options: { url: doc.linkUrl, prefer_large_media: true } } : {}),
      });
    }
  } catch (error) {
    if (error instanceof TelegramApiError && error.isNotModified) {
      // Telegram calls an identical edit an error. Stamping the hash is what
      // stops this from retrying on every subsequent event, forever.
      await stamp(doc.id, hash, null);
      return;
    }
    if (error instanceof TelegramApiError && error.isGoneOrUneditable) {
      await stamp(doc.id, hash, 'edit_window_expired');
      log.warn('tg.out.edit_window_expired', { announcementId: doc.id, chatId });
      return;
    }
    throw error;
  }

  const batch = db.batch();
  batch.update(db.collection('announcements').doc(doc.id), {
    'telegramMirror.appliedHash': hash,
    'telegramMirror.attachmentDigest': digest,
    'telegramMirror.error': null,
    'telegramMirror.syncedAt': FieldValue.serverTimestamp(),
  });
  batch.update(mappingRef(chatId, captionMessageId), {
    appliedFromApp: hash,
    updatedAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  log.info('tg.out.edited', { chatId, announcementId: doc.id, messageId: captionMessageId });
}

async function stamp(announcementId: string, hash: string, error: string | null): Promise<void> {
  await db.collection('announcements').doc(announcementId).update({
    'telegramMirror.appliedHash': hash,
    'telegramMirror.error': error,
    'telegramMirror.syncedAt': FieldValue.serverTimestamp(),
  });
}

/**
 * Removes a deleted announcement's messages from the channel.
 *
 * The one direction deletion travels. Telegram's Bot API delivers no deletion
 * events, so a post deleted inside Telegram cannot be removed from the app -
 * that asymmetry is documented in the admin UI rather than papered over.
 */
export async function deleteAnnouncementMessages(
  announcementId: string,
  hint?: { chatId?: number | null; messageIds?: number[] },
): Promise<void> {
  let chatId = hint?.chatId ?? null;
  let messageIds = hint?.messageIds ?? [];

  if (!chatId || !messageIds.length) {
    const mappings = await mappingsForAnnouncement(announcementId);
    if (!mappings.length) return;
    chatId = mappings[0].chatId;
    messageIds = [...new Set(mappings.flatMap(m => m.messageIds))];
  }

  for (const messageId of messageIds) {
    try {
      await telegram.deleteMessage(chatId, messageId);
    } catch (error) {
      // Past 48h, or without can_delete_messages, Telegram refuses. The mapping
      // is cleared regardless: the announcement is gone, and keeping a pointer
      // to it would make a future id collision edit a stranger's message.
      if (error instanceof TelegramApiError && error.isGoneOrUneditable) {
        log.warn('tg.out.delete_refused', { chatId, messageId, description: error.description });
        continue;
      }
      log.warn('tg.out.delete_failed', { chatId, messageId, ...errFields(error) });
    }
  }

  await deleteMappings(chatId, messageIds);
  log.info('tg.out.deleted', { chatId, announcementId, messageIds });
}
