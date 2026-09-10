import { env } from './env.ts';
import { log, errFields } from './log.ts';
import { telegram, checkChannelAccess } from './telegram/api.ts';
import { acquireLease, startLeaseRenewal, stopLeaseRenewal, releaseLease } from './state.ts';
import { watchConfig, getConfig, onConfigChange, publishActiveStages } from './config.ts';
import { startPolling, stopPolling } from './poll.ts';
import { startWatchers } from './watcher.ts';
import { startHealthServer, startWatchdog, stopHealthServer } from './health.ts';
import { reportBoot, markChannel } from './status.ts';
import { stopAllQueues } from './queue.ts';
import { MIRROR_STAGE_IDS } from '../../shared/telegramMirror.ts';

/**
 * The composition root.
 *
 * Boot order matters: lease -> config -> access check -> watchers -> poll. The
 * poll loop starts LAST because an update that arrives before the config is
 * loaded has no channel map to resolve against and would be dropped as
 * unmapped - permanently, since the offset would advance past it.
 */

let botUserId = 0;
let shuttingDown = false;

/**
 * Verifies the bot can work in every configured channel.
 *
 * Worth the API calls because the inbound failure is otherwise SILENT: a bot
 * that is not an administrator of a channel receives no channel_post for it at
 * all, which is indistinguishable from nobody having posted. This turns "the
 * mirror doesn't work" into a named missing right in the admin UI.
 */
async function verifyChannels(): Promise<void> {
  const config = getConfig();

  for (const stageId of MIRROR_STAGE_IDS) {
    const channel = config.channels[stageId];
    if (!channel?.enabled) continue;

    const access = await checkChannelAccess(channel.chatId, botUserId);
    markChannel(stageId, {
      chatId: channel.chatId,
      title: access.title,
      adminOk: access.ok,
      missingRights: access.missingRights,
      state: access.ok ? 'ok' : 'parked',
      lastError: access.error ?? (access.missingRights.length ? `missing: ${access.missingRights.join(', ')}` : null),
    });

    if (!access.ok) {
      log.error('tg.channel_unusable', {
        stageId, chatId: channel.chatId,
        missingRights: access.missingRights, description: access.error,
      });
    } else {
      log.info('tg.channel_ok', { stageId, chatId: channel.chatId, title: access.title });
    }
  }
}

async function main(): Promise<void> {
  log.info('boot', { instanceId: env.instanceId, version: env.version });

  const me = await telegram.getMe();
  botUserId = me.id;
  log.info('tg.identity', { botUserId, username: me.username });

  /*
   * A registered webhook and getUpdates are mutually exclusive - with one set,
   * getUpdates returns 409 forever. The Cloud Function webhook this bot
   * replaces was deployed in TWO regions, so clearing it here is not optional
   * housekeeping; it is what lets this process receive anything at all.
   */
  const webhook = await telegram.getWebhookInfo();
  if (webhook.url) {
    log.warn('tg.clearing_webhook', { url: webhook.url, pending: webhook.pending_update_count });
    await telegram.deleteWebhook();
  }

  if (!await acquireLease()) {
    // Exiting non-zero lets the restart policy back off rather than spin.
    log.error('boot.aborted_lease_held', {});
    process.exit(1);
  }
  startLeaseRenewal(() => { void shutdown('lease-lost'); });

  await reportBoot();

  const unwatchConfig = watchConfig();
  // The first snapshot is asynchronous; the poll loop must not start before it.
  await new Promise(resolve => setTimeout(resolve, 1500));

  await publishActiveStages();
  await verifyChannels();
  onConfigChange(() => { void verifyChannels(); });
  // Membership can be revoked without any config change, so re-check on a timer.
  setInterval(() => { void verifyChannels(); }, 15 * 60_000).unref();

  const stopWatchers = startWatchers();
  startHealthServer();
  startWatchdog();

  const teardown = async () => {
    unwatchConfig();
    stopWatchers();
    stopHealthServer();
  };

  process.once('SIGTERM', () => { void shutdown('SIGTERM', teardown); });
  process.once('SIGINT', () => { void shutdown('SIGINT', teardown); });

  await startPolling();
}

/**
 * Stops taking new work, lets in-flight work finish, then exits.
 *
 * The drain matters: a SIGTERM mid-batch loses nothing, because the offset was
 * never advanced - but it would leave Telegram to redeliver work that is
 * already half-applied. Finishing the queues first keeps that rare.
 */
async function shutdown(reason: string, teardown?: () => Promise<void>): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutdown', { reason });

  try {
    await stopPolling();
    await stopAllQueues();
    await teardown?.();
    stopLeaseRenewal();
    await releaseLease();
  } catch (error) {
    log.error('shutdown.failed', errFields(error));
  }
  process.exit(reason === 'lease-lost' ? 1 : 0);
}

main().catch(error => {
  log.error('boot.failed', errFields(error));
  process.exit(1);
});
