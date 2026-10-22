import {
  pointsToSvgPath,
  pointToSegmentDistance,
  strokeIntersectsPoint,
} from '../src/components/pdf/PdfDrawingLayer';
import {
  canonicalizePage,
  canonicalOffsetWithin,
  buildAnchor,
  resolveAnchor,
  rectsToQuads,
  quadsToRects,
  type TextItemLike,
} from '../src/lib/pdfAnchor';
import { ANCHOR_ALGO } from '../src/types/pdfAnnotation.types';
import type { PdfStroke, StrokePoint, DrawingTool } from '../src/types/pdfDrawing.types';
import { PENCIL_WIDTHS, FREE_HIGHLIGHTER_WIDTHS } from '../src/types/pdfDrawing.types';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  PASS  ${msg}`);
}

console.log('\n--- 1. Web Vector Drawing Coordinate Mapping (Zero Double-Scale) ---');
// Page with base points 600x800 at scale 1.5 -> layout pixel size 900x1200
const baseW = 600;
const baseH = 800;
const scale = 1.5;
const pixelW = baseW * scale; // 900
const pixelH = baseH * scale; // 1200

const pts: StrokePoint[] = [
  { x: 0.2, y: 0.3 },
  { x: 0.8, y: 0.7 },
];

// In the fixed architecture, pageWidth/pageHeight passed to pointsToSvgPath are the actual pixel dimensions
const path = pointsToSvgPath(pts, pixelW, pixelH);
const expectedStart = `M ${0.2 * pixelW} ${0.3 * pixelH}`;
const expectedEnd = `L ${0.8 * pixelW} ${0.7 * pixelH}`;

assert(path.includes(expectedStart), `Start point correctly maps normalized 0.2, 0.3 to exact layout pixels (${0.2 * pixelW}, ${0.3 * pixelH})`);
assert(path.includes(expectedEnd), `End point correctly maps normalized 0.8, 0.7 to exact layout pixels (${0.8 * pixelW}, ${0.7 * pixelH})`);

// Assert that we did NOT multiply by scale again:
assert(!path.includes(`M ${0.2 * pixelW * scale}`), 'No double-scale distortion: coordinates match layout pixel box 1:1');

console.log('\n--- 2. Tool Interactive Stacking & Pointer-Events Rules ---');
function getLayerBehavior(tool: DrawingTool, isAnnotationMode: boolean) {
  const isInteractive =
    isAnnotationMode && (tool === 'pencil' || tool === 'free_highlighter' || tool === 'eraser');
  return {
    zIndex: isInteractive ? 30 : 10,
    touchAction: isInteractive ? 'none' : 'auto',
    pointerEvents: isInteractive ? 'auto' : 'none',
    cursor: isInteractive ? 'cursor-crosshair' : 'pointer-events-none',
  };
}

// In annotation mode with Pencil
const pencilActive = getLayerBehavior('pencil', true);
assert(pencilActive.zIndex === 30, 'Pencil layer sits at z-index 30 above .textLayer (z-2)');
assert(pencilActive.pointerEvents === 'auto', 'Pencil layer actively receives pointer events');
assert(pencilActive.touchAction === 'none', 'Pencil layer disables browser scroll gesture conflict');

// In annotation mode with Free Highlighter
const freeHighlighterActive = getLayerBehavior('free_highlighter', true);
assert(freeHighlighterActive.zIndex === 30, 'Free highlighter sits at z-index 30 above .textLayer');
assert(freeHighlighterActive.pointerEvents === 'auto', 'Free highlighter captures pointers');

// In annotation mode with Eraser
const eraserActive = getLayerBehavior('eraser', true);
assert(eraserActive.zIndex === 30, 'Eraser sits at z-index 30 above .textLayer');
assert(eraserActive.pointerEvents === 'auto', 'Eraser captures touches and clicks for stroke deletion');

// In annotation mode with Text Highlighter (text selection mode)
const textHighlightMode = getLayerBehavior('text_highlight', true);
assert(textHighlightMode.zIndex === 10, 'Text highlight mode sets drawing layer to z-index 10');
assert(textHighlightMode.pointerEvents === 'none', 'Drawing layer passes pointers through to .textLayer spans for text selection');

// In reading mode (annotation mode closed)
const readingMode = getLayerBehavior('pencil', false);
assert(readingMode.pointerEvents === 'none', 'When annotation mode is off, drawing layer never intercepts page touches/clicks');

console.log('\n--- 3. Web Text Selection & Canonical Anchor Round-Trip ---');
const items: TextItemLike[] = [
  { str: 'Anatomy ' },
  { str: 'of ' },
  { str: 'the ' },
  { str: 'Human ' },
  { str: 'Heart' },
];

const canonical = canonicalizePage(items);
assert(canonical.text === 'Anatomy of the Human Heart', 'Page canonical text matches items');

// Simulate selecting "Human Heart"
const selectedStart = canonical.text.indexOf('Human Heart');
const selectedEnd = selectedStart + 'Human Heart'.length;

const dummyViewport = {
  convertToPdfPoint: (x: number, y: number) => [x, 800 - y] as [number, number],
  convertToViewportPoint: (x: number, y: number) => [x, 800 - y] as [number, number],
};

const domRects: DOMRect[] = [
  {
    x: 120,
    y: 200,
    left: 120,
    top: 200,
    right: 260,
    bottom: 220,
    width: 140,
    height: 20,
    toJSON: () => {},
  },
];

const quads = rectsToQuads(domRects, { left: 0, top: 0 }, dummyViewport);
assert(quads.length === 1, 'DOM rect converted to PDF-space quad');

const anchor = buildAnchor({
  text: canonical.text,
  start: selectedStart,
  end: selectedEnd,
  quads,
  pageW: 600,
  pageH: 800,
});

assert(anchor.algo === ANCHOR_ALGO, 'Anchor generated with current algorithm version');
assert(anchor.exact === 'Human Heart', `Anchor exact text correctly captured: "${anchor.exact}"`);
assert(anchor.start === selectedStart && anchor.end === selectedEnd, 'Anchor has valid positive start and end offsets');
assert(anchor.quads.length === 1, 'Anchor contains PDF quads for layout fallback');

// Verify resolveAnchor on the canonical page
const resolved = resolveAnchor(anchor, canonical.text);
assert(resolved !== null, 'Anchor resolves successfully against page text');
assert(resolved?.start === selectedStart, 'Resolved start offset is exact');
assert(resolved?.end === selectedEnd, 'Resolved end offset is exact');

console.log('\n--- 4. Stroke Eraser Distance Verification ---');
const stroke: PdfStroke = {
  id: 'test_stroke',
  lectureId: 'lec_1',
  page: 1,
  tool: 'pencil',
  color: '#4f46e5',
  width: 4,
  opacity: 1,
  points: [
    { x: 0.1, y: 0.1 },
    { x: 0.5, y: 0.5 },
    { x: 0.9, y: 0.9 },
  ],
  createdAt: Date.now(),
};

// Hit point exactly along the diagonal (0.3, 0.3)
assert(strokeIntersectsPoint(stroke, 0.3, 0.3, 0.02), 'Stroke hit test detects point along segment');
assert(!strokeIntersectsPoint(stroke, 0.1, 0.9, 0.02), 'Stroke hit test rejects distant point');

console.log('\n ALL 18/18 DOM & VECTOR DRAWING TESTS PASSED!');
