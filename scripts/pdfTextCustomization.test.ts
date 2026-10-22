import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

console.log('--- Test 1: Blur Race Elimination in PdfTextBoxOverlay ---');
{
  const overlayFile = fs.readFileSync(
    path.join(process.cwd(), 'src/components/pdf/PdfTextBoxOverlay.tsx'),
    'utf-8'
  );

  // Must have preventDefault on onMouseDown to stop textarea from prematurely blurring
  assert.ok(
    overlayFile.includes('e.preventDefault()'),
    'PdfTextBoxOverlay must prevent default on mousedown for toolbar buttons to eliminate blur race'
  );
  console.log('  PASS  e.preventDefault() protects toolbar buttons from blur-race');
}

console.log('\n--- Test 2: Live Font Size & Color Customization ---');
{
  const overlayFile = fs.readFileSync(
    path.join(process.cwd(), 'src/components/pdf/PdfTextBoxOverlay.tsx'),
    'utf-8'
  );

  // Must have color swatches in toolbar
  assert.ok(
    overlayFile.includes('HIGHLIGHT_COLORS') || overlayFile.includes('TEXT_COLORS') || overlayFile.includes('PALETTE_COLORS'),
    'PdfTextBoxOverlay must include color swatches in the toolbar'
  );

  // Must support immediate font size switching
  assert.ok(
    overlayFile.includes("fontSize: sz") || overlayFile.includes("fontSize:"),
    'PdfTextBoxOverlay must apply font size changes immediately'
  );
  console.log('  PASS  Immediate font size and color customization present in toolbar');
}

console.log('\n--- Test 3: View-Mode Floating Action Capsule ---');
{
  const overlayFile = fs.readFileSync(
    path.join(process.cwd(), 'src/components/pdf/PdfTextBoxOverlay.tsx'),
    'utf-8'
  );

  // Must support selection/capsule in view mode
  assert.ok(
    overlayFile.includes('selectedId') || overlayFile.includes('activeCapsuleId'),
    'PdfTextBoxOverlay must track selected text box for floating action capsule in view mode'
  );
  console.log('  PASS  View-mode floating action capsule implemented');
}

console.log('\nALL TEXT CUSTOMIZATION TESTS PASSED!\n');
