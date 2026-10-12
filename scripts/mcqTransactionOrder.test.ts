import fs from 'node:fs';

const source = fs.readFileSync('src/services/mcqAnswerService.ts', 'utf8');
const start = source.indexOf('await transactionRunner(targetDb, async (transaction) => {');
const end = source.indexOf('\n    });', start);
if (start < 0 || end < 0) throw new Error('finalizeFirstAttempt transaction not found');
const body = source.slice(start, end);
const firstWrite = Math.min(
  ...['transaction.set(', 'transaction.update(', 'transaction.delete(']
    .map(token => body.indexOf(token))
    .filter(index => index >= 0),
);
const lastRead = body.lastIndexOf('transaction.get(');

if (!Number.isFinite(firstWrite) || lastRead < 0 || firstWrite <= lastRead) {
  throw new Error(`Firestore transaction ordering regressed: first write=${firstWrite}, last read=${lastRead}`);
}
if (!source.includes("enqueue('first'")) {
  throw new Error('First-attempt network failures are not queued');
}
console.log('PASS  finalizeFirstAttempt performs every read before its first write');
console.log('PASS  first-attempt offline submissions are queued');
