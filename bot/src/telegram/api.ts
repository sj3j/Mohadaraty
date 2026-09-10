import { env } from '../env.ts';
import { log, errFields } from '../log.ts';
import {
  TelegramApiError, TG_LIMITS,
  type TgChat, type TgChatMember, type TgFile, type TgInputMedia,
  type TgMessage, type TgMessageEntity, type TgUpdate,
} from './types.ts';

// Re-exported so callers keep importing limits from the client they use.
export { TG_LIMITS };

/**
 * The Bot API client.
 *
 * Hand-rolled on fetch rather than Telegraf, which IS already a dependency of
 * the repo. Telegraf owns the polling loop, its own offset bookkeeping and its
 * own dispatch, and this bot needs explicit control of exactly those three:
 * the offset may only advance after a durable write, updates for one chat must
 * run on the same serial queue as that chat's outbound sends, and media groups
 * have to be flushed inside the commit boundary. Fighting `bot.launch()` for
 * all of that is more code than this file.
 */

const BASE = `https://api.telegram.org/bot${env.telegramBotToken}`;
const FILE_BASE = `https://api.telegram.org/file/bot${env.telegramBotToken}`;

async function parseResponse<T>(response: Response, method: string): Promise<T> {
  const body = await response.json().catch(() => ({})) as {
    ok?: boolean;
    result?: unknown;
    error_code?: number;
    description?: string;
    parameters?: { retry_after?: number };
  };

  if (!body?.ok) {
    const code = body?.error_code ?? response.status;
    const description = body?.description ?? response.statusText ?? 'unknown';
    throw new TelegramApiError(code, description, body?.parameters?.retry_after);
  }
  log.debug('tg.call', { method });
  return body.result as T;
}

/**
 * One Bot API call, with 429 handled by honouring `retry_after` exactly.
 *
 * Deliberately does NOT stack exponential backoff on top of retry_after:
 * Telegram is telling us precisely when it will accept the call again, and
 * waiting longer than that just slows the mirror down for no benefit.
 */
