/**
 * The subset of the Telegram Bot API this bot actually consumes.
 *
 * Deliberately partial. A full typing of Update would be mostly dead surface,
 * and every field named here is one the sync logic reads - so the type doubles
 * as documentation of what the mirror does and does not understand.
 */

/**
 * Telegram's own hard limits.
 *
 * Not configuration - these are the API's, and a deployment cannot change them.
 * They live here rather than in the client so that the pure codec in
 * sync/entities.ts can reach them without dragging in env and credentials.
 */
export const TG_LIMITS = {
  /** getFile refuses anything larger. The cap is on DOWNLOAD only. */
  downloadBytes: 20 * 1024 * 1024,
  /** Multipart upload ceiling. */
  uploadBytes: 50 * 1024 * 1024,
  /** Telegram fetching a photo by URL itself. */
  urlPhotoBytes: 5 * 1024 * 1024,
  /** Telegram fetching any other file by URL itself. */
  urlFileBytes: 20 * 1024 * 1024,
  textChars: 4096,
  captionChars: 1024,
  mediaGroupItems: 10,
} as const;

export interface TgUser {
  id: number;
  is_bot: boolean;
  username?: string;
}

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}

/**
 * Telegram's inline formatting.
 *
 * `offset` and `length` are UTF-16 code units - the same unit RichEntity uses,
 * which is why sync/entities.ts is a rename rather than a re-encode.
 */
export interface TgMessageEntity {
  type:
    | 'bold' | 'italic' | 'underline' | 'strikethrough' | 'code' | 'pre'
    | 'text_link' | 'url' | 'spoiler' | 'blockquote' | 'expandable_blockquote'
    | 'mention' | 'hashtag' | 'cashtag' | 'bot_command' | 'email'
    | 'phone_number' | 'text_mention' | 'custom_emoji';
  offset: number;
  length: number;
  url?: string;
  user?: TgUser;
  language?: string;
  custom_emoji_id?: string;
}

export interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgFileLike {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
  duration?: number;
  width?: number;
  height?: number;
}

export interface TgLinkPreviewOptions {
  is_disabled?: boolean;
  url?: string;
  prefer_large_media?: boolean;
}

export interface TgMessage {
  message_id: number;
  date: number;
  edit_date?: number;
  chat: TgChat;
  /** Absent on channel posts - a channel post is attributed to the channel,
   *  which is precisely why the bot cannot recognise its own posts this way. */
  from?: TgUser;
  author_signature?: string;
  media_group_id?: string;
  text?: string;
  caption?: string;
  entities?: TgMessageEntity[];
  caption_entities?: TgMessageEntity[];
  link_preview_options?: TgLinkPreviewOptions;
  photo?: TgPhotoSize[];
  video?: TgFileLike;
  animation?: TgFileLike;
  document?: TgFileLike;
  audio?: TgFileLike;
  voice?: TgFileLike;
  video_note?: TgFileLike;
  sticker?: TgFileLike;
  poll?: unknown;
}

export interface TgUpdate {
  update_id: number;
  channel_post?: TgMessage;
  edited_channel_post?: TgMessage;
  my_chat_member?: { chat: TgChat; new_chat_member?: { status: string } };
}

export interface TgFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface TgChatMember {
  status: string;
  can_post_messages?: boolean;
  can_edit_messages?: boolean;
  can_delete_messages?: boolean;
}

/** One item of a sendMediaGroup payload. */
export interface TgInputMedia {
  type: 'photo' | 'video' | 'document';
  /** Either an https URL Telegram fetches itself, or `attach://<name>` for a
   *  multipart part carried in the same request. */
  media: string;
  caption?: string;
  caption_entities?: TgMessageEntity[];
}

/** Thrown for any non-ok Bot API response, so callers can branch on the code. */
export class TelegramApiError extends Error {
  constructor(
    readonly errorCode: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(`Telegram ${errorCode}: ${description}`);
    this.name = 'TelegramApiError';
  }

  /** 429, or a 5xx that is worth trying again. */
  get isRetryable(): boolean {
    return this.errorCode === 429 || this.errorCode >= 500;
  }

  /** The message is gone or too old to touch - stop, never repost. */
  get isGoneOrUneditable(): boolean {
    const d = this.description.toLowerCase();
    return d.includes('message to edit not found')
      || d.includes("message can't be edited")
      || d.includes('message to delete not found')
      || d.includes("message can't be deleted");
  }

  /** Editing to identical content. Telegram calls this an error; we do not. */
  get isNotModified(): boolean {
    return this.description.toLowerCase().includes('message is not modified');
  }

  /** The bot is not in the channel, or lacks the right. A per-stage fault. */
  get isAccessProblem(): boolean {
    const d = this.description.toLowerCase();
    return d.includes('not a member')
      || d.includes('chat not found')
      || d.includes('not enough rights')
      || d.includes('bot was kicked');
  }
}
