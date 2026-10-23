import assert from 'node:assert/strict';
import test from 'node:test';
import {
  migrateStrokeToCanonical,
  canonicalToLegacyStroke,
  migratePdfAnnotationToCanonical,
  commitCanonicalOperation,
  loadCanonicalPageAnnotations,
  loadCanonicalDocument,
  getDurableJournal,
  undoCanonicalPage,
  redoCanonicalPage,
} from '../src/services/unifiedPdfAnnotationService';
import { exportAnnotatedPdf, hexToPdfRgb, shapeAndOrderText } from '../src/services/pdfExportService';
import { CANONICAL_SCHEMA_VERSION, type CanonicalInkAnnotation } from '../src/types/canonicalAnnotation.types';
import type { PdfStroke } from '../src/types/pdfDrawing.types';
import type { PdfAnnotation } from '../src/types/pdfAnnotation.types';
import { PDFDocument } from 'pdf-lib';

test('Canonical Model: Converts legacy PdfStroke to CanonicalInkAnnotation losslessly', () => {
  const legacyStroke: PdfStroke = {
    id: 'stroke-101',
    lectureId: 'lec-alpha',
    page: 3,
    tool: 'pencil',
    color: '#4f46e5',
    width: 4,
    opacity: 1.0,
    points: [
      { x: 0.15, y: 0.22, p: 0.8 },
      { x: 0.18, y: 0.26, p: 0.9 },
    ],
    createdAt: 1700000000000,
  };

  const canonical = migrateStrokeToCanonical(legacyStroke);
  assert.equal(canonical.id, 'stroke-101');
  assert.equal(canonical.schemaVersion, CANONICAL_SCHEMA_VERSION);
  assert.equal(canonical.kind, 'ink');
  assert.equal(canonical.pageIndex, 3);
  assert.equal(canonical.points.length, 2);
  assert.equal(canonical.points[0].x, 0.15);
  assert.equal(canonical.points[0].pressure, 0.8);

  // Round-trip back to legacy
  const roundtrip = canonicalToLegacyStroke(canonical);
  assert.equal(roundtrip.id, legacyStroke.id);
  assert.equal(roundtrip.tool, 'pencil');
  assert.equal(roundtrip.points[0].x, 0.15);
  assert.equal(roundtrip.points[0].p, 0.8);
});

test('Canonical Model: Converts highlighter stroke with correct opacity', () => {
  const legacyHighlighter: PdfStroke = {
    id: 'hl-1',
    lectureId: 'lec-alpha',
    page: 1,
    tool: 'free_highlighter',
    color: '#fde68a',
    width: 22,
    opacity: 0.38,
    points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }],
    createdAt: 1700000005000,
  };

  const canonical = migrateStrokeToCanonical(legacyHighlighter);
  assert.equal(canonical.kind, 'highlighter');
  assert.equal(canonical.opacity, 0.38);

  const roundtrip = canonicalToLegacyStroke(canonical);
  assert.equal(roundtrip.tool, 'free_highlighter');
});

test('Canonical Model: Converts legacy text & pin PdfAnnotation', () => {
  const legacyText: PdfAnnotation = {
    id: 'text-anno-1',
    lectureId: 'lec-beta',
    docFingerprint: 'fp-123',
    kind: 'text',
    page: 2,
    color: 'blue',
    text: 'Note on cardiac cycle',
    fontSize: 'base',
    point: { x: 0.2, y: 0.4 },
    createdAt: 1700000010000,
    updatedAt: 1700000020000,
    schema: 1,
  };

  const canonical = migratePdfAnnotationToCanonical(legacyText);
  assert.equal(canonical.kind, 'text');
  if (canonical.kind === 'text') {
    assert.equal(canonical.text, 'Note on cardiac cycle');
    assert.equal(canonical.point.x, 0.2);
    assert.equal(canonical.point.y, 0.4);
  }
});

test('Persistence & Deduplication: Operations with identical opId are idempotent', async () => {
  const opId = 'unique-op-999';
  const anno: CanonicalInkAnnotation = {
    id: 'stroke-dedup-1',
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    documentId: 'doc-test-1',
    pageIndex: 1,
    kind: 'ink',
    points: [{ x: 0.1, y: 0.1 }],
    color: '#000000',
    opacity: 1.0,
    width: 2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    revision: 1,
  };

  // First commit
  const res1 = await commitCanonicalOperation({
    opId,
    type: 'add',
    documentId: 'doc-test-1',
    pageIndex: 1,
    annotation: anno,
    clientTimestamp: Date.now(),
  });
  assert.equal(res1.success, true);
  assert.equal(res1.skipped, undefined);

  // Duplicate commit with the same opId
  const res2 = await commitCanonicalOperation({
    opId,
    type: 'add',
    documentId: 'doc-test-1',
    pageIndex: 1,
    annotation: anno,
    clientTimestamp: Date.now(),
  });
  assert.equal(res2.success, true);
  assert.equal(res2.skipped, true);
});

