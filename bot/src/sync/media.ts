import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { bucket } from '../firebase.ts';
import { env } from '../env.ts';
import { log, errFields } from '../log.ts';
import { telegram, TG_LIMITS } from '../telegram/api.ts';
import type { TgFileLike, TgMessage, TgPhotoSize } from '../telegram/types.ts';
import type { Attachment, AttachmentKind } from '../../../src/types/announcement.types.ts';

/**
 * Files, in both directions.
 *
 * The single most important detail in this file is the download TOKEN on the
 * uploaded object. The Cloud Function this bot replaces built its public URL by
 * hand as `.../o/{name}?alt=media` with no token, and AttachmentGrid renders
 * `<img src={url}>` with no credentials - so every image that function ever
 * ingested was un-viewable in the app. Minting a token here produces exactly
 * the URL shape getDownloadURL() returns, which makes a bot attachment and a
 * composer attachment indistinguishable to the reader.
 */

/** Firebase Storage rejects most non-ASCII object names. Matches Composer's
 *  safeName exactly; the human-readable name is kept on the attachment record. */
const safeName = (name: string) => name.replace(/[^a-zA-Z0-9.\-_]/g, '_');

export const humanSize = (bytes: number): string => {
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

export interface TelegramFileRef {
  fileId: string;
  fileUniqueId: string;
  kind: AttachmentKind;
  name: string;
  size: number;
  mime: string;
}

/**
 * What a Telegram message carries, normalised.
 *
 * Order matters: `document` is checked for an image/video mime because a photo
 * sent "as file" arrives as a document, and treating it as a generic download
 * would lose the inline preview a reader expects.
 */
export function filesInMessage(message: TgMessage): TelegramFileRef[] {
  const out: TelegramFileRef[] = [];

  if (message.photo?.length) {
    // Telegram sends every rendition; the last is the largest.
    const largest = message.photo[message.photo.length - 1] as TgPhotoSize;
    out.push({
      fileId: largest.file_id,
      fileUniqueId: largest.file_unique_id,
      kind: 'image',
      // Telegram supplies no filename for photos.
      name: `photo_${largest.file_unique_id}.jpg`,
      size: largest.file_size ?? 0,
      mime: 'image/jpeg',
    });
  }

  const asFile = (file: TgFileLike, kind: AttachmentKind, fallbackExt: string): TelegramFileRef => ({
    fileId: file.file_id,
    fileUniqueId: file.file_unique_id,
    kind,
    name: file.file_name || `${kind}_${file.file_unique_id}.${fallbackExt}`,
    size: file.file_size ?? 0,
    mime: file.mime_type || 'application/octet-stream',
  });

  if (message.video) out.push(asFile(message.video, 'video', 'mp4'));
  // An animation is an mp4, and AttachmentGrid gives videos a full-width row,
  // which is the right treatment for a GIF.
  if (message.animation) out.push(asFile(message.animation, 'video', 'mp4'));
  if (message.audio) out.push(asFile(message.audio, 'file', 'mp3'));
  if (message.voice) out.push(asFile(message.voice, 'file', 'ogg'));
  if (message.video_note) out.push(asFile(message.video_note, 'file', 'mp4'));

  if (message.document) {
    const mime = message.document.mime_type ?? '';
    const kind: AttachmentKind = mime.startsWith('image/') ? 'image'
      : mime.startsWith('video/') ? 'video'
      : 'file';
    out.push(asFile(message.document, kind, 'bin'));
  }

  // Stickers are deliberately absent: a .webp renders badly as an image and a
  // .tgs is a Lottie archive the app has no player for.

  return out;
}

export interface DownloadResult {
  attachment?: Attachment;
  oversize?: { name: string; size: number };
}

/**
 * Telegram -> Firebase Storage.
 *
 * Streams rather than buffering. The function this replaces read the whole file
 * into an arraybuffer, which is survivable once and an OOM when five stages
 * post albums at the same time against a 512MB container.
 */
export async function ingestTelegramFile(file: TelegramFileRef, stageId: string): Promise<DownloadResult> {
  // Checked from the MESSAGE, before calling getFile: getFile itself fails with
  // "file is too big" past 20MB, so asking first turns a hard error into a
  // graceful skip that keeps the rest of the post.
  if (file.size > TG_LIMITS.downloadBytes) {
    log.info('file.oversize', { name: file.name, size: file.size, limit: TG_LIMITS.downloadBytes });
    return { oversize: { name: file.name, size: file.size } };
  }

  const meta = await telegram.getFile(file.fileId);
  if (!meta.file_path) throw new Error(`getFile returned no file_path for ${file.fileUniqueId}`);

  const response = await fetch(telegram.fileUrl(meta.file_path));
  if (!response.ok || !response.body) {
    throw new Error(`file download failed: ${response.status} ${response.statusText}`);
  }

  // Stage-scoped, matching Composer exactly - storage.rules scopes writes to
  // announcements/{stageId}/{fileName} and the flat prefix is `write: if false`.
  const path = `announcements/${stageId}/${Date.now()}_${safeName(file.name)}`;
  const token = randomUUID();
  const target = bucket.file(path);

  await pipeline(
    Readable.fromWeb(response.body as any),
    target.createWriteStream({
      resumable: false,
      metadata: {
        contentType: file.mime,
        // Without this the URL below 403s for the unauthenticated <img> tag in
        // AttachmentGrid. This is the exact shape getDownloadURL() produces.
        metadata: { firebaseStorageDownloadTokens: token },
      },
    }),
  );

  const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
  log.info('storage.uploaded', { path, bytes: file.size, kind: file.kind });

  return {
    attachment: {
      id: `tg_${file.fileUniqueId}`,
      kind: file.kind,
      url,
      name: file.name,
      size: file.size,
      mime: file.mime,
      path,
    },
  };
}

/**
 * Whether Telegram can fetch this attachment from its URL itself.
 *
 * Passing a URL costs the container zero egress, so it is always preferred. The
 * ceilings are Telegram's: 5MB for a photo it must decode, 20MB otherwise.
 */
export function canSendByUrl(attachment: Attachment): boolean {
  const limit = attachment.kind === 'image' ? TG_LIMITS.urlPhotoBytes : TG_LIMITS.urlFileBytes;
  return attachment.size > 0 && attachment.size <= limit;
}

export function isSendable(attachment: Attachment): boolean {
  return attachment.size <= TG_LIMITS.uploadBytes;
}

/** Reads an attachment's bytes for a multipart upload. Prefers the Storage path
 *  and falls back to the URL, because attachments written before `path` existed
 *  do not carry one. */
export async function readAttachmentBytes(attachment: Attachment): Promise<Buffer> {
  if (attachment.path) {
    try {
      const [buffer] = await bucket.file(attachment.path).download();
      return buffer;
    } catch (error) {
      log.warn('storage.read_failed_falling_back', { path: attachment.path, ...errFields(error) });
    }
  }
  const response = await fetch(attachment.url);
  if (!response.ok) throw new Error(`attachment fetch failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Best-effort cleanup for objects an announcement no longer references. */
export async function deleteStorageObjects(paths: (string | undefined)[]): Promise<void> {
  for (const path of paths) {
    if (!path) continue;
    try {
      await bucket.file(path).delete();
    } catch (error: any) {
      if (error?.code !== 404) log.warn('storage.delete_failed', { path, ...errFields(error) });
    }
  }
}

export const maxAgeMs = env.mirrorMaxAgeMs;
