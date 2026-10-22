import { db, FieldValue, Timestamp } from './firebase.ts';
import { env } from './env.ts';
import { ALBUM_COLLECTION, INBOX_COLLECTION } from './inbox.ts';

const [command, updateId] = process.argv.slice(2);
const inbox = db.collection(INBOX_COLLECTION);

function printable(data: Record<string, any>): Record<string, unknown> {
  return {
    updateId: data.updateId,
    updateType: data.updateType,
    chatId: data.chatId,
    messageId: data.messageId,
    mediaGroupId: data.mediaGroupId,
    stageId: data.stageId,
    status: data.status,
    attempts: data.attempts,
    receivedAtMs: data.receivedAtMs,
    nextAttemptAtMs: data.nextAttemptAtMs,
    lastError: data.lastError ?? null,
  };
}

async function main(): Promise<void> {
  if (command === 'inspect' && updateId) {
    const snap = await inbox.doc(updateId).get();
    if (!snap.exists) throw new Error(`inbound update ${updateId} was not found`);
    console.log(JSON.stringify(printable(snap.data()!), null, 2));
    return;
  }

  if (command === 'list') {
    const snap = await inbox.where('status', '==', 'dead_letter').limit(100).get();
    console.log(JSON.stringify(snap.docs.map(doc => printable(doc.data())), null, 2));
    return;
  }

  if (command === 'retry' && updateId) {
    const ref = inbox.doc(updateId);
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error(`inbound update ${updateId} was not found`);
      const data = snap.data()!;
      const status = data.status;
      if (!['dead_letter', 'retry'].includes(status)) {
        throw new Error(`inbound update ${updateId} is ${status}; only retry/dead_letter may be retried`);
      }
      const albumRef = data.albumRefId ? db.collection(ALBUM_COLLECTION).doc(data.albumRefId) : null;
      const albumSnap = albumRef ? await tx.get(albumRef) : null;
      const updateIds = albumSnap?.exists ? (albumSnap.data()?.updateIds as number[] ?? [Number(updateId)]) : [Number(updateId)];
      const refs = updateIds.map(id => inbox.doc(String(id)));
      const snaps = await Promise.all(refs.map(item => tx.get(item)));
      for (const [index, item] of refs.entries()) {
        if (!['dead_letter', 'retry'].includes(snaps[index].data()?.status)) continue;
        tx.update(item, {
          status: 'pending',
          nextAttemptAtMs: Date.now(),
          workerToken: null,
          manualRetryAt: FieldValue.serverTimestamp(),
          manualRetryBy: env.firebase.clientEmail,
        });
      }
      if (albumRef && albumSnap?.exists) {
        tx.update(albumRef, {
          status: 'assembling',
          nextAttemptAtMs: Date.now(),
          workerToken: null,
          manualRetryAt: FieldValue.serverTimestamp(),
        });
      }
      tx.set(db.collection('telegramRecoveryAudit').doc(), {
        action: 'retry',
        updateId: Number(updateId),
        previousStatus: status,
        actor: env.firebase.clientEmail,
        at: FieldValue.serverTimestamp(),
      });
    });
    console.log(JSON.stringify({ updateId: Number(updateId), status: 'pending', audited: true }));
    return;
  }

  if (command === 'cleanup') {
    const now = Timestamp.now();
    const [updates, albumDocs] = await Promise.all([
      inbox.where('expireAt', '<=', now).limit(400).get(),
      db.collection(ALBUM_COLLECTION).where('expireAt', '<=', now).limit(80).get(),
    ]);
    const batch = db.batch();
    for (const doc of updates.docs) batch.delete(doc.ref);
    for (const doc of albumDocs.docs) batch.delete(doc.ref);
    batch.set(db.collection('telegramRecoveryAudit').doc(), {
      action: 'cleanup',
      updateCount: updates.size,
      albumCount: albumDocs.size,
      actor: env.firebase.clientEmail,
      at: FieldValue.serverTimestamp(),
    });
    await batch.commit();
    console.log(JSON.stringify({ deletedUpdates: updates.size, deletedAlbums: albumDocs.size, audited: true }));
    return;
  }

  throw new Error('usage: npm run recovery -- list | inspect <updateId> | retry <updateId> | cleanup');
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
