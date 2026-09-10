import { createServer, type Server } from 'node:http';
import { env } from './env.ts';
import { log } from './log.ts';
import { holdsLease } from './state.ts';
import { lastPollAt } from './poll.ts';
import { attachedStages, configuredStageCount } from './watcher.ts';
import { snapshot } from './status.ts';

/**
 * A health endpoint, plus the watchdog that makes it mean something.
 *
 * A Compose healthcheck does NOT restart anything - it only marks the container
 * unhealthy, and an unhealthy container will sit there unhealthy forever. So
 * the HTTP check is paired with an in-process watchdog that exits non-zero once
 * the same conditions have failed for long enough, which is what actually lets
 * `restart: unless-stopped` do its job.
 */

/** Three missed long-polls. A getUpdates cycle is ~50s, so this is generous. */
const POLL_STALE_MS = 180_000;
/** How long the bot may stay unhealthy before it gives up and restarts. */
const WATCHDOG_GRACE_MS = 5 * 60_000;

export interface Health {
  ok: boolean;
  reasons: string[];
}

export function assess(): Health {
  const reasons: string[] = [];

  if (!holdsLease()) reasons.push('lease_not_held');
  if (Date.now() - lastPollAt() > POLL_STALE_MS) reasons.push('poll_stale');

  const expected = configuredStageCount();
  if (attachedStages().length < expected) {
    reasons.push(`watchers_${attachedStages().length}_of_${expected}`);
  }

  return { ok: reasons.length === 0, reasons };
}

let server: Server | null = null;
let unhealthySince: number | null = null;

export function startHealthServer(): void {
  server = createServer((req, res) => {
    const health = assess();
    const verbose = req.url?.includes('verbose');

    res.writeHead(health.ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify(verbose ? { ...health, ...snapshot() } : health));
  });

  // Bound to loopback only. The container publishes no ports, and this endpoint
  // reports internal state that has no business being reachable off-host.
  server.listen(env.healthPort, '127.0.0.1', () => {
    log.info('health.listening', { port: env.healthPort });
  });
}

export function startWatchdog(): void {
  const timer = setInterval(() => {
    const health = assess();

    if (health.ok) {
      if (unhealthySince) log.info('health.recovered', {});
      unhealthySince = null;
      return;
    }

    if (!unhealthySince) {
      unhealthySince = Date.now();
      log.warn('health.degraded', { reasons: health.reasons });
      return;
    }

    if (Date.now() - unhealthySince > WATCHDOG_GRACE_MS) {
      log.error('health.watchdog_restart', { reasons: health.reasons, forMs: Date.now() - unhealthySince });
      // Restarting is safe precisely because the offset is durable in
      // Firestore: nothing is reprocessed and nothing is skipped.
      process.exit(1);
    }
  }, 30_000);
  timer.unref();
}

export function stopHealthServer(): void {
  server?.close();
  server = null;
}
