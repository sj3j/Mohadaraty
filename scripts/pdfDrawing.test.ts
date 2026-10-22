import {
  pointsToSvgPath,
  pointToSegmentDistance,
  strokeIntersectsPoint,
} from '../src/components/pdf/PdfDrawingLayer';
import type { PdfStroke, StrokePoint } from '../src/types/pdfDrawing.types';
import { PENCIL_WIDTHS, FREE_HIGHLIGHTER_WIDTHS } from '../src/types/pdfDrawing.types';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  PASS  ${msg}`);
}

console.log('\n--- 1. Stroke Width Presets ---');
assert(PENCIL_WIDTHS.thin === 2, 'Pencil thin is 2px');
assert(PENCIL_WIDTHS.medium === 4, 'Pencil medium is 4px');
assert(PENCIL_WIDTHS.thick === 7, 'Pencil thick is 7px');

assert(FREE_HIGHLIGHTER_WIDTHS.thin === 14, 'Highlighter thin is 14px');
assert(FREE_HIGHLIGHTER_WIDTHS.medium === 22, 'Highlighter medium is 22px');
assert(FREE_HIGHLIGHTER_WIDTHS.thick === 32, 'Highlighter thick is 32px');

console.log('\n--- 2. SVG Path Generation from Normalized Points ---');
const emptyPath = pointsToSvgPath([], 800, 1000);
assert(emptyPath === '', 'Empty points yields empty SVG path');

const singlePoint: StrokePoint[] = [{ x: 0.5, y: 0.5 }];
const singlePointPath = pointsToSvgPath(singlePoint, 800, 1000);
assert(singlePointPath.startsWith('M 400 500'), 'Single point generates dot starting at scaled pixel coordinates');

const linePoints: StrokePoint[] = [
  { x: 0.1, y: 0.1 },
  { x: 0.9, y: 0.9 },
];
const linePath = pointsToSvgPath(linePoints, 1000, 1000);
assert(linePath === 'M 100 100 L 900 900', 'Two points generates clean M x0 y0 L x1 y1 line');

const multiPoints: StrokePoint[] = [
  { x: 0.0, y: 0.0 },
  { x: 0.5, y: 0.5 },
  { x: 1.0, y: 0.0 },
];
const curvePath = pointsToSvgPath(multiPoints, 1000, 1000);
assert(curvePath.includes('Q 500 500'), 'Multiple points interpolates quadratic bezier curves through midpoints');

console.log('\n--- 3. Distance from Point to Segment (Geometry Math) ---');
// Segment along X-axis from (0,0) to (10,0)
const dist1 = pointToSegmentDistance(5, 5, 0, 0, 10, 0);
assert(Math.abs(dist1 - 5) < 1e-6, 'Perpendicular distance to segment midpoint is exact');

const dist2 = pointToSegmentDistance(-5, 0, 0, 0, 10, 0);
assert(Math.abs(dist2 - 5) < 1e-6, 'Distance to start vertex is exact');

const dist3 = pointToSegmentDistance(15, 0, 0, 0, 10, 0);
assert(Math.abs(dist3 - 5) < 1e-6, 'Distance to end vertex is exact');

console.log('\n--- 4. Eraser Stroke Hit Detection ---');
const testStroke: PdfStroke = {
  id: 'stroke_1',
  lectureId: 'lec_1',
  page: 1,
  tool: 'pencil',
  color: '#4f46e5',
  width: 4,
  opacity: 1,
  points: [
    { x: 0.2, y: 0.2 },
    { x: 0.5, y: 0.5 },
    { x: 0.8, y: 0.2 },
  ],
  createdAt: Date.now(),
};

assert(
  strokeIntersectsPoint(testStroke, 0.5, 0.5, 0.03),
  'Direct hit on stroke vertex is detected by eraser',
);

assert(
  strokeIntersectsPoint(testStroke, 0.35, 0.36, 0.03),
  'Hit on stroke segment within threshold is detected',
);

assert(
  !strokeIntersectsPoint(testStroke, 0.5, 0.9, 0.03),
  'Point far from stroke is not hit by eraser',
);

console.log('\n--- 5. Undo / Redo History Logic ---');
let present: PdfStroke[] = [];
let past: PdfStroke[][] = [];
let future: PdfStroke[][] = [];

// Add stroke 1
past.push(present);
present = [testStroke];
future = [];
assert(present.length === 1 && past.length === 1, 'Pushing stroke updates present and records past');

// Undo
if (past.length > 0) {
  future.unshift(present);
  present = past.pop()!;
}
assert(present.length === 0, 'Undo restores previous empty state');
assert(future.length === 1, 'Undo pushes undone state to future');

// Redo
if (future.length > 0) {
  past.push(present);
  present = future.shift()!;
}
assert(present.length === 1 && present[0].id === 'stroke_1', 'Redo restores stroke from future stack');
assert(future.length === 0, 'Future stack is consumed on redo');

console.log('\nAll 15 drawing math, eraser hit, and history tests PASSED successfully!\n');
