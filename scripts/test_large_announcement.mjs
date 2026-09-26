import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, arrayUnion } from 'firebase/firestore';
import { readFileSync } from 'fs';

async function run() {
  const env = await initializeTestEnvironment({
    projectId: 'mylectures-rules-test',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') }
  });

  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const blocks = [];
    for (let i = 0; i < 50; i++) {
      blocks.push({ id: `block_${i}`, type: 'text', content: 'test '.repeat(50), attrs: { bold: true, italic: false } });
    }
    await setDoc(doc(db, 'announcements/ann_large'), {
      stageId: 'stage_1',
      content: 'Large announcement',
      richBlocks: blocks,
      reactions: {}
    });
    await setDoc(doc(db, 'students/stu@example.com'), { role: 'student', stageId: 'stage_1', isActive: true });
  });

  const stuCtx = env.authenticatedContext('stu_uid', { email: 'stu@example.com' });
  try {
    await assertSucceeds(updateDoc(doc(stuCtx.firestore(), 'announcements/ann_large'), { 'reactions.👍': arrayUnion('stu_uid') }));
    console.log("PASS: large announcement reaction succeeded");
  } catch (e) {
    console.error("FAIL: large announcement reaction failed!", e);
  }

  await env.cleanup();
}
run();
