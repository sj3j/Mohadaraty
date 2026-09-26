const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'test' });
const db = admin.firestore();
async function test() {
  const ref = db.collection('test').doc('test1');
  await ref.set({ a: 1 });
  try {
    await ref.update({ 'reactions.emoji': admin.firestore.FieldValue.arrayUnion('uid') });
    console.log("Success");
  } catch (e) {
    console.log("Error:", e.message);
  }
}
test();
