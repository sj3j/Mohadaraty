import { db, FieldValue } from '../firebase.ts';
import { telegramMessageKey } from '../../../shared/telegramMirror.ts';

/**
 * `telegramMessages/{chatIdKey}_{messageId}` - the durable link between one
 * Telegram message and one announcement.
 *
 * Keyed by the TELEGRAM coordinate rather than the announcement id, because the
 * inbound leg asks "have I already seen this message?" on every single update,
 * and that has to be one O(1) get. The reverse direction is answered by
 * `telegramMirror` on the announcement itself, so neither leg ever has to scan.
 *
 * Album members past the first each get their own document carrying the same
 * announcementId. That is what lets a caption edit on item 3 of an album find
 * its parent, and what makes redelivery of item 3 a no-op.
 */

export const MAPPINGS = 'telegramMessages';

export interface TelegramMapping {
  chatId: number;
  /** Every Telegram message this announcement occupies, in send order. */
  messageIds: number[];
  /** The message that carries the body - the one an edit must target. */
  captionMessageId: number | null;
  /**
   * Whether the body lives in `text` or in a media `caption`.
   *
   * Stored rather than re-derived: it decides editMessageText vs
   * editMessageCaption, and getting it wrong is a hard 400 every time.
   */
  captionKind: 'text' | 'caption';
  mediaGroupId: string | null;
  /** Telegram's stable per-file identity. The album dedupe key, and bot-owned:
   *  it lives here rather than on the attachment so that a composer edit which
   *  rewrites `attachments` cannot break album aggregation. */
  tgFileUniqueIds: string[];
  /** null means "seen and deliberately skipped" - see inbound.ts. */
  announcementId: string | null;
  stageId: string;
  origin: 'telegram' | 'app';
  /** Last hash the bot wrote INTO Firestore from this message. */
  appliedFromTelegram: string | null;
  /** Last hash the bot wrote INTO Telegram from the announcement. */
  appliedFromApp: string | null;
  isAlbumMember?: boolean;
  skipped?: string | null;
  oversizeSkipped?: { name: string; size: number }[];
  lastError?: string | null;
  updatedAt?: unknown;
}

const ref = (chatId: number, messageId: number) =>
  db.collection(MAPPINGS).doc(telegramMessageKey(chatId, messageId));

export async function getMapping(chatId: number, messageId: number): Promise<TelegramMapping | null> {
  const snap = await ref(chatId, messageId).get();
  return snap.exists ? (snap.data() as TelegramMapping) : null;
}

export function mappingRef(chatId: number, messageId: number) {
  return ref(chatId, messageId);
}

export function mappingPatch(patch: Partial<TelegramMapping>): Record<string, unknown> {
  return { ...patch, updatedAt: FieldValue.serverTimestamp() };
}

/**
 * Every mapping for one announcement.
 *
 * Only used on the delete path, where the announcement document is already gone
 * and its `telegramMirror.messageIds` may not have been readable. Uses the
 * automatic single-field index on announcementId; no composite index needed.
 */
export async function mappingsForAnnouncement(announcementId: string): Promise<TelegramMapping[]> {
  const snap = await db.collection(MAPPINGS).where('announcementId', '==', announcementId).get();
  return snap.docs.map(d => d.data() as TelegramMapping);
}

export async function deleteMappings(chatId: number, messageIds: number[]): Promise<void> {
  if (!messageIds.length) return;
  const batch = db.batch();
  for (const messageId of messageIds) batch.delete(ref(chatId, messageId));
  await batch.commit();
}

/**
 * In-memory record of message ids this process just sent.
 *
 * The FIRST of three guards against ingesting the bot's own outbound post as if
 * a human had written it in the channel. Populated synchronously from the send
 * response, before the queue releases, so the inbound handler cannot observe
 * the gap. The mapping document is the second guard and the durable one; the
 * per-chat serial queue is the third and the structural one.
 */
const recentlySent = new Map<string, number>();
const RECENT_TTL_MS = 5 * 60 * 1000;

export function rememberSent(chatId: number, messageIds: number[]): void {
  const now = Date.now();
  for (const messageId of messageIds) {
    recentlySent.set(telegramMessageKey(chatId, messageId), now);
  }
  for (const [key, at] of recentlySent) {
    if (now - at > RECENT_TTL_MS) recentlySent.delete(key);
  }
}

export function wasRecentlySent(chatId: number, messageId: number): boolean {
  const at = recentlySent.get(telegramMessageKey(chatId, messageId));
  return at !== undefined && Date.now() - at < RECENT_TTL_MS;
}
