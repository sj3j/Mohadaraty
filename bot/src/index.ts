import { env } from './env.ts';
import { log, errFields } from './log.ts';
import { isNetworkError, describeNetworkFailure } from './net.ts';
import { explainUnauthorized } from './botToken.ts';
import { TelegramApiError } from './telegram/types.ts';
import { telegram, checkChannelAccess, TELEGRAM_HOST } from './telegram/api.ts';
import { acquireLease, startLeaseRenewal, stopLeaseRenewal, releaseLease } from './state.ts';
import { LeaseWaitAbortedError, waitForLease } from './leaseStartup.ts';
import { watchConfig, waitForConfigReady, getConfig, onConfigChange, publishActiveStages } from './config.ts';
import { startPolling, stopPolling } from './poll.ts';
import { startWatchers } from './watcher.ts';
import { startHealthServer, startWatchdog, stopHealthServer } from './health.ts';
import {
  markChannel,
  setPollState,
  startStatusReporting,
  stopStatusReporting,
} from './status.ts';
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
let shutdownReason = 'shutdown';
let resolveShutdown!: (reason: string) => void;
const shutdownSignal = new Promise<string>(resolve => { resolveShutdown = resolve; });

function requestShutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  shutdownReason = reason;
  log.info('shutdown.requested', { reason });
  resolveShutdown(reason);
}

async function sleepOrShutdown(ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    new Promise<void>(resolve => { timer = setTimeout(resolve, ms); }),
    shutdownSignal.then(() => undefined),
  ]);
  if (timer) clearTimeout(timer);
}

/** Waits safely through overlap, IAM repair, and transient Firestore outages. */
async function acquireLeaseUntilAvailable(): Promise<void> {
  await waitForLease({
    acquire: acquireLease,
    shouldContinue: () => !shuttingDown,
    onWait: fields => log.warn('boot.waiting_for_lease', { ...fields }),
    sleep: sleepOrShutdown,
  });
}

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

/**
 * Waits for Telegram to be reachable, for as long as that takes.
 *
 * This does not exit, and that is the point. A network failure at boot used to
 * kill the process about two seconds after start, and a panel host that aborts
 * automatic restarts for anything crashing inside its first minute then leaves
 * the container dead until a human notices. The bot has nothing else to do
 * while the network is down, so waiting is strictly better than dying: it comes
 * back by itself when the host's networking finishes coming up, or when
 * whatever was interfering stops.
 *
 * Only NETWORK failures loop. An invalid token is a 401, which fails the same
 * way forever - retrying that would turn a typo into a container that looks
 * busy and is doing nothing, which is the failure mode this whole file is
 * written to avoid.
 */
async function reachTelegram(): Promise<{ id: number; username?: string }> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await telegram.getMe();
    } catch (error) {
      // A 401 is the one Telegram error whose status does not explain itself,
      // and it is permanent - so it is named here and never retried.
      if (error instanceof TelegramApiError && error.errorCode === 401) {
        log.error('tg.token_rejected', {
          botTokenFingerprint: env.botTokenFingerprint,
          detail: explainUnauthorized(error.description, env.botTokenFingerprint),
        });
        throw error;
      }
      if (!isNetworkError(error)) throw error;
      // Capped at a minute: past that the wait says nothing new, and a host
      // that recovers deserves to be noticed promptly.
      const waitMs = Math.min(60_000, 2 ** Math.min(attempt, 6) * 1000);
      log.warn('tg.unreachable', {
        attempt,
        waitMs,
        detail: describeNetworkFailure(error, TELEGRAM_HOST),
        ...errFields(error),
      });
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }
}

