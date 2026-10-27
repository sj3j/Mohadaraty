import { randomUUID } from 'node:crypto';
import { db, FieldValue } from './firebase.ts';
import { env } from './env.ts';

const ref = db.collection('telegramDiagnostics').doc(`permission-probe-${randomUUID()}`);
let created = false;

try {
  await db.runTransaction(async tx => {
    tx.create(ref, {
      purpose: 'telegram-bot-firestore-permission-probe',
      instanceId: env.instanceId,
      createdAt: FieldValue.serverTimestamp(),
    });
  });
  created = true;

  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('probe document was not readable after creation');
    tx.update(ref, { updatedAt: FieldValue.serverTimestamp() });
  });

  await ref.delete();
  created = false;
  console.log(JSON.stringify({
    ok: true,
    projectId: env.firebase.projectId,
    clientEmail: env.firebase.clientEmail,
    checks: ['transaction-begin', 'document-create', 'document-read', 'document-update', 'document-delete'],
  }));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    projectId: env.firebase.projectId,
    clientEmail: env.firebase.clientEmail,
    code: (error as { code?: unknown } | null)?.code ?? null,
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
} finally {
  if (created) {
    try {
      await ref.delete();
    } catch (cleanupError) {
      console.error(JSON.stringify({
        ok: false,
        cleanup: 'failed',
        code: (cleanupError as { code?: unknown } | null)?.code ?? null,
      }));
      process.exitCode = 1;
    }
  }
}
