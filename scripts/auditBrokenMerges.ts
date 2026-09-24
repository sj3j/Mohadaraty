import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { nameKeyFor } from '../shared/rosterIdentity.js';
import 'dotenv/config';

const argv = process.argv.slice(2);
const commit = argv.includes('--commit');

const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
  console.error('.env is missing FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY.');
  process.exit(1);
}
initializeApp({
  credential: cert({
    projectId: FIREBASE_PROJECT_ID,
    clientEmail: FIREBASE_CLIENT_EMAIL,
    privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
  projectId: FIREBASE_PROJECT_ID,
});
const db = getFirestore();

async function main() {
  console.log(`\nAudit Target: project ${FIREBASE_PROJECT_ID}`);
  console.log(commit ? 'Mode: COMMIT - Auto-fixing safe chains\n' : 'Mode: DRY RUN - No mutations\n');

  const snap = await db.collection('students').get();
  const students = new Map<string, any>();
  snap.docs.forEach(doc => students.set(doc.id.toLowerCase(), doc.data()));

  const chains: any[] = [];
  const orphans: any[] = [];
  const liveDuplicates = new Map<string, any[]>();

  // Helper to trace a chain to its final destination safely
  const resolveChain = (startId: string) => {
    let currentId = startId;
    const visited = new Set<string>();
    
    while (true) {
      if (visited.has(currentId)) return { error: 'cycle', path: Array.from(visited) };
      visited.add(currentId);
      
      const doc = students.get(currentId);
      if (!doc) return { error: 'missing', path: Array.from(visited) };
      
      const target = (doc.mergedInto || '').trim().toLowerCase();
      if (!target || target === currentId) {
        return { 
          target: currentId, 
          path: Array.from(visited),
          isActive: doc.isActive !== false 
        };
      }
      currentId = target;
    }
  };

  for (const [id, data] of students.entries()) {
    if (data.mergedInto) {
      const target = data.mergedInto.trim().toLowerCase();
      const resolution = resolveChain(id);
      
      if (resolution.error === 'missing') {
        orphans.push({ id, target, path: resolution.path.join(' -> ') });
      } else if (resolution.error === 'cycle') {
        chains.push({ id, issue: 'CYCLE', path: resolution.path.join(' -> ') });
      } else if (resolution.path && resolution.path.length > 2) {
        // Chain detected: A -> B -> C
        chains.push({ 
          id, 
          issue: 'CHAIN', 
          path: resolution.path.join(' -> '),
          finalTarget: resolution.target,
          finalIsActive: resolution.isActive 
        });
      }
    } else {
      // Live document (no mergedInto)
      if (data.isActive !== false) {
        // Group strictly by nameKey, explicitly ignoring examCode for safety
        const nameK = nameKeyFor(data.name || data.originalName);
        if (nameK) {
          if (!liveDuplicates.has(nameK)) liveDuplicates.set(nameK, []);
          liveDuplicates.get(nameK)!.push({ id, email: data.email, name: data.name, stageId: data.stageId });
        }
      }
    }
  }

  // Filter out non-duplicates
  const actualDuplicates = Array.from(liveDuplicates.entries())
    .filter(([_, docs]) => docs.length > 1)
    .map(([key, docs]) => ({ nameKey: key, accounts: docs.map(d => d.id).join(', '), count: docs.length }));

  console.log('=== BROKEN POINTERS (ORPHANS) ===');
  if (orphans.length === 0) console.log('None found.');
  else console.table(orphans);

  console.log('\n=== MERGE CHAINS (A -> B -> C) ===');
  if (chains.length === 0) console.log('None found.');
  else console.table(chains);

  console.log('\n=== UNMERGED DUPLICATES (By Name) ===');
  console.log('NOTE: Explicitly ignoring examCode per safety guidelines.');
  if (actualDuplicates.length === 0) console.log('None found.');
  else console.table(actualDuplicates);

  // Auto-fix chains if commit flag is passed
  const fixableChains = chains.filter(c => c.issue === 'CHAIN' && c.finalIsActive);
  if (commit && fixableChains.length > 0) {
    console.log(`\nAuto-fixing ${fixableChains.length} chains...`);
    // Firestore batches are limited to 500 operations.
    const BATCH_LIMIT = 500;
    for (let i = 0; i < fixableChains.length; i += BATCH_LIMIT) {
      const chunk = fixableChains.slice(i, i + BATCH_LIMIT);
      const batch = db.batch();
      for (const chain of chunk) {
        // Point the origin directly to the final active survivor
        batch.set(db.collection('students').doc(chain.id), {
          mergedInto: chain.finalTarget,
          mergedAt: new Date().toISOString()
        }, { merge: true });
      }
      await batch.commit();
      console.log(`  Committed batch ${Math.floor(i / BATCH_LIMIT) + 1} (${chunk.length} ops)`);
    }
    console.log('Chains flattened successfully.');
  } else if (!commit && fixableChains.length > 0) {
    console.log(`\nRun with --commit to flatten ${fixableChains.length} chains directly to their active survivor.`);
  }
}

main().catch(console.error);
