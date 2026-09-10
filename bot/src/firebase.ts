import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { env } from './env.ts';

/**
 * The Admin SDK handles for this process.
 *
 * The bot bypasses firestore.rules entirely - that is the point of a service
 * account, and it is why the rules can lock admin_config down to the master
 * admin without locking the bot out. Every authorisation decision the bot makes
 * is therefore its own: it must never write a stageId it was not configured
 * for, because nothing downstream will stop it.
 */

// api/index.ts guards with `if (!admin.apps.length)` because Vercel reuses the
// module across invocations. The same guard costs nothing here and makes the
// module safe to import from a test that already initialised.
if (getApps().length === 0) {
  initializeApp({
    credential: cert({
      projectId: env.firebase.projectId,
      clientEmail: env.firebase.clientEmail,
      privateKey: env.firebase.privateKey,
    }),
    storageBucket: env.firebase.storageBucket,
  });
}

export const db = getFirestore();
export const bucket = getStorage().bucket(env.firebase.storageBucket);
export { FieldValue, Timestamp };
