import { db, FieldValue } from './firebase.ts';
import { log } from './log.ts';
import {
  DEFAULT_TELEGRAM_CONFIG,
  MIRROR_STAGE_IDS,
  coerceTelegramConfig,
  validateTelegramConfig,
  type MirrorStageId,
  type TelegramChannel,
  type TelegramConfig,
} from '../../shared/telegramMirror.ts';

/**
 * The live channel map.
 *
 * Watched rather than read once, so saving the admin screen IS the whole
 * deployment step for a channel change - no restart, no redeploy.
 *
 * The validation here is not belt-and-braces. A config that maps one chat to
 * two stages makes an inbound post ambiguous, and stage isolation is the one
 * thing the announcements feed is not allowed to get wrong - so an invalid
 * snapshot is REJECTED WHOLE and the previous good config keeps running.
 * Applying half of it would be worse than ignoring it.
 */

let current: TelegramConfig = DEFAULT_TELEGRAM_CONFIG;
let configError: string | null = null;

export const getConfig = (): TelegramConfig => current;
export const getConfigError = (): string | null => configError;

export type ConfigListener = (config: TelegramConfig, previous: TelegramConfig) => void;

const listeners = new Set<ConfigListener>();
export function onConfigChange(listener: ConfigListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Chat ids the inbound leg will accept, as an O(1) allowlist. */
let inboundChats = new Map<number, MirrorStageId>();
export const stageForChat = (chatId: number): MirrorStageId | undefined => inboundChats.get(chatId);

function rebuildAllowlist(config: TelegramConfig): void {
  const next = new Map<number, MirrorStageId>();
  if (config.enabled) {
    for (const stageId of MIRROR_STAGE_IDS) {
      const channel = config.channels[stageId];
      if (channel?.enabled && channel.mirrorIn) next.set(channel.chatId, stageId);
    }
  }
  inboundChats = next;
}

export function outboundChannelFor(stageId: string): TelegramChannel | null {
  if (!current.enabled) return null;
  const channel = current.channels[stageId as MirrorStageId];
  return channel?.enabled && channel.mirrorOut ? channel : null;
}

/** Stages the mirror is live for, in either direction. */
export function activeStageIds(): string[] {
  if (!current.enabled) return [];
  return MIRROR_STAGE_IDS.filter(stageId => current.channels[stageId]?.enabled);
}

export function watchConfig(): () => void {
  return db.collection('admin_config').doc('telegram').onSnapshot(
    async snap => {
      const incoming = snap.exists ? coerceTelegramConfig(snap.data()) : DEFAULT_TELEGRAM_CONFIG;
      const problems = validateTelegramConfig(incoming);

      if (problems.length > 0) {
        configError = problems.join(', ');
        log.error('config.rejected', { problems, keeping: Object.keys(current.channels) });
        // Deliberately keeps `current` untouched.
        return;
      }

      const previous = current;
      current = incoming;
      configError = null;
      rebuildAllowlist(incoming);

      log.info('config.applied', {
        enabled: incoming.enabled,
        stages: Object.keys(incoming.channels),
      });

      for (const listener of listeners) {
        try {
          listener(incoming, previous);
        } catch (error) {
          log.error('config.listener_failed', { err: String(error) });
        }
      }

      await publishActiveStages();
    },
    error => {
      configError = String(error);
      log.error('config.listener_error', { err: String(error) });
    },
  );
}

/**
 * Publishes which stages have a live mirror, for the composer's toggle.
 *
 * Deliberately stage IDS ONLY, into settings/announcements - a document every
 * signed-in user may read. The channel map itself stays master-admin-only
 * because it names private channels, but a moderator still needs to know
 * whether the "post to Telegram" switch on their composer will do anything, and
 * a bare list of stage ids leaks nothing.
 */
export async function publishActiveStages(): Promise<void> {
  try {
    await db.collection('settings').doc('announcements').set({
      telegramStages: activeStageIds(),
      telegramUpdatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (error) {
    log.warn('config.publish_stages_failed', { err: String(error) });
  }
}
