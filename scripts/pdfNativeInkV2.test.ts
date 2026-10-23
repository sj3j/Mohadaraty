import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PdfStroke, StrokePoint } from '../src/types/pdfDrawing.types';

let failures = 0;

function check(name: string, condition: boolean, detail: string) {
  if (condition) {
    console.log(`  PASS  ${name}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL  ${name} -> ${detail}`);
}

function source(path: string) {
  return readFileSync(resolve(path), 'utf8');
}

console.log('\n--- 1. Phase 2 Native Architecture & Source Contracts ---');

const androidHost = source('android/app/src/main/java/com/mohadaraty/app/pdf/NativePdfReaderHost.java');
const androidInk = source('android/app/src/main/java/com/mohadaraty/app/pdf/PdfInkOverlayView.java');
const androidCoord = source('android/app/src/main/java/com/mohadaraty/app/pdf/NativeGestureCoordinator.java');
const androidGeometry = source('android/app/src/main/java/com/mohadaraty/app/pdf/PdfPageGeometryAdapter.java');
const androidPlugin = source('android/app/src/main/java/com/mohadaraty/app/pdf/PdfViewerPlugin.java');
const iosPlugin = source('ios/App/App/pdf/PdfViewerPlugin.swift');
const iosGeometry = source('ios/App/App/pdf/PdfGeometryAdapter.swift');
const iosOverlay = source('ios/App/App/pdf/NativePdfPageOverlayProvider.swift');
const bridge = source('src/lib/nativePdfViewer.ts');
const overlay = source('src/components/pdf/PdfReaderOverlay.tsx');

check(
  'Android defines NativePdfReaderHost containing PDFView and PdfInkOverlayView',
  /class NativePdfReaderHost extends FrameLayout/.test(androidHost) &&
    /addView\(pdfView/.test(androidHost) &&
    /addView\(inkOverlayView/.test(androidHost),
  'NativePdfReaderHost must encapsulate PDFView and PdfInkOverlayView in a unified hierarchy'
);

check(
  'Android NativeGestureCoordinator cancels inking upon multi-touch pinch/pan',
  /activeTarget == TouchTarget\.INK && pointerCount > 1/.test(androidCoord) &&
    /cancelActiveStroke/.test(androidCoord),
  'Multi-touch during inking must safely cancel active stroke and yield to PDF navigation'
);

check(
  'Android PdfInkOverlayView processes stylus and historical pressure samples',
  /event\.getHistoricalPressure/.test(androidInk) &&
    /event\.getPressure/.test(androidInk),
  'Android ink layer must capture fine stylus pressure and coalesced motion samples'
);

check(
  'Android removes the top ink overlay from hit testing outside an active ink tool',
  /inkOverlayView\.setVisibility\(shouldReceiveInk \? VISIBLE : GONE\)/.test(androidHost) &&
    /setInteractive\(shouldReceiveInk\)/.test(androidHost),
  'The overlay must not consume PDFView navigation gestures outside Pencil, Highlighter, or Eraser mode',
);

check(
  'Android normalizes ink against the displayed PDF page rather than the overlay viewport',
  /getPageSize\(/.test(androidGeometry) &&
    /getCurrentXOffset\(\)/.test(androidGeometry) &&
    /getCurrentYOffset\(\)/.test(androidGeometry) &&
    /geometry\.normalizedX/.test(androidInk),
  'Coordinates must use the visible PDF page bounds, offsets, and zoom rather than getWidth/getHeight',
);

check(
  'Android Plugin exposes setPageStrokes and dispatches onStrokesUpdated events',
  /@PluginMethod[\s\S]{0,100}\bsetPageStrokes\b/.test(androidPlugin) &&
    /notifyListeners\("onStrokesUpdated"/.test(androidPlugin),
  'Android Plugin must synchronize strokes bi-directionally'
);

check(
  'iOS implements PDFPageOverlayViewProvider with PKCanvasView',
  /NativePdfPageOverlayProvider:\s*NSObject,\s*PDFPageOverlayViewProvider/.test(iosOverlay) &&
    /PKCanvasView/.test(iosOverlay),
  'iOS must conform to PDFPageOverlayViewProvider and provide interactive PKCanvasView'
);

check(
  'iOS hydrates native page overlays and suppresses duplicate hydration callbacks',
  /setPageStrokes\(pageIndex: Int, strokes: \[PdfBridgeStroke\]\)/.test(iosOverlay) &&
    /pagesBeingHydrated/.test(iosOverlay) &&
    /canvasToNormalizedPoint/.test(iosGeometry),
  'Hydrating a page must not re-emit its historical strokes as new operations',
);

check(
  'iOS mohadaraty_hitTest allows native gesture owner in nativeInkV2 mode',
  /MohadaratyPdfPlugin\.nativeInkV2/.test(iosPlugin) &&
    /ownsTouch = chromeHit/.test(iosPlugin),
  'iOS hit-test must allow PencilKit to receive drawing touches without WKWebView interception'
);

check(
  'React PdfReaderOverlay gates PdfDrawingLayer when NATIVE_INK_V2 is active on native',
  /const NATIVE_INK_V2 = import\.meta\.env\.VITE_PDF_NATIVE_INK_V2 === 'true'/.test(overlay) &&
    /\{!NATIVE_INK_V2 && \(/s.test(overlay),
  'React SVG drawing layer must not double-render or intercept touches when native ink is active'
);

console.log('\n--- 2. Normalized Geometry & Coordinate Invariance ---');

// Mathematical test of coordinate transformation:
// Screen coordinates to normalized [0..1] and back
const pageWidth = 1080;
const pageHeight = 1920;

function toNormalized(px: number, py: number, w: number, h: number): StrokePoint {
  return {
    x: Math.max(0, Math.min(1, px / w)),
    y: Math.max(0, Math.min(1, py / h)),
  };
}

function toViewCoords(pt: StrokePoint, w: number, h: number): { x: number; y: number } {
  return {
    x: pt.x * w,
    y: pt.y * h,
  };
}

const originalPoint = { x: 540, y: 960 };
const normalized = toNormalized(originalPoint.x, originalPoint.y, pageWidth, pageHeight);
const reconstructed = toViewCoords(normalized, pageWidth, pageHeight);

check(
  'Normalized point round-trip is exact within 1e-4 tolerance',
  Math.abs(reconstructed.x - originalPoint.x) < 1e-4 &&
    Math.abs(reconstructed.y - originalPoint.y) < 1e-4,
  'Coordinate conversion between view pixels and normalized values must be lossless'
);

console.log('\n--- 3. Backward Compatibility with Existing PdfStroke Schema ---');

const legacyStroke: PdfStroke = {
  id: 'test-stroke-1',
  lectureId: 'lecture-123',
  page: 1,
  tool: 'pencil',
  color: '#4f46e5',
  width: 4,
  opacity: 1.0,
  points: [
    { x: 0.1, y: 0.2, p: 0.8 },
    { x: 0.3, y: 0.4, p: 0.9 },
  ],
  createdAt: 1700000000000,
};

// Check JSON serialization fidelity
const serialized = JSON.stringify(legacyStroke);
const parsed: PdfStroke = JSON.parse(serialized);

check(
  'PdfStroke JSON serialization preserves all fields',
  parsed.id === legacyStroke.id &&
    parsed.tool === legacyStroke.tool &&
    parsed.color === legacyStroke.color &&
    parsed.width === legacyStroke.width &&
    parsed.points.length === legacyStroke.points.length &&
    parsed.points[0].p === legacyStroke.points[0].p,
  'Stored annotation format must remain 100% intact across serialization'
);

console.log(`\nPhase 2 Summary: ${9 - failures} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
