import dotenv from 'dotenv';
import admin from 'firebase-admin';

dotenv.config();

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}

const db = admin.firestore();

async function backfill() {
  console.log('--- Backfilling cancelledBy for cancelled subscriptions in subscriptionRecords ---');
  const subsSnap = await db.collection('subscriptions').where('status', '==', 'cancelled').get();
  console.log(`Found ${subsSnap.docs.length} cancelled subscriptions in subscriptions collection.`);

  let updatedCount = 0;
  for (const doc of subsSnap.docs) {
    const data = doc.data();
    const auditedId = data.auditedRecordId || doc.id;
    if (!auditedId) continue;

    const recordRef = db.collection('subscriptionRecords').doc(auditedId);
    const recordSnap = await recordRef.get();
    if (recordSnap.exists) {
      const recordData = recordSnap.data();
      if (!recordData?.cancelledBy) {
        console.log(`Updating record ${auditedId} for student ${data.userEmail || data.userName}...`);
        await recordRef.update({
          cancelledBy: {
            recordId: data.terminatedByRecord || 'backfilled_cancellation',
            referenceCode: 'TRM-LEGACY',
            createdAt: data.updatedAt || admin.firestore.Timestamp.now(),
          },
          updatedAt: admin.firestore.Timestamp.now(),
        });
        updatedCount++;
      }
    }
  }

  console.log(`--- Finished. Updated ${updatedCount} subscriptionRecords documents with cancelledBy. ---`);
}

backfill().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
