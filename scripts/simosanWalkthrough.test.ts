/**
 * Automated test suite for Simosan Walkthrough & Flicker Fix.
 * Run with: npx tsx scripts/simosanWalkthrough.test.ts
 */

import { readFileSync } from 'fs';
import { join } from 'path';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok    ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
    failed++;
  }
}

const root = join(import.meta.dirname, '..');

console.log('\n--- 1. Vite Watcher Ignored Configuration ---');

const viteConfig = readFileSync(join(root, 'vite.config.ts'), 'utf8');

check(
  'vite.config.ts ignores android directory from file watching',
  viteConfig.includes("**/android/**")
);

check(
  'vite.config.ts ignores ios directory from file watching',
  viteConfig.includes("**/ios/**")
);

check(
  'vite.config.ts ignores .gradle directory from file watching',
  viteConfig.includes("**/.gradle/**")
);

check(
  'vite.config.ts ignores reports directory from file watching',
  viteConfig.includes("**/reports/**")
);

console.log('\n--- 2. Walkthrough Prompt Auto-Detection Pattern ---');

const walkthroughRegex = /اشرح.*(?:محاضرة|أجزاء|جزء|بالكامل)/i;

const testPhrases = [
  { text: 'اشرح لي هذه المحاضرة جزءً جزءً', expected: true },
  { text: 'اشرح لي هذه المحاضرة بالكامل، جزءاً جزءاً.', expected: true },
  { text: 'اشرح المحاضرة أجزاء', expected: true },
  { text: 'اشرح لي المحاضرة بالتفصيل', expected: true },
  { text: 'اشرح الجزء الأول', expected: true },
  { text: 'ما هو الـ bioavailability؟', expected: false },
  { text: 'شكراً جزيلاً', expected: false },
];

for (const { text, expected } of testPhrases) {
  check(
    `Walkthrough regex correctly classifies: "${text}" -> ${expected}`,
    walkthroughRegex.test(text) === expected
  );
}

console.log('\n--- 3. SimosanDrawer Implementation Contracts ---');

const drawerCode = readFileSync(join(root, 'src/components/pdf/SimosanDrawer.tsx'), 'utf8');

check(
  'SimosanDrawer automatically detects walkthrough in send()',
  drawerCode.includes('opts.walkthrough ?? /اشرح.*(?:محاضرة|أجزاء|جزء|بالكامل)/i.test(text)')
);

check(
  'SimosanDrawer commits completed model message immediately in onDone',
  drawerCode.includes("id: tempModelId, role: 'model', text: finalAnswer")
);

check(
  'SimosanDrawer guards streaming bubble so it does not collapse to 3 dots when done',
  drawerCode.includes("streaming || (busy && messages[messages.length - 1]?.role === 'user')")
);

check(
  'SimosanDrawer includes smart scroll physics with distanceToBottom check',
  drawerCode.includes('isNearBottomRef.current = distanceToBottom < 140')
);

check(
  'SimosanDrawer offers continuation chips for next lecture parts',
  drawerCode.includes('اشرح الجزء التالي') && drawerCode.includes('وضّح بأمثلة سريرية')
);

check(
  'SimosanDrawer includes copy button for assistant explanations',
  drawerCode.includes('handleCopy') && drawerCode.includes('navigator.clipboard?.writeText')
);

console.log(`\nResults: ${passed} passed, ${failed} failed.\n`);
if (failed > 0) {
  process.exit(1);
}