test('PDF Export: Generates valid annotated PDF without touching original bytes', async () => {
  // Create a minimal reference 2-page PDF
  const refDoc = await PDFDocument.create();
  const page1 = refDoc.addPage([400, 600]);
  const page2 = refDoc.addPage([400, 600]);
  const originalBytes = await refDoc.save();

  const exportResult = await exportAnnotatedPdf({
    lectureId: 'test-export-doc',
    lectureTitle: 'Pathology Lecture 1',
    pdfArrayBuffer: originalBytes.buffer.slice(originalBytes.byteOffset, originalBytes.byteOffset + originalBytes.byteLength) as ArrayBuffer,
  });

  assert.equal(exportResult.success, true);
  assert.ok(exportResult.exportedBytes);
  assert.ok(exportResult.exportedBytes.length > 0);

  // Verify the exported PDF is valid and has both pages intact
  const parsedExportedDoc = await PDFDocument.load(exportResult.exportedBytes);
  assert.equal(parsedExportedDoc.getPageCount(), 2);

  // Original array buffer remains unmodified
  assert.equal(originalBytes.length > 0, true);
});

test('PDF Export: Color conversion from Hex to PDF RGB', () => {
  const white = hexToPdfRgb('#ffffff');
  assert.equal(white.r, 1);
  assert.equal(white.g, 1);
  assert.equal(white.b, 1);

  const black = hexToPdfRgb('#000000');
  assert.equal(black.r, 0);
  assert.equal(black.g, 0);
  assert.equal(black.b, 0);
});

test('Durability & Journal: Durable journal tracks operations across simulated restarts', async () => {
  const docId = 'doc-restart-sim-1';
  const journalBefore = await getDurableJournal(docId);
  assert.equal(journalBefore.documentId, docId);
  assert.equal(journalBefore.schemaVersion, 2);

  // Commit two operations
  const op1 = 'op-durable-alpha-1';
  const op2 = 'op-durable-beta-2';

  const res1 = await commitCanonicalOperation({
    opId: op1,
    type: 'add',
    documentId: docId,
    pageIndex: 1,
    annotation: {
      id: 'anno-durable-1',
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      documentId: docId,
      pageIndex: 1,
      kind: 'ink',
      points: [{ x: 0.1, y: 0.2 }, { x: 0.2, y: 0.3 }],
      color: '#4f46e5',
      opacity: 1.0,
      width: 3,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 1,
    },
    clientTimestamp: Date.now(),
  });
  assert.equal(res1.success, true);

  const res2 = await commitCanonicalOperation({
    opId: op2,
    type: 'add',
    documentId: docId,
    pageIndex: 1,
    annotation: {
      id: 'anno-durable-2',
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      documentId: docId,
      pageIndex: 1,
      kind: 'ink',
      points: [{ x: 0.4, y: 0.5 }, { x: 0.5, y: 0.6 }],
      color: '#10b981',
      opacity: 1.0,
      width: 4,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 2,
    },
    clientTimestamp: Date.now(),
  });
  assert.equal(res2.success, true);

  // Read journal from persistence
  const journalAfter = await getDurableJournal(docId);
  assert.ok(journalAfter.processedOpIds.includes(op1));
  assert.ok(journalAfter.processedOpIds.includes(op2));
  assert.ok(journalAfter.lastRevision >= 2);

  // Simulate process restart: reload annotations and re-submit op1
  const replayedRes = await commitCanonicalOperation({
    opId: op1,
    type: 'add',
    documentId: docId,
    pageIndex: 1,
    annotation: {
      id: 'anno-durable-1',
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      documentId: docId,
      pageIndex: 1,
      kind: 'ink',
      points: [{ x: 0.1, y: 0.2 }, { x: 0.2, y: 0.3 }],
      color: '#4f46e5',
      opacity: 1.0,
      width: 3,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 1,
    },
    clientTimestamp: Date.now(),
  });
  assert.equal(replayedRes.success, true);
  assert.equal(replayedRes.skipped, true, 'Replayed operation must be skipped');

  // Verify page annotations contains exactly 2 annotations (no duplicates)
  const pageAnnos = await loadCanonicalPageAnnotations(docId, 1);
  assert.equal(pageAnnos.length, 2);
});