async function call<T>(method: string, payload?: unknown, attempt = 0): Promise<T> {
  try {
    const response = await fetch(`${BASE}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    });
    return await parseResponse<T>(response, method);
  } catch (error) {
    if (error instanceof TelegramApiError && error.isRetryable && attempt < 5) {
      const waitMs = error.retryAfter != null
        ? error.retryAfter * 1000
        : Math.min(30_000, 2 ** attempt * 1000);
      log.warn('tg.rate_limited', { method, retryAfter: error.retryAfter, waitMs, attempt });
      await new Promise(resolve => setTimeout(resolve, waitMs));
      return call<T>(method, payload, attempt + 1);
    }
    throw error;
  }
}

/** Multipart variant, for bytes Telegram cannot fetch by URL. */
async function callMultipart<T>(method: string, form: FormData, attempt = 0): Promise<T> {
  try {
    const response = await fetch(`${BASE}/${method}`, { method: 'POST', body: form });
    return await parseResponse<T>(response, method);
  } catch (error) {
    if (error instanceof TelegramApiError && error.isRetryable && attempt < 3) {
      const waitMs = error.retryAfter != null ? error.retryAfter * 1000 : 2 ** attempt * 1000;
      log.warn('tg.rate_limited', { method, waitMs, attempt });
      await new Promise(resolve => setTimeout(resolve, waitMs));
      return callMultipart<T>(method, form, attempt + 1);
    }
    throw error;
  }
}

export const telegram = {
  getMe: () => call<{ id: number; username?: string }>('getMe'),

  getChat: (chat_id: number) => call<TgChat>('getChat', { chat_id }),

  getChatMember: (chat_id: number, user_id: number) =>
    call<TgChatMember>('getChatMember', { chat_id, user_id }),

  /**
   * Long-poll for updates.
   *
   * `allowed_updates` is narrowed to what the mirror reads. It is not merely an
   * optimisation: leaving it open means Telegram queues every group message and
   * inline query the bot can see, and those consume update_ids the bot then has
   * to acknowledge.
   */
  getUpdates: (offset: number, timeoutSeconds = 50) =>
    call<TgUpdate[]>('getUpdates', {
      offset,
      timeout: timeoutSeconds,
      allowed_updates: ['channel_post', 'edited_channel_post', 'my_chat_member'],
    }),

  /** Clears any registered webhook. A webhook and getUpdates are mutually
   *  exclusive - with one registered, getUpdates returns 409 forever. */
  deleteWebhook: () => call<boolean>('deleteWebhook', { drop_pending_updates: false }),

  getWebhookInfo: () => call<{ url: string; pending_update_count: number }>('getWebhookInfo'),

  getFile: (file_id: string) => call<TgFile>('getFile', { file_id }),

  fileUrl: (filePath: string) => `${FILE_BASE}/${filePath}`,

  sendMessage: (params: {
    chat_id: number;
    text: string;
    entities?: TgMessageEntity[];
    link_preview_options?: { url?: string; is_disabled?: boolean; prefer_large_media?: boolean };
  }) => call<TgMessage>('sendMessage', params),

  editMessageText: (params: {
    chat_id: number;
    message_id: number;
    text: string;
    entities?: TgMessageEntity[];
    link_preview_options?: { url?: string; is_disabled?: boolean; prefer_large_media?: boolean };
  }) => call<TgMessage>('editMessageText', params),

  editMessageCaption: (params: {
    chat_id: number;
    message_id: number;
    caption: string;
    caption_entities?: TgMessageEntity[];
  }) => call<TgMessage>('editMessageCaption', params),

  deleteMessage: (chat_id: number, message_id: number) =>
    call<boolean>('deleteMessage', { chat_id, message_id }),

  sendMediaGroup: (params: { chat_id: number; media: TgInputMedia[] }) =>
    call<TgMessage[]>('sendMediaGroup', params),

  sendByUrl: (
    method: 'sendPhoto' | 'sendVideo' | 'sendDocument',
    params: Record<string, unknown>,
  ) => call<TgMessage>(method, params),

  /** Streams bytes we hold to Telegram, for files it cannot fetch by URL. */
  sendMultipart: (
    method: 'sendPhoto' | 'sendVideo' | 'sendDocument' | 'sendMediaGroup',
    form: FormData,
  ) => callMultipart<TgMessage | TgMessage[]>(method, form),
};

/**
 * Confirms the bot can actually work in a channel, and says what is missing.
 *
 * Worth doing at boot and on every config change, because the inbound failure
 * mode is SILENT: a bot that is not an administrator of a channel simply never
 * receives channel_post for it. Without this check that is indistinguishable
 * from "nobody has posted yet".
 */
export async function checkChannelAccess(chatId: number, botUserId: number): Promise<{
  ok: boolean;
  title?: string;
  missingRights: string[];
  error?: string;
}> {
  try {
    const chat = await telegram.getChat(chatId);
    const member = await telegram.getChatMember(chatId, botUserId);

    if (member.status !== 'administrator' && member.status !== 'creator') {
      return {
        ok: false,
        title: chat.title,
        missingRights: ['administrator'],
        error: `bot is ${member.status}, not an administrator`,
      };
    }

    const missingRights: string[] = [];
    if (member.can_post_messages === false) missingRights.push('can_post_messages');
    if (member.can_edit_messages === false) missingRights.push('can_edit_messages');
    if (member.can_delete_messages === false) missingRights.push('can_delete_messages');

    return { ok: missingRights.length === 0, title: chat.title, missingRights };
  } catch (error) {
    log.warn('tg.access_check_failed', { chatId, ...errFields(error) });
    return {
      ok: false,
      missingRights: [],
      error: error instanceof TelegramApiError ? error.description : String(error),
    };
  }
}
