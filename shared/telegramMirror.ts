/**
 * The Telegram channel mirror: types, defaults and validation.
 *
 * Lives in shared/ for the same reason academicCalendar.ts does - it is read by
 * the browser (the admin UI that edits it) AND by the mirror bot (a standalone
 * Node process in bot/), and a second copy would drift. Deliberately free of any
 * Firebase import so all three of those plus the tests run the same code.
 *
 * NOT readable by functions/index.js, which deploys as its own package with no
 * access to ../shared. Nothing in functions/ needs it: the Cloud Function that
 * used to ingest Telegram posts (telegramWebhookV3) is deleted by this change,
 * and the bot owns that job now.
 */

/** The five academic stages, matching DEFAULT_STAGES in src/contexts/StageContext.tsx. */
export const MIRROR_STAGE_IDS = ['stage_1', 'stage_2', 'stage_3', 'stage_4', 'stage_5'] as const;
export type MirrorStageId = typeof MIRROR_STAGE_IDS[number];

export interface TelegramChannel {
  /**
   * The numeric chat id, e.g. -1002345678901.
   *
   * Deliberately not a @username: a private channel has none, and the whole
   * point of this feature is that the five stage channels are private. Stored
   * as a number because that is what the Bot API returns and expects.
   */
  chatId: number;
  /** Shown as the announcement's author in the app. Falls back to the channel title. */
  displayName?: string;
  /** Master switch for this stage. Off means neither direction runs. */
  enabled: boolean;
  /** Telegram -> app. */
  mirrorIn: boolean;
  /** App -> Telegram. */
  mirrorOut: boolean;
}

export interface TelegramConfig {
  /** Global kill switch. Off stops both directions for every stage at once. */
  enabled: boolean;
  channels: Partial<Record<MirrorStageId, TelegramChannel>>;
  /**
   * The default for `telegramMirror.enabled` on a newly composed announcement.
   * A moderator can still opt an individual post out in the composer.
   */
  defaultMirrorOut: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

export const DEFAULT_TELEGRAM_CONFIG: TelegramConfig = {
  enabled: false,
  channels: {},
  defaultMirrorOut: true,
};

/** Firestore location. Master-admin read AND write - the doc enumerates private
 *  channel ids, which is why it is not in app_settings (readable by every
 *  signed-in student). */
export const TELEGRAM_CONFIG_DOC = 'admin_config/telegram';
/** Bot-written health. Master-admin read, no client write. */
export const TELEGRAM_STATUS_DOC = 'admin_config/telegram_status';
/** Bot-owned getUpdates offset and single-instance lease. No client access. */
export const TELEGRAM_STATE_DOC = 'admin_config/telegram_state';

export type TelegramConfigProblem =
  | 'no_channels'
  | 'bad_chat_id'
  | 'duplicate_chat_id'
  | 'unknown_stage';

/**
 * Accepts what a person actually pastes and returns a chat id, or null.
 *
 * Telegram's own UI and its bots hand out the id in several shapes - a bare
 * `-1002345678901`, the same wrapped by "Chat ID: ", or a `t.me/c/2345678901/5`
 * link whose id has the `-100` prefix stripped. Requiring one canonical form
 * would just move the reformatting into the admin's head.
 */
export function parseChatId(raw: string | number | null | undefined): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (!raw) return null;

  const text = String(raw).trim();
  if (!text) return null;

  // t.me/c/<internal>/<messageId> - the c/ form drops the -100 prefix.
  const privateLink = text.match(/t\.me\/c\/(\d+)/);
  if (privateLink) return Number(`-100${privateLink[1]}`);

  const digits = text.match(/-?\d{5,}/);
  if (!digits) return null;

  const value = Number(digits[0]);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * True for an id that can actually be a channel.
 *
 * Channels and supergroups are always negative and conventionally carry the
 * -100 prefix. A positive id is a private chat with a user, which cannot be
 * mirrored and is the most likely paste mistake (someone's own user id).
 */
export function isChannelChatId(chatId: number): boolean {
  return Number.isSafeInteger(chatId) && chatId < 0;
}

/**
 * Problems that must block a save.
 *
 * Returns codes rather than sentences so the UI can localise them - the same
 * split academicCalendar.ts uses with its `explain()` helper.
 */
export function validateTelegramConfig(config: TelegramConfig): TelegramConfigProblem[] {
  const problems = new Set<TelegramConfigProblem>();
  const seen = new Map<number, string>();

  const entries = Object.entries(config.channels ?? {});
  const active = entries.filter(([, channel]) => channel && channel.enabled);

  if (config.enabled && active.length === 0) problems.add('no_channels');

  for (const [stageId, channel] of entries) {
    if (!channel) continue;
    if (!(MIRROR_STAGE_IDS as readonly string[]).includes(stageId)) problems.add('unknown_stage');
    if (!isChannelChatId(channel.chatId)) problems.add('bad_chat_id');

    // One channel may not feed two stages: an inbound post would have no
    // single correct stageId, and stage isolation is the one thing the
    // announcements feed is not allowed to get wrong.
    const previous = seen.get(channel.chatId);
    if (previous !== undefined && previous !== stageId) problems.add('duplicate_chat_id');
    seen.set(channel.chatId, stageId);
  }

  return [...problems];
}

/** Reverse lookup for the inbound leg: which stage owns this Telegram chat? */
export function resolveStageForChat(config: TelegramConfig, chatId: number): MirrorStageId | null {
  if (!config.enabled) return null;
  for (const stageId of MIRROR_STAGE_IDS) {
    const channel = config.channels[stageId];
    if (channel?.enabled && channel.mirrorIn && channel.chatId === chatId) return stageId;
  }
  return null;
}

/** Forward lookup for the outbound leg. */
export function resolveChannelForStage(config: TelegramConfig, stageId: string): TelegramChannel | null {
  if (!config.enabled) return null;
  const channel = config.channels[stageId as MirrorStageId];
  return channel?.enabled && channel.mirrorOut ? channel : null;
}

/** Normalises whatever Firestore returns into a complete config. */
export function coerceTelegramConfig(data: unknown): TelegramConfig {
  const raw = (data ?? {}) as Partial<TelegramConfig>;
  const channels: TelegramConfig['channels'] = {};

  for (const stageId of MIRROR_STAGE_IDS) {
    const channel = raw.channels?.[stageId];
    if (!channel || typeof channel.chatId !== 'number') continue;
    channels[stageId] = {
      chatId: channel.chatId,
      displayName: channel.displayName || undefined,
      enabled: channel.enabled !== false,
      mirrorIn: channel.mirrorIn !== false,
      mirrorOut: channel.mirrorOut !== false,
    };
  }

  return {
    enabled: raw.enabled === true,
    channels,
    defaultMirrorOut: raw.defaultMirrorOut !== false,
    updatedAt: raw.updatedAt,
    updatedBy: raw.updatedBy,
  };
}

/** Firestore doc id for one Telegram message. `-100…` cannot start a doc id
 *  segment cleanly, so the sign becomes `n`. */
export const chatIdKey = (chatId: number): string => String(chatId).replace('-', 'n');
export const telegramMessageKey = (chatId: number, messageId: number): string =>
  `${chatIdKey(chatId)}_${messageId}`;
/** Deterministic announcement id for a Telegram-origin post. Deterministic so a
 *  redelivered update cannot create a second document - and so the push-
 *  notification lock (sentNotifications/{docId}_…) cannot fire twice. */
export const telegramAnnouncementId = (chatId: number, messageId: number): string =>
  `tg_${telegramMessageKey(chatId, messageId)}`;
