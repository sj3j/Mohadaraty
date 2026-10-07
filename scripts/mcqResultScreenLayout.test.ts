/**
 * Layout and responsiveness regression test for MCQResultScreen.
 *
 * Verifies that:
 * 1. The scroll container does not use destructive `justify-center` which causes flexbox overflow clipping.
 * 2. Safe-area inset bottom padding is respected for Android navigation bars & iOS home bars.
 * 3. The aesthetic return button with `ArrowRight` icon is preserved with its neat styling.
 * 4. Responsive sizing classes are used (avoiding static large margins/paddings that blow past 700px viewport heights).
 *
 * Run with:
 *   npx tsx scripts/mcqResultScreenLayout.test.ts
 */
import fs from 'fs';
import path from 'path';

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, extra?: any) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}${extra !== undefined ? ` (details: ${JSON.stringify(extra)})` : ''}`);
  }
}

async function run() {
  console.log('--- Checking MCQResultScreen.tsx Responsive Layout & Boundaries ---');

  const filePath = path.resolve(process.cwd(), 'src/components/mcq/MCQResultScreen.tsx');
  const content = fs.readFileSync(filePath, 'utf-8');

  // Check 1: No destructive `justify-center` on scrollable flex container
  const hasUnsafeJustifyCenter = /flex-1\s+flex\s+flex-col\s+justify-center/.test(content);
  check('Container avoids unsafe `flex-1 flex flex-col justify-center` inside overflow-y-auto', !hasUnsafeJustifyCenter);

  // Check 2: Bottom safe area inset padding
  const hasSafeAreaBottom = content.includes('safe-area-inset-bottom');
  check('Container includes safe-area-inset-bottom padding for mobile navigation bars', hasSafeAreaBottom);

  // Check 3: Return button exists and preserves ArrowRight icon
  const hasReturnButton = content.includes('العودة للمحاضرات') || content.includes('الرجوع إلى المحاضرة');
  const hasArrowIcon = content.includes('ArrowRight');
  check('Preserves aesthetic return button with ArrowRight icon', hasReturnButton && hasArrowIcon);

  // Check 4: Responsive circle and card padding
  const hasResponsiveCircle = /w-3[2-6]\s+h-3[2-6]|sm:w-4[4-8]/.test(content);
  check('Score circle has responsive sizing for compact mobile screens', hasResponsiveCircle);

  // Check 5: Overlay height dynamic viewport support
  const overlayPath = path.resolve(process.cwd(), 'src/components/MCQOverlay.tsx');
  const overlayContent = fs.readFileSync(overlayPath, 'utf-8');
  const hasDvhSupport = overlayContent.includes('100dvh');
  check('MCQOverlay supports 100dvh to prevent viewport overflow on mobile browsers', hasDvhSupport);

  console.log(`\n========================================`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  console.log(`========================================\n`);

  process.exit(failed ? 1 : 0);
}

run().catch((e) => {
  console.error('Test execution failed:', e);
  process.exit(1);
});
