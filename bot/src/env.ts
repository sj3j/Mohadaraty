import 'dotenv/config';
import { normalizePrivateKey, describePrivateKey, PrivateKeyFormatError } from './privateKey.ts';
import { decodeServiceAccount, ServiceAccountFormatError, type Repair } from './serviceAccount.ts';
import { parseBotToken, BotTokenFormatError } from './botToken.ts';

/**
 * Environment, parsed and validated once at boot.
 *
 * Everything here fails LOUDLY and immediately rather than at first use. A
 * mirror bot that starts, polls happily for an hour and only then discovers it
 * cannot write to Storage has already dropped an hour of the channel.
 */

function fail(message: string): never {
  console.error(`[env] ${message}`);
  process.exit(1);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) fail(`${name} is required and is not set.`);
  return value.trim();
}

export interface ServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  /** Which variable the credentials came from, for the boot log. */
  source: 'FIREBASE_SERVICE_ACCOUNT_B64' | 'FIREBASE_SERVICE_ACCOUNT' | 'three variables';
  /** Which repair the blob needed, if any. `none` means the panel value was clean. */
  repairedBy: Repair;
}

/**
 * Credentials, from any of three shapes.
 *
 * FIREBASE_SERVICE_ACCOUNT_B64 - the whole .json, base64-encoded - is the
 * RECOMMENDED form, and the reason is specific rather than stylistic: base64
 * contains no quote, backslash, newline or smart quote, so there is nothing in
 * it for a single-line panel field to damage. Every credential failure this bot
 * has had was a field eating one of those four characters.
 *
 * FIREBASE_SERVICE_ACCOUNT - the same file pasted verbatim - still works, and
 * is now repaired rather than merely rejected when it arrives escaped, quoted
 * or smart-quoted. See serviceAccount.ts for why that matters: JSON.parse
 * reports the same "position 1" for six unrelated manglings, so the raw parse
 * error identifies nothing.
 *
 * The three separate variables are what server.ts and every script in scripts/
 * use, so they stay supported - but they put a PEM through a single-line text
 * field, which is where `\\n` double-escaping, stored quotes and collapsed
 * whitespace all come from. normalizePrivateKey repairs those; it should not
 * have to.
 */
function readCredentials(): ServiceAccount {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64?.trim();
  const json = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  const raw = b64 || json;
  const source = b64 ? 'FIREBASE_SERVICE_ACCOUNT_B64' : 'FIREBASE_SERVICE_ACCOUNT';

  if (raw) {
    let fields: Record<string, unknown>;
    let repairedBy: Repair;
    try {
      ({ fields, repairedBy } = decodeServiceAccount(raw));
    } catch (error) {
      if (error instanceof ServiceAccountFormatError) {
        // Worth saying, because it turns a dead container into a one-field
        // change: the three-variable path is a complete alternative, and the
        // blob only takes priority while it is non-empty.
        const fallbackReady = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY']
          .every(name => process.env[name]?.trim());
        const hint = fallbackReady
          ? '\n  The three separate FIREBASE_* variables are also set and look ' +
            `complete. BLANKING ${source} would make the bot use those instead, ` +
            'with no redeploy.'
          : '';
        fail(`${source}: ${error.message}${hint}`);
      }
      throw error;
    }

    const projectId = String(fields.project_id ?? fields.projectId ?? '');
    const clientEmail = String(fields.client_email ?? fields.clientEmail ?? '');
    const privateKey = String(fields.private_key ?? fields.privateKey ?? '');

    if (!projectId || !clientEmail || !privateKey) {
      fail(
        `${source} parsed as JSON but is missing project_id, client_email or ` +
        'private_key. That is the shape of an API-key file, not a service ' +
        'account - download the service-account key instead.',
      );
    }

    // Normalised anyway: harmless for a correct JSON key, and it rescues the
    // case where someone re-escaped the file's contents before pasting it.
    return { projectId, clientEmail, privateKey: safeNormalize(privateKey), source, repairedBy };
  }

  return {
    projectId: required('FIREBASE_PROJECT_ID'),
    clientEmail: required('FIREBASE_CLIENT_EMAIL'),
    privateKey: safeNormalize(required('FIREBASE_PRIVATE_KEY')),
    source: 'three variables',
    repairedBy: 'none',
  };
}

