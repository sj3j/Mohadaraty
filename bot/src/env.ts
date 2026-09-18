import 'dotenv/config';
import { normalizePrivateKey, describePrivateKey, unquote, PrivateKeyFormatError } from './privateKey.ts';

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
}

/**
 * Credentials, from either of two shapes.
 *
 * FIREBASE_SERVICE_ACCOUNT - the whole service-account .json, pasted verbatim -
 * is the RECOMMENDED form for a hosting panel, and the reason is specific
 * rather than stylistic: the private key inside it is a JSON string, so
 * JSON.parse turns its `\n` escapes into real newlines correctly, by spec, with
 * no hand-rolled unescaping anywhere in the path.
 *
 * The three separate variables are what server.ts and every script in scripts/
 * use, so they stay supported - but they put a PEM through a single-line text
 * field, and that is where `\\n` double-escaping, stored quote characters and
 * collapsed whitespace all come from. normalizePrivateKey repairs those; it
 * should not have to.
 */
function readCredentials(): ServiceAccount {
  // unquote first: env_file and most panels store a wrapping quote as part of
  // the value, and a quoted blob fails JSON.parse on its first character.
  const raw = unquote(process.env.FIREBASE_SERVICE_ACCOUNT ?? '');

  if (raw) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      fail(
        'FIREBASE_SERVICE_ACCOUNT is set but is not valid JSON. Paste the ENTIRE ' +
        'contents of the service-account .json file, starting with { and ending ' +
        'with } - all on one line, and not wrapped in extra quotes. ' +
        `(${error instanceof Error ? error.message : String(error)})`,
      );
    }

    const projectId = String(parsed.project_id ?? parsed.projectId ?? '');
    const clientEmail = String(parsed.client_email ?? parsed.clientEmail ?? '');
    const privateKey = String(parsed.private_key ?? parsed.privateKey ?? '');

    if (!projectId || !clientEmail || !privateKey) {
      fail(
        'FIREBASE_SERVICE_ACCOUNT parsed as JSON but is missing project_id, ' +
        'client_email or private_key. That is the shape of an API-key file, not ' +
        'a service account - download the service-account key instead.',
      );
    }

    // Normalised anyway: harmless for a correct JSON key, and it rescues the
    // case where someone re-escaped the file's contents before pasting it.
    return { projectId, clientEmail, privateKey: safeNormalize(privateKey) };
  }

  return {
    projectId: required('FIREBASE_PROJECT_ID'),
    clientEmail: required('FIREBASE_CLIENT_EMAIL'),
    privateKey: safeNormalize(required('FIREBASE_PRIVATE_KEY')),
  };
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

const credentials = readCredentials();

export const env = {
  telegramBotToken: required('TELEGRAM_BOT_TOKEN'),

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
