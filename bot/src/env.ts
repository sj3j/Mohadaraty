import 'dotenv/config';

/**
 * Environment, parsed and validated once at boot.
 *
 * Everything here fails LOUDLY and immediately rather than at first use. A
 * mirror bot that starts, polls happily for an hour and only then discovers it
 * cannot write to Storage has already dropped an hour of the channel.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(`[env] ${name} is required and is not set.`);
    process.exit(1);
  }
  return value.trim();
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
    console.error(
      '[env] FIREBASE_STORAGE_BUCKET is required. Do not rely on a ${projectId}.appspot.com ' +
      'default - this project\'s bucket is mylectures-app.firebasestorage.app.',
    );
    process.exit(1);
  }
  return bucket;
}

export const env = {
  telegramBotToken: required('TELEGRAM_BOT_TOKEN'),

  firebase: {
    projectId: required('FIREBASE_PROJECT_ID'),
    clientEmail: required('FIREBASE_CLIENT_EMAIL'),
    // The PEM is stored on one line with literal \n, exactly as server.ts:71
    // and every script in scripts/ reads it.
    privateKey: required('FIREBASE_PRIVATE_KEY').replace(/\\n/g, '\n'),
    storageBucket: requiredBucket(),
  },

  logLevel: (process.env.LOG_LEVEL ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
  healthPort: Number(process.env.HEALTH_PORT ?? 8081),
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
