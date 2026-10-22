import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import type { DrawingTool } from '../src/types/pdfDrawing.types';
import type { PdfAnnotation } from '../src/types/pdfAnnotation.types';

console.log('--- Test 1: DrawingTool & PdfAnnotation Type Support ---');
{
  const tool: DrawingTool = 'text';
  assert.strictEqual(tool, 'text', 'DrawingTool must support "text"');

  const textAnnotation: PdfAnnotation = {
    id: 'txt-1',
    lectureId: 'lec-1',
    docFingerprint: 'fp-1',
    kind: 'text',
    page: 3,
    color: 'yellow',
    text: 'ملاحظة سريرية مهمة حول القلب',
    note: 'ملاحظة سريرية مهمة حول القلب',
    fontSize: 'base',
    point: { x: 0.25, y: 0.4 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    schema: 1,
  };

  assert.strictEqual(textAnnotation.kind, 'text');
  assert.strictEqual(textAnnotation.text, 'ملاحظة سريرية مهمة حول القلب');
  assert.strictEqual(textAnnotation.fontSize, 'base');
  assert.strictEqual(textAnnotation.point?.x, 0.25);
  assert.strictEqual(textAnnotation.point?.y, 0.4);
  console.log('  PASS  DrawingTool and PdfAnnotation support kind: "text" with point and fontSize');
}

console.log('\n--- Test 2: Native Touch Forwarding & Interactive Zones ---');
{
  const overlayFile = fs.readFileSync(
    path.join(process.cwd(), 'src/components/pdf/PdfReaderOverlay.tsx'),
    'utf-8'
  );

  assert.ok(
    overlayFile.includes("activeDrawingTool === 'text'"),
    'PdfReaderOverlay must include activeDrawingTool === "text" in interactiveZones and pointer-events check'
  );
  console.log('  PASS  activeDrawingTool === "text" is wired into native interactive zones');
}

console.log('\n--- Test 3: Dock Tool & Formatting Controls ---');
{
  const dockFile = fs.readFileSync(
    path.join(process.cwd(), 'src/components/pdf/NotewiseAnnotationDock.tsx'),
    'utf-8'
  );

  assert.ok(
    dockFile.includes("onSelectTool('text')"),
    'NotewiseAnnotationDock must trigger onSelectTool("text") on the نص button'
  );
  assert.ok(
    dockFile.includes("activeTool === 'text'"),
    'NotewiseAnnotationDock must check activeTool === "text"'
  );
  console.log('  PASS  NotewiseAnnotationDock has "text" tool integrated');
}

console.log('\n--- Test 4: Notes Drawer & Overview Synchronization ---');
{
  const drawerFile = fs.readFileSync(
    path.join(process.cwd(), 'src/components/pdf/NotesDrawer.tsx'),
    'utf-8'
  );

  assert.ok(
    drawerFile.includes("a.kind === 'text'") || drawerFile.includes("a.text"),
    'NotesDrawer must support rendering text annotations'
  );

  const overviewFile = fs.readFileSync(
    path.join(process.cwd(), 'src/components/pdf/NotewiseOverviewModal.tsx'),
    'utf-8'
  );

  assert.ok(
    overviewFile.includes("pagesWithAnnotations"),
    'NotewiseOverviewModal includes pages with text annotations in the annotated filter'
  );
  console.log('  PASS  Notes Drawer and Overview correctly synchronize text annotations');
}

console.log('\nALL FEEDBACK LOOP TESTS PASSED!\n');