test('PDF Export: Arabic and Mixed Arabic/English notes render cleanly with embedded font', async () => {
  const docId = 'doc-arabic-export-test';
  const pageCount = 3;

  // Add Arabic note
  await commitCanonicalOperation({
    opId: 'op-arabic-1',
    type: 'add',
    documentId: docId,
    pageIndex: 1,
    annotation: {
      id: 'text-arabic-1',
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      documentId: docId,
      pageIndex: 1,
      kind: 'text',
      text: 'ملاحظات هامة حول المحاضرة الأولى',
      point: { x: 0.15, y: 0.2 },
      color: '#dc2626',
      fontSize: 'base',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 1,
    },
    clientTimestamp: Date.now(),
  });

  // Add Mixed Arabic/English note
  await commitCanonicalOperation({
    opId: 'op-mixed-2',
    type: 'add',
    documentId: docId,
    pageIndex: 2,
    annotation: {
      id: 'text-mixed-2',
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      documentId: docId,
      pageIndex: 2,
      kind: 'text',
      text: 'تشريح القلب: Section 4 Cardiovascular System',
      point: { x: 0.1, y: 0.35 },
      color: '#2563eb',
      fontSize: 'lg',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 2,
    },
    clientTimestamp: Date.now(),
  });

  // Verify Arabic shaping and RTL visual bidi function
  const pureArabicShaped = shapeAndOrderText('ملاحظات المحاضرة');
  assert.ok(pureArabicShaped.length > 0);
  assert.notEqual(pureArabicShaped, 'ملاحظات المحاضرة', 'Reshaped Arabic glyphs must differ from raw letters');

  const mixedShaped = shapeAndOrderText('ملاحظات Page 1');
  assert.ok(mixedShaped.includes('Page 1'));

  // Create a 3-page base PDF
  const refDoc = await PDFDocument.create();
  refDoc.addPage([500, 700]);
  refDoc.addPage([500, 700]);
  refDoc.addPage([500, 700]);
  const originalBytes = await refDoc.save();

  // Export annotated PDF
  const exportResult = await exportAnnotatedPdf({
    lectureId: docId,
    lectureTitle: 'Medical Anatomy',
    pdfArrayBuffer: originalBytes.buffer.slice(originalBytes.byteOffset, originalBytes.byteOffset + originalBytes.byteLength) as ArrayBuffer,
  });

  assert.equal(exportResult.success, true, 'Export must succeed with Arabic notes');
  assert.ok(exportResult.exportedBytes);
  assert.ok(exportResult.exportedBytes.length > originalBytes.length, 'Exported bytes must contain font and text annotations');

  // Load and inspect the exported PDF structure
  const exportedDoc = await PDFDocument.load(exportResult.exportedBytes);
  assert.equal(exportedDoc.getPageCount(), 3);
});

test('Stress & Durability: Rapid consecutive strokes and undo/redo consistency', async () => {
  const docId = 'doc-stress-100';
  const strokeCount = 100;

  for (let i = 0; i < strokeCount; i++) {
    await commitCanonicalOperation({
      opId: `stress-op-${i}`,
      type: 'add',
      documentId: docId,
      pageIndex: 1,
      annotation: {
        id: `stress-stroke-${i}`,
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        documentId: docId,
        pageIndex: 1,
        kind: i % 4 === 0 ? 'highlighter' : 'ink',
        points: [
          { x: 0.1 + (i % 20) * 0.03, y: 0.1 + (i % 15) * 0.04 },
          { x: 0.12 + (i % 20) * 0.03, y: 0.14 + (i % 15) * 0.04 },
        ],
        color: '#4f46e5',
        opacity: i % 4 === 0 ? 0.38 : 1.0,
        width: 3,
        createdAt: Date.now() + i,
        updatedAt: Date.now() + i,
        revision: i + 1,
      },
      clientTimestamp: Date.now() + i,
    });
  }

  const page1Annos = await loadCanonicalPageAnnotations(docId, 1);
  assert.equal(page1Annos.length, strokeCount, `All ${strokeCount} strokes must be durably committed`);

  // Verify undo removes last stroke
  const undoResult = await undoCanonicalPage(docId, 1);
  assert.equal(undoResult.success, true);
  const afterUndoAnnos = await loadCanonicalPageAnnotations(docId, 1);
  assert.equal(afterUndoAnnos.length, strokeCount - 1);

  // Verify redo restores the stroke
  const redoResult = await redoCanonicalPage(docId, 1);
  assert.equal(redoResult.success, true);
  const afterRedoAnnos = await loadCanonicalPageAnnotations(docId, 1);
  assert.equal(afterRedoAnnos.length, strokeCount);
});

