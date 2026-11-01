import 'dotenv/config';
import { normalizePrivateKey } from '../bot/src/privateKey.ts';
import { GoogleAuth } from 'google-auth-library';

const pk = normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY);
const auth = new GoogleAuth({
  credentials: {
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    private_key: pk,
  },
  scopes: ['https://www.googleapis.com/auth/datastore'],
});
const client = await auth.getClient();
const token = await client.getAccessToken();

console.log('Querying all lectures with telegramPost.status == pending...');

const res = await fetch(`https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    structuredQuery: {
      from: [{ collectionId: 'lectures' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'telegramPost.status' },
          op: 'EQUAL',
          value: { stringValue: 'pending' }
        }
      }
    }
  })
});

const list = await res.json();
const stalled = list.filter(item => Boolean(item.document));
console.log(`Found ${stalled.length} stalled lecture(s).`);

for (const item of stalled) {
  const docName = item.document.name;
  const lectureId = docName.split('/').pop();
  const fields = item.document.fields;
  console.log(`Resetting stalled lecture: ${lectureId} ("${fields?.title?.stringValue}")`);

  // Reset telegramPost to null so button unlocks and can be shared cleanly
  const patchRes = await fetch(`https://firestore.googleapis.com/v1/${docName}?updateMask.fieldPaths=telegramPost&updateMask.fieldPaths=telegramShareRequestedAt`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        telegramPost: { nullValue: null }
      }
    })
  });
  const patched = await patchRes.json();
  console.log(`Reset result for ${lectureId}:`, patched.name ? 'SUCCESS' : patched);
}

console.log('Sweep completed.');

