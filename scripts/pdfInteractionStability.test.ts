import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

const android = source('android/app/src/main/java/com/mohadaraty/app/pdf/PdfViewerPlugin.java');
const ios = source('ios/App/App/pdf/PdfViewerPlugin.swift');
const bridge = source('src/lib/nativePdfViewer.ts');
const drawing = source('src/components/pdf/PdfDrawingLayer.tsx');
const reader = source('src/components/pdf/PdfReaderOverlay.tsx');

console.log('\n--- Native PDF interaction stability contract ---');

check(
  'Android no longer manually dispatches WebView MotionEvents into PDFView',
  !/pdfView\.dispatchTouchEvent\s*\(\s*event\s*\)/.test(android),
  'manual cross-view MotionEvent forwarding can duplicate or split a gesture stream',
);

check(
  'Android exposes an explicit interaction-state operation',
  /@PluginMethod[\s\S]{0,200}\bsetInteraction\s*\(/.test(android),
  'native touch ownership still depends on implicit/asynchronous UI regions',
);

check(
  'Android rejects or ignores stale interaction revisions',
  /revision/.test(android) && /(stale|appliedRevision|pendingRevision)/.test(android),
  'out-of-order bridge calls can overwrite newer mode/tool state',
);

check(
  'iOS implements the shared interaction-state operation',
  /@objc(?:\(setInteraction\))?\s+func\s+setInteraction\s*\(/.test(ios),
  'the shared bridge contract would diverge across native platforms',
);

check(
  'TypeScript bridge declares setInteraction with an applied revision acknowledgement',
  /interface SetInteractionResult[\s\S]{0,180}appliedRevision/.test(bridge)
    && /setInteraction\(state: ReaderInteractionState\): Promise<SetInteractionResult>/.test(bridge),
  'React cannot distinguish requested state from confirmed native state',
);

check(
  'Drawing layer handles pointer cancellation',
  /onPointerCancel/.test(drawing),
  'an interrupted stroke can leave drawing ownership or capture stuck',
);

check(
  'Drawing layer releases pointer capture defensively',
  /releasePointerCapture/.test(drawing),
  'captured pointers may remain attached across cancellation or tool changes',
);

check(
  'Native PDF initialization is not coupled to annotation-mode changes',
  !/\[isNative, lectureId, pdfUrl, isLocalFile, isNightMode, isAnnotationMode/.test(reader),
  'mode changes would tear down and reopen the native PDF view',
);

console.log(`\nSummary: ${8 - failures} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