async function main(): Promise<void> {
  log.info('boot', {
    instanceId: env.instanceId,
    version: env.version,
    projectId: env.firebase.projectId,
    clientEmail: env.firebase.clientEmail,
    keyFingerprint: env.firebase.keyFingerprint,
    // Which variable the credentials came from, and what had to be repaired on
    // the way in. `repairedBy` anything other than "none" means the panel is
    // still storing a damaged value - it boots now, but it is worth fixing at
    // the source, and this line is the only place that would ever say so.
    credentialSource: env.firebase.source,
    repairedBy: env.firebase.repairedBy,
    firestoreTransport: env.firestoreTransport,
    // Printed before the first Telegram call on purpose: when the token is
    // rejected, this is the only line that says WHICH token was tried.
    botTokenFingerprint: env.botTokenFingerprint,
  });

  // Start diagnostics and signal handling before any remote dependency. During
  // IAM repair the process stays alive and /healthz names the lease failure.
  startHealthServer();
  process.once('SIGTERM', () => { requestShutdown('SIGTERM'); });
  process.once('SIGINT', () => { requestShutdown('SIGINT'); });
  const stopWatchdog = startWatchdog();

  const me = await reachTelegram();
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

  try {
    while (!shuttingDown) {
      setPollState('recovering');
      try {
        await acquireLeaseUntilAvailable();
      } catch (error) {
        if (error instanceof LeaseWaitAbortedError && shuttingDown) break;
        throw error;
      }
      if (shuttingDown) break;

      let resolveLeaseLost!: () => void;
      const leaseLost = new Promise<void>(resolve => { resolveLeaseLost = resolve; });
      let unwatchConfig: () => void = () => {};
      let stopWatchers: () => void = () => {};
      let offConfigVerify: () => void = () => {};
      let channelVerifyTimer: NodeJS.Timeout | null = null;
      let pollingPromise: Promise<void> | null = null;

      startLeaseRenewal(() => {
        setPollState('recovering');
        void stopPolling();
        void stopStatusReporting();
        resolveLeaseLost();
      });

      try {
        await startStatusReporting();
        unwatchConfig = watchConfig();
        // A timer cannot prove the channel map was loaded. Do not acknowledge
        // Telegram updates until a valid map has actually been read.
        await waitForConfigReady();

        await publishActiveStages();
        await verifyChannels();
        offConfigVerify = onConfigChange(() => { void verifyChannels(); });
        channelVerifyTimer = setInterval(() => { void verifyChannels(); }, 15 * 60_000);
        channelVerifyTimer.unref();

        stopWatchers = startWatchers();
        log.info('runtime.started', {
          transport: env.firestoreTransport,
        });

        pollingPromise = startPolling();
        const outcome = await Promise.race([
          pollingPromise.then(() => 'polling-ended' as const),
          leaseLost.then(() => 'lease-lost' as const),
          shutdownSignal.then(() => 'shutdown' as const),
        ]);
        log.warn('runtime.stopping', { outcome });
      } catch (error) {
        if (!shuttingDown) log.error('runtime.failed', errFields(error));
      } finally {
        // Stop every producer before draining the queues. No callback or timer
        // from an old lease generation may survive into the next one.
        await stopPolling();
        if (pollingPromise) {
          try {
            await pollingPromise;
          } catch (error) {
            if (!shuttingDown) log.warn('poll.teardown_failed', errFields(error));
          }
        }
        unwatchConfig();
        stopWatchers();
        offConfigVerify();
        if (channelVerifyTimer) clearInterval(channelVerifyTimer);
        await stopAllQueues(true);
        await stopStatusReporting();
        stopLeaseRenewal();
        await releaseLease();
      }

      if (!shuttingDown) {
        setPollState('recovering');
        log.warn('runtime.recovering', { transport: env.firestoreTransport });
        await sleepOrShutdown(2_000);
      }
    }
  } finally {
    stopWatchdog();
    stopHealthServer();
  }

  log.info('shutdown.complete', { reason: shutdownReason });
}

/**
 * A panel host aborts its own automatic restart when a container crashes
 * inside its first minute ("last crash occurred less than 60 seconds ago"),
 * which is exactly what a network failure at boot produces. Staying up past
 * that mark converts a dead container into a restarted one.
 */
const RESTART_GRACE_MS = 70_000;

main().catch(async error => {
  if (error instanceof LeaseWaitAbortedError && shuttingDown) return;
  const network = isNetworkError(error);
  log.error('boot.failed', {
    detail: network ? describeNetworkFailure(error, TELEGRAM_HOST) : undefined,
    ...errFields(error),
  });

  // Only for network failures. A permanent error - a bad token, a malformed
  // config - should stop the container and stay stopped, because restarting it
  // every 70 seconds forever hides the message that says what is wrong.
  const remaining = RESTART_GRACE_MS - Math.round(process.uptime() * 1000);
  if (network && remaining > 0) {
    log.warn('boot.delaying_exit', {
      remainingMs: remaining,
      why: 'crashing sooner than this makes the host abort its own restart',
    });
    await new Promise(resolve => setTimeout(resolve, remaining));
  }
  process.exit(1);
});