/**
 * The supported Node version, warned about rather than enforced.
 *
 * firebase-admin itself declares `>=18` and loads fine below 20, so exiting
 * would take down a bot that works. Its transitive @firebase/* packages declare
 * `>=20`, the bundle is built `target: node22`, and a panel left on an old
 * default is the kind of thing that produces an unexplained failure months
 * later - so it is said out loud, once, at boot.
 */
const MIN_NODE_MAJOR = 20;

function warnOnOldNode(): void {
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isFinite(major) && major < MIN_NODE_MAJOR) {
    console.warn(
      `[env] Node v${process.versions.node} is below the supported >=${MIN_NODE_MAJOR} ` +
      '(this bundle is built for node22). Raise the Node version in the hosting ' +
      "panel - firebase's own packages do not support this one, and what breaks " +
      'will not name the version when it does.',
    );
  }
}

/** Turns a PrivateKeyFormatError into a named exit rather than an OpenSSL
 *  `DECODER routines::unsupported`, which says nothing about what is wrong. */
function safeNormalize(raw: string): string {
  try {
    return normalizePrivateKey(raw);
  } catch (error) {
    if (error instanceof PrivateKeyFormatError) fail(error.message);
    throw error;
  }
}

/**
 * The storage bucket, which MUST be explicit.
 *
 * server.ts and api/index.ts both fall back to `${projectId}.appspot.com`, and
 * for this project that resolves to nothing: the real bucket is
 * mylectures-app.firebasestorage.app, the newer naming Firebase gives buckets
 * created after late 2024. Inheriting that fallback here would mean every
 * inbound photo silently fails to upload.
 */
function requiredBucket(): string {
  const bucket = process.env.FIREBASE_STORAGE_BUCKET?.trim();
  if (!bucket) {
    fail(
      'FIREBASE_STORAGE_BUCKET is required. Do not rely on a ${projectId}.appspot.com ' +
      "default - this project's bucket is mylectures-app.firebasestorage.app.",
    );
  }
  return bucket;
}

warnOnOldNode();

const credentials = readCredentials();

/**
 * The bot token, checked for SHAPE before it is ever sent.
 *
 * A token damaged by the panel field comes back from Telegram as 404 Not
 * Found, which reads as "the API moved" rather than "your variable is wrong".
 * Failing here instead names the variable.
 */
function requiredBotToken() {
  try {
    return parseBotToken(required('TELEGRAM_BOT_TOKEN'));
  } catch (error) {
    if (error instanceof BotTokenFormatError) fail(error.message);
    throw error;
  }
}

const botToken = requiredBotToken();

export const env = {
  telegramBotToken: botToken.token,
  /** Public: the digits before the colon are the bot's own user id. */
  botId: botToken.botId,
  /** Safe to log - proves which token is loaded without revealing it. */
  botTokenFingerprint: botToken.fingerprint,

  firebase: {
    ...credentials,
    storageBucket: requiredBucket(),
    /**
     * Logged at boot, never the key itself.
     *
     * A key that is merely MANGLED now fails loudly in normalizePrivateKey.
     * A key that is intact but belongs to the wrong service account still
     * boots cleanly and fails much later, as a permission denial on a write,
     * with nothing in the log tying it back to the credential. This is what
     * tells those two apart.
     */
    keyFingerprint: describePrivateKey(credentials.privateKey),
  },

  logLevel: (process.env.LOG_LEVEL ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
  // SERVER_PORT is what Pterodactyl-style panels (Wispbyte) inject for the
  // container's allocation. Preferring it means the health server cannot
  // collide with something the panel already bound.
  healthPort: Number(process.env.HEALTH_PORT ?? process.env.SERVER_PORT ?? 8081),
  /** Identifies this container in the lease and the status document. */
  instanceId: process.env.INSTANCE_ID || `bot-${process.pid}-${Date.now().toString(36)}`,
  version: process.env.GIT_SHA || 'dev',

  /**
   * Announcements older than this are never mirrored outbound.
   *
   * The guard that stops the first boot from re-posting the entire back
   * catalogue to five channels. The outbound watcher's query is already bounded
   * by createdAt, but a stale mapping or a cleared telegramMirror field would
   * otherwise still qualify an old post. 24h by default.
   */
  mirrorMaxAgeMs: Number(process.env.MIRROR_MAX_AGE_MS ?? 24 * 60 * 60 * 1000),
} as const;
