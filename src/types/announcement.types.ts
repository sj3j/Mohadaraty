/**
 * The announcement document schema.
 *
 * Formatting is stored the way Telegram stores it: a plain-text string plus a
 * list of ranges that carry marks. NOT html, and not markdown.
 *
 * That choice is load-bearing in three ways:
 *
 *   1. No sanitiser. Rendering slices the string at entity boundaries and emits
 *      React elements, so nothing ever reaches `dangerouslySetInnerHTML`. This
 *      app has no sanitiser dependency and storing HTML from a moderator-authored
 *      field would have been the first XSS surface in it.
 *   2. The push-notification function (functions/index.js) reads `text` and
 *      `content`. Those stay plain strings, so a bold word never leaks a `**`
 *      into a notification body.
 *   3. Offsets are UTF-16 code units, which is exactly what Telegram's
 *      MessageEntity uses - so the phase-2 channel mirror is a field rename
 *      rather than a re-encode.
 *
 * A document with no `richBlocks` renders from `text` as unstyled plain text,
 * which is what every pre-existing post and every bot-authored post looks like.
 */

/** Inline marks. Deliberately closed: every member has a Telegram equivalent
 *  and a one-tag renderer. Lists and blockquote are excluded on purpose - they
 *  would force `RichBlock` from a flat array into a tree. */
export type MarkType = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'link';

export interface RichEntity {
  type: MarkType;
  /** UTF-16 code-unit offset into the owning block's `text`. */
  offset: number;
  /** Length in UTF-16 code units. */
  length: number;
  /** Absolute href. Present only when `type === 'link'`. */
  url?: string;
}

/** One block of the document. `h` is the single heading level - "headline". */
export interface RichBlock {
  type: 'p' | 'h';
  text: string;
  entities?: RichEntity[];
}

export type AttachmentKind = 'image' | 'video' | 'file';

export interface Attachment {
  id: string;
  kind: AttachmentKind;
  /** Firebase Storage download URL. */
  url: string;
  /** The original filename, shown to the reader and used for downloads. */
  name: string;
  size: number;
  mime: string;
  /** Storage object path, kept so a deleted post can clean up after itself. */
  path?: string;
}

export interface PollOption {
  id: string;
  text: string;
}

/**
 * A poll rides along on a post rather than being its own post type - one
 * announcement can carry text, images and a poll together.
 *
 * `counts` and `totalVoters` are written ONLY by the tallyPollVotes Cloud
 * Function. Students have no write access to the announcement document at all,
 * which is why the `hasOnly(['reactions'])` escape hatch in firestore.rules did
 * not have to be widened for polls.
 */
export interface Poll {
  question: string;
  options: PollOption[];
  allowsMultiple: boolean;
  /** optionId -> vote count. Server-maintained. */
  counts: Record<string, number>;
  /** Distinct voters, which is not the sum of `counts` in a multi-select poll. */
  totalVoters: number;
}

/** One document in `announcements/{id}/votes/{uid}`. Readable by its owner and
 *  by staff only - that subcollection boundary is what makes a poll anonymous
 *  to other students while leaving the aggregate public. */
export interface PollVote {
  optionIds: string[];
  votedAt: unknown;
}

export interface Announcement {
  id: string;
  /** Plain text of the whole document, blocks joined by newline. Always written:
   *  the FCM function and the unread badge both read it. */
  text: string;
  /** Legacy duplicate of `text`. Written for the notification function, which
   *  reads `text || content`. */
  content?: string;
  richBlocks?: RichBlock[];
  attachments?: Attachment[];
  poll?: Poll;
  embeddedLectures?: string[];
  linkUrl?: string | null;
  linkTitle?: string | null;
  reactions?: Record<string, string[]>;
  authorName?: string;
  createdBy?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
  stageId?: string;
}

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_POLL_OPTIONS = 10;
export const MIN_POLL_OPTIONS = 2;
