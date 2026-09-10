import { env } from './env.ts';

/**
 * Structured JSON logging to stdout, one line per event.
 *
 * `docker logs` is a real leak surface, so redaction here is not decoration:
 * a Firebase Storage download URL embeds a capability token that grants read
 * access to the file to anyone who has the string. Log the storage PATH, never
 * the URL.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
const threshold = LEVELS[env.logLevel] ?? LEVELS.info;

/** Keys whose values must never reach stdout, at any level. */
const REDACT = new Set(['token', 'botToken', 'privateKey', 'url', 'fileUrl', 'downloadUrl', 'authorization']);

function scrub(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    out[REDACT.has(key) ? `${key}Redacted` : key] = REDACT.has(key) ? true : value;
  }
  return out;
}

function emit(level: keyof typeof LEVELS, event: string, fields: Record<string, unknown> = {}) {
  if (LEVELS[level] < threshold) return;
  const line = { ts: new Date().toISOString(), level, event, ...scrub(fields) };
  // One JSON object per line: greppable by `docker logs | jq`, and safe for any
  // aggregator that splits on newline.
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => emit('debug', event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit('warn', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit('error', event, fields),
};

/** Errors carry no stack by default - a stack per Telegram 400 is noise. */
export const errFields = (error: unknown): Record<string, unknown> => ({
  err: error instanceof Error ? error.message : String(error),
  stack: env.logLevel === 'debug' && error instanceof Error ? error.stack : undefined,
});
