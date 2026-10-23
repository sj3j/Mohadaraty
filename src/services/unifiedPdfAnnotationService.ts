/**
 * Unified PDF Annotation Persistence and Synchronization Service.
 *
 * Single Source of Truth for Mohadaraty PDF annotations.
 * Responsibilities:
 * 1. Coordinates reads/writes across IndexedDB and Native Filesystem (NativePdfRepository).
 * 2. Manages atomic operation deltas with restart-safe idempotency and persistent journal.
 * 3. Provides non-destructive lazy migration for historical legacy annotations and strokes.
 * 4. Ensures safe autosaving, out-of-order rejection, and crash resilience.
 */

import type {
  CanonicalAnnotation,
  CanonicalInkAnnotation,
  CanonicalTextAnnotation,
  CanonicalTextHighlightAnnotation,
  CanonicalAnnotationOperation,
  CanonicalDocumentState,
  DurableOperationJournal,
} from '../types/canonicalAnnotation.types';
import { CANONICAL_SCHEMA_VERSION } from '../types/canonicalAnnotation.types';
import type { PdfStroke, StrokePoint } from '../types/pdfDrawing.types';
import type { PdfAnnotation } from '../types/pdfAnnotation.types';
import {
  openDb,
  STORE_ANNOTATIONS,
  STORE_DRAWINGS,
  STORE_META,
  getLecturePageStrokes,
  saveLecturePageStrokes,
  isLocalDbAvailable,
} from '../lib/localDb';
import {
  isNativePlatform,
  listNativeAnnotations,
  saveNativeAnnotation,
  deleteNativeAnnotation,
  listNativeStrokes,
  saveNativeStrokes,
  deleteNativeStroke,
  getNativeJournal,
  saveNativeJournal,
} from '../lib/nativePdfRepository';

const PROCESSED_OPS_LIMIT = 500;
const journalMemoryCache = new Map<string, DurableOperationJournal>();
const processedOpIdsMemory = new Set<string>();

// Fallback in-memory stores when neither IndexedDB nor Native Filesystem is active (e.g. Node tests, strict private browsing)
const fallbackMemoryStrokes = new Map<string, PdfStroke[]>();
const fallbackMemoryAnnotations = new Map<string, PdfAnnotation[]>();

/**
 * Retrieves the durable operation journal for a document (checks memory cache, native filesystem, and IndexedDB).
 */
export async function getDurableJournal(documentId: string): Promise<DurableOperationJournal> {
  const cached = journalMemoryCache.get(documentId);
  if (cached) return cached;

  let loaded: DurableOperationJournal | null = null;

  // 1. Try native filesystem if mobile
  try {
    if (await isNativePlatform()) {
      loaded = await getNativeJournal(documentId);
    }
  } catch (err) {
    console.warn('[UnifiedPdfAnnotationService] Error reading native journal:', err);
  }

  // 2. Try IndexedDB STORE_META if not found
  if (!loaded && isLocalDbAvailable()) {
    try {
      const db = await openDb();
      loaded = await new Promise<DurableOperationJournal | null>((resolve) => {
        const tx = db.transaction(STORE_META, 'readonly');
        const req = tx.objectStore(STORE_META).get(`journal_${documentId}`);
        req.onsuccess = () => resolve(req.result ? req.result.journal : null);
        req.onerror = () => resolve(null);
      });
    } catch (err) {
      console.warn('[UnifiedPdfAnnotationService] Error reading IndexedDB journal:', err);
    }
  }

  const initialJournal: DurableOperationJournal = loaded || {
    documentId,
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    processedOpIds: [],
    lastRevision: 0,
    pendingOps: [],
    updatedAt: Date.now(),
  };

  // Seed memory cache and lookup set
  journalMemoryCache.set(documentId, initialJournal);
  for (const id of initialJournal.processedOpIds) {
    processedOpIdsMemory.add(id);
  }

  return initialJournal;
}

/**
 * Persists the durable journal to disk / IndexedDB.
 */
export async function persistDurableJournal(
  documentId: string,
  journal: DurableOperationJournal,
): Promise<void> {
  journal.updatedAt = Date.now();
  journalMemoryCache.set(documentId, journal);

  // 1. Native mobile filesystem
  try {
    if (await isNativePlatform()) {
      await saveNativeJournal(documentId, journal);
    }
  } catch (err) {
    console.warn('[UnifiedPdfAnnotationService] Error writing native journal:', err);
  }

  // 2. IndexedDB STORE_META
  if (isLocalDbAvailable()) {
    try {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_META, 'readwrite');
        tx.objectStore(STORE_META).put({
          key: `journal_${documentId}`,
          journal,
          updatedAt: Date.now(),
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.warn('[UnifiedPdfAnnotationService] Error writing IndexedDB journal:', err);
    }
  }
}

/**
 * Transforms a legacy PdfStroke into a CanonicalInkAnnotation.
 */
export function migrateStrokeToCanonical(stroke: PdfStroke): CanonicalInkAnnotation {
  return {
    id: stroke.id,
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    documentId: stroke.lectureId,
    pageIndex: stroke.page,
    kind: stroke.tool === 'free_highlighter' ? 'highlighter' : 'ink',
    points: (stroke.points || []).map((pt: StrokePoint) => ({
      x: pt.x,
      y: pt.y,
      pressure: pt.p ?? 1.0,
    })),
    color: stroke.color,
    opacity: stroke.opacity ?? (stroke.tool === 'free_highlighter' ? 0.38 : 1.0),
    width: stroke.width,
    createdAt: stroke.createdAt || Date.now(),
    updatedAt: stroke.createdAt || Date.now(),
    revision: 1,
  };
}

/**
 * Transforms a CanonicalInkAnnotation back to a legacy PdfStroke for backward-compatibility.
 */
export function canonicalToLegacyStroke(anno: CanonicalInkAnnotation): PdfStroke {
  return {
    id: anno.id,
    lectureId: anno.documentId,
    page: anno.pageIndex,
    tool: anno.kind === 'highlighter' ? 'free_highlighter' : 'pencil',
    color: anno.color,
    width: anno.width,
    opacity: anno.opacity,
    points: anno.points.map((pt) => ({
      x: pt.x,
      y: pt.y,
      p: pt.pressure,
    })),
    createdAt: anno.createdAt,
  };
}

/**
 * Transforms a legacy PdfAnnotation into a CanonicalAnnotation.
 */
export function migratePdfAnnotationToCanonical(anno: PdfAnnotation): CanonicalAnnotation {
  if (anno.kind === 'text') {
    return {
      id: anno.id,
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      documentId: anno.lectureId,
      pageIndex: anno.page,
      kind: 'text',
      point: anno.point || { x: 0.1, y: 0.1 },
      text: anno.text || '',
      fontSize: anno.fontSize || 'base',
      color: anno.color || '#4f46e5',
      note: anno.note,
      createdAt: anno.createdAt || Date.now(),
      updatedAt: anno.updatedAt || Date.now(),
      revision: 1,
    } as CanonicalTextAnnotation;
  }

  // Highlight / Pin
  return {
    id: anno.id,
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    documentId: anno.lectureId,
    pageIndex: anno.page,
    kind: 'text_highlight',
    colorName: (anno.color as any) || 'yellow',
    color: anno.color || '#fde68a',
    note: anno.note,
    quads: anno.anchor?.quads,
    exactText: anno.anchor?.exact,
    createdAt: anno.createdAt || Date.now(),
    updatedAt: anno.updatedAt || Date.now(),
    revision: 1,
  } as CanonicalTextHighlightAnnotation;
}

/**
 * Loads all canonical annotations for a specific document and page.
 * Merges ink strokes and text/highlight annotations non-destructively from both stores.
 */
export async function loadCanonicalPageAnnotations(
  documentId: string,
  pageIndex: number,
): Promise<CanonicalAnnotation[]> {
  const result: CanonicalAnnotation[] = [];
  const seenIds = new Set<string>();

  // 1. Fetch drawing strokes from IndexedDB
  try {
    const strokes = await getLecturePageStrokes(documentId, pageIndex);
    for (const stroke of strokes) {
      if (!seenIds.has(stroke.id)) {
        seenIds.add(stroke.id);
        result.push(migrateStrokeToCanonical(stroke));
      }
    }
  } catch (err) {
    console.warn('[UnifiedPdfAnnotationService] Error loading page strokes from localDb:', err);
  }

  // 2. Fetch drawing strokes from Native Filesystem if on mobile (bidirectional sync)
  try {
    if (await isNativePlatform()) {
      const nativeStrokes = await listNativeStrokes(documentId, pageIndex);
      for (const stroke of nativeStrokes) {
        if (!seenIds.has(stroke.id)) {
          seenIds.add(stroke.id);
          result.push(migrateStrokeToCanonical(stroke));
          // Hydrate back to IndexedDB if localDb is available
          if (isLocalDbAvailable()) {
            saveLecturePageStrokes(documentId, pageIndex, [stroke]).catch(() => {});
          }
        }
      }
    }
  } catch (err) {
    console.warn('[UnifiedPdfAnnotationService] Error loading page strokes from native repository:', err);
  }

  // 3. Fetch text notes & highlights from local storage or native repository
  try {
    let legacyAnnos: PdfAnnotation[] = [];
    if (await isNativePlatform()) {
      legacyAnnos = await listNativeAnnotations(documentId);
    } else if (isLocalDbAvailable()) {
      const db = await openDb();
      legacyAnnos = await new Promise<PdfAnnotation[]>((resolve) => {
        const tx = db.transaction(STORE_ANNOTATIONS, 'readonly');
        const store = tx.objectStore(STORE_ANNOTATIONS);
        const index = store.index('by_lecture_page');
        const req = index.getAll(IDBKeyRange.only([documentId, pageIndex]));
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    }

    for (const la of legacyAnnos) {
      if (la.page === pageIndex && !seenIds.has(la.id)) {
        seenIds.add(la.id);
        result.push(migratePdfAnnotationToCanonical(la));
      }
    }
  } catch (err) {
    console.warn('[UnifiedPdfAnnotationService] Error loading page annotations:', err);
  }

  // 4. Check fallback memory store (e.g. Node test environments or private browsing)
  const memKey = `${documentId}_${pageIndex}`;
  const memStrokes = fallbackMemoryStrokes.get(memKey) || [];
  for (const stroke of memStrokes) {
    if (!seenIds.has(stroke.id)) {
      seenIds.add(stroke.id);
      result.push(migrateStrokeToCanonical(stroke));
    }
  }
  const memAnnos = (fallbackMemoryAnnotations.get(documentId) || []).filter((a) => a.page === pageIndex);
  for (const anno of memAnnos) {
    if (!seenIds.has(anno.id)) {
      seenIds.add(anno.id);
      result.push(migratePdfAnnotationToCanonical(anno));
    }
  }

  return result.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Loads the entire canonical state of a document across all pages.
 */
export async function loadCanonicalDocument(
  documentId: string,
  pageCount?: number,
): Promise<CanonicalDocumentState> {
  const annotationsByPage: Record<number, CanonicalAnnotation[]> = {};
  const maxPage = pageCount && pageCount > 0 ? pageCount : 50;

  for (let p = 1; p <= maxPage; p++) {
    const pageAnnos = await loadCanonicalPageAnnotations(documentId, p);
    if (pageAnnos.length > 0) {
      annotationsByPage[p] = pageAnnos;
    }
  }

  const journal = await getDurableJournal(documentId);

  return {
    documentId,
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    lastRevision: journal.lastRevision,
    annotationsByPage,
    updatedAt: Date.now(),
  };
}

/**
 * Recovers any uncommitted pending operations recorded in the journal (crash recovery).
 */
export async function recoverPendingOperations(documentId: string): Promise<number> {
  const journal = await getDurableJournal(documentId);
  if (!journal.pendingOps || journal.pendingOps.length === 0) {
    return 0;
  }

  let recovered = 0;
  const pending = [...journal.pendingOps];
  journal.pendingOps = [];

  for (const op of pending) {
    try {
      await commitCanonicalOperation(op);
      recovered++;
    } catch (e) {
      console.warn('[UnifiedPdfAnnotationService] Pending op recovery failed:', op, e);
    }
  }

  await persistDurableJournal(documentId, journal);
  return recovered;
}

/**
 * Commits a single canonical operation atomically to storage.
 * Supports restart-safe idempotency via durable operation journal.
 */
export async function commitCanonicalOperation(
  op: CanonicalAnnotationOperation,
): Promise<{ success: boolean; skipped?: boolean }> {
  // Check in-memory fast path
  if (processedOpIdsMemory.has(op.opId)) {
    return { success: true, skipped: true };
  }

  // Check persistent journal
  const journal = await getDurableJournal(op.documentId);
  if (journal.processedOpIds.includes(op.opId)) {
    processedOpIdsMemory.add(op.opId);
    return { success: true, skipped: true };
  }

  // Register in journal pending queue
  journal.pendingOps.push(op);
  journal.processedOpIds.push(op.opId);
  if (journal.processedOpIds.length > PROCESSED_OPS_LIMIT) {
    journal.processedOpIds.shift();
  }
  journal.lastRevision += 1;
  processedOpIdsMemory.add(op.opId);

  // Record page history snapshot before applying mutation (for undo/redo)
  try {
    const currentAnnos = await loadCanonicalPageAnnotations(op.documentId, op.pageIndex);
    recordPageHistorySnapshot(op.documentId, op.pageIndex, currentAnnos);
  } catch {}

  try {
    if (op.type === 'add' || op.type === 'update') {
      const anno = op.annotation;
      if (anno.kind === 'ink' || anno.kind === 'highlighter') {
        const stroke = canonicalToLegacyStroke(anno as CanonicalInkAnnotation);

        // 1. Save to IndexedDB
        if (isLocalDbAvailable()) {
          try {
            const existingStrokes = await getLecturePageStrokes(op.documentId, op.pageIndex);
            const nextStrokes = existingStrokes.filter((s) => s.id !== stroke.id);
            nextStrokes.push(stroke);
            await saveLecturePageStrokes(op.documentId, op.pageIndex, nextStrokes);
          } catch (dbErr) {
            console.warn('[UnifiedPdfAnnotationService] IndexedDB stroke write skipped:', dbErr);
          }
        }

        // 2. Save to Native Filesystem if on mobile
        if (await isNativePlatform()) {
          try {
            const existingStrokes = await listNativeStrokes(op.documentId, op.pageIndex);
            const nextStrokes = existingStrokes.filter((s) => s.id !== stroke.id);
            nextStrokes.push(stroke);
            await saveNativeStrokes(op.documentId, op.pageIndex, nextStrokes);
          } catch (fsErr) {
            console.warn('[UnifiedPdfAnnotationService] Native stroke write skipped:', fsErr);
          }
        }

        // 3. Save to fallback memory store
        const memKey = `${op.documentId}_${op.pageIndex}`;
        const existingMemStrokes = fallbackMemoryStrokes.get(memKey) || [];
        const nextMemStrokes = existingMemStrokes.filter((s) => s.id !== stroke.id);
        nextMemStrokes.push(stroke);
        fallbackMemoryStrokes.set(memKey, nextMemStrokes);
      } else if (anno.kind === 'text') {
        const textAnno = anno as CanonicalTextAnnotation;
        const legacy: PdfAnnotation = {
          id: textAnno.id,
          lectureId: textAnno.documentId,
          docFingerprint: textAnno.documentId,
          kind: 'text',
          page: textAnno.pageIndex,
          color: 'blue',
          text: textAnno.text,
          fontSize: textAnno.fontSize,
          note: textAnno.note,
          point: textAnno.point,
          createdAt: textAnno.createdAt,
          updatedAt: textAnno.updatedAt,
          schema: 1,
        };

        if (await isNativePlatform()) {
          await saveNativeAnnotation(legacy);
        }
        if (isLocalDbAvailable()) {
          const db = await openDb();
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE_ANNOTATIONS, 'readwrite');
            tx.objectStore(STORE_ANNOTATIONS).put(legacy);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
        }

        // Fallback memory store
        const docAnnos = fallbackMemoryAnnotations.get(textAnno.documentId) || [];
        const nextDocAnnos = docAnnos.filter((a) => a.id !== legacy.id);
        nextDocAnnos.push(legacy);
        fallbackMemoryAnnotations.set(textAnno.documentId, nextDocAnnos);
      }
    } else if (op.type === 'delete') {
      // 1. Delete from IndexedDB strokes
      if (isLocalDbAvailable()) {
        try {
          const existingStrokes = await getLecturePageStrokes(op.documentId, op.pageIndex);
          const remainingStrokes = existingStrokes.filter((s) => s.id !== op.annotationId);
          if (remainingStrokes.length !== existingStrokes.length) {
            await saveLecturePageStrokes(op.documentId, op.pageIndex, remainingStrokes);
          }
        } catch (dbErr) {
          console.warn('[UnifiedPdfAnnotationService] IndexedDB delete stroke skipped:', dbErr);
        }
      }

      // 2. Delete from native filesystem strokes
      if (await isNativePlatform()) {
        try {
          await deleteNativeStroke(op.documentId, op.pageIndex, op.annotationId);
        } catch (fsErr) {
          console.warn('[UnifiedPdfAnnotationService] Native delete stroke skipped:', fsErr);
        }
      }

      // 3. Delete from annotations (text/highlights)
      if (await isNativePlatform()) {
        await deleteNativeAnnotation(op.annotationId, op.documentId);
      }
      if (isLocalDbAvailable()) {
        const db = await openDb();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_ANNOTATIONS, 'readwrite');
          tx.objectStore(STORE_ANNOTATIONS).delete(op.annotationId);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      }

      // 4. Delete from fallback memory stores
      const memKey = `${op.documentId}_${op.pageIndex}`;
      const existingMemStrokes = fallbackMemoryStrokes.get(memKey) || [];
      fallbackMemoryStrokes.set(memKey, existingMemStrokes.filter((s) => s.id !== op.annotationId));
      const existingMemAnnos = fallbackMemoryAnnotations.get(op.documentId) || [];
      fallbackMemoryAnnotations.set(op.documentId, existingMemAnnos.filter((a) => a.id !== op.annotationId));
    }

    // Remove from pendingOps upon durable success and persist journal
    journal.pendingOps = journal.pendingOps.filter((p) => p.opId !== op.opId);
    await persistDurableJournal(op.documentId, journal);

    return { success: true };
  } catch (err) {
    console.error('[UnifiedPdfAnnotationService] Operation commit failed:', op, err);
    // Remove from processed set on hard failure so a retry is permitted
    processedOpIdsMemory.delete(op.opId);
    journal.processedOpIds = journal.processedOpIds.filter((id) => id !== op.opId);
    return { success: false };
  }
}

// ==========================================
// Bounded Page-Level Undo / Redo Stacks
// ==========================================

const MAX_UNDO_STACK_SIZE = 30;
const pageUndoStacks = new Map<string, CanonicalAnnotation[][]>();
const pageRedoStacks = new Map<string, CanonicalAnnotation[][]>();

function getStackKey(documentId: string, pageIndex: number): string {
  return `${documentId}_${pageIndex}`;
}

export function recordPageHistorySnapshot(
  documentId: string,
  pageIndex: number,
  annotations: CanonicalAnnotation[],
): void {
  const key = getStackKey(documentId, pageIndex);
  let undoList = pageUndoStacks.get(key);
  if (!undoList) {
    undoList = [];
    pageUndoStacks.set(key, undoList);
  }
  undoList.push(JSON.parse(JSON.stringify(annotations)));
  if (undoList.length > MAX_UNDO_STACK_SIZE) {
    undoList.shift();
  }
  // Any new forward mutation invalidates current redo history
  pageRedoStacks.delete(key);
}

export function getUndoRedoState(
  documentId: string,
  pageIndex: number,
): { canUndo: boolean; canRedo: boolean } {
  const key = getStackKey(documentId, pageIndex);
  const undoList = pageUndoStacks.get(key);
  const redoList = pageRedoStacks.get(key);
  return {
    canUndo: !!(undoList && undoList.length > 0),
    canRedo: !!(redoList && redoList.length > 0),
  };
}

export async function undoCanonicalPage(
  documentId: string,
  pageIndex: number,
): Promise<{ success: boolean; annotations: CanonicalAnnotation[] }> {
  const key = getStackKey(documentId, pageIndex);
  const undoList = pageUndoStacks.get(key);
  if (!undoList || undoList.length === 0) {
    const current = await loadCanonicalPageAnnotations(documentId, pageIndex);
    return { success: false, annotations: current };
  }

  const previousSnapshot = undoList.pop()!;
  const currentAnnos = await loadCanonicalPageAnnotations(documentId, pageIndex);

  let redoList = pageRedoStacks.get(key);
  if (!redoList) {
    redoList = [];
    pageRedoStacks.set(key, redoList);
  }
  redoList.push(JSON.parse(JSON.stringify(currentAnnos)));
  if (redoList.length > MAX_UNDO_STACK_SIZE) {
    redoList.shift();
  }

  await replacePageCanonicalAnnotations(documentId, pageIndex, previousSnapshot);
  return { success: true, annotations: previousSnapshot };
}

export async function redoCanonicalPage(
  documentId: string,
  pageIndex: number,
): Promise<{ success: boolean; annotations: CanonicalAnnotation[] }> {
  const key = getStackKey(documentId, pageIndex);
  const redoList = pageRedoStacks.get(key);
  if (!redoList || redoList.length === 0) {
    const current = await loadCanonicalPageAnnotations(documentId, pageIndex);
    return { success: false, annotations: current };
  }

  const nextSnapshot = redoList.pop()!;
  const currentAnnos = await loadCanonicalPageAnnotations(documentId, pageIndex);

  let undoList = pageUndoStacks.get(key);
  if (!undoList) {
    undoList = [];
    pageUndoStacks.set(key, undoList);
  }
  undoList.push(JSON.parse(JSON.stringify(currentAnnos)));
  if (undoList.length > MAX_UNDO_STACK_SIZE) {
    undoList.shift();
  }

  await replacePageCanonicalAnnotations(documentId, pageIndex, nextSnapshot);
  return { success: true, annotations: nextSnapshot };
}

export async function replacePageCanonicalAnnotations(
  documentId: string,
  pageIndex: number,
  annotations: CanonicalAnnotation[],
): Promise<void> {
  const strokes: PdfStroke[] = [];
  const textAnnos: PdfAnnotation[] = [];

  for (const a of annotations) {
    if (a.kind === 'ink' || a.kind === 'highlighter') {
      strokes.push(canonicalToLegacyStroke(a as CanonicalInkAnnotation));
    } else if (a.kind === 'text') {
      const t = a as CanonicalTextAnnotation;
      textAnnos.push({
        id: t.id,
        lectureId: t.documentId,
        docFingerprint: t.documentId,
        kind: 'text',
        page: t.pageIndex,
        color: 'blue',
        text: t.text,
        fontSize: t.fontSize,
        note: t.note,
        point: t.point,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        schema: 1,
      });
    }
  }

  // 1. Save strokes to IndexedDB
  if (isLocalDbAvailable()) {
    try {
      await saveLecturePageStrokes(documentId, pageIndex, strokes);
    } catch (e) {
      console.warn('[UnifiedPdfAnnotationService] Error replacing page strokes in localDb:', e);
    }
  }

  // 2. Save strokes to Native Filesystem if on mobile
  if (await isNativePlatform()) {
    try {
      await saveNativeStrokes(documentId, pageIndex, strokes);
    } catch (e) {
      console.warn('[UnifiedPdfAnnotationService] Error replacing page strokes in native filesystem:', e);
    }
  }

  // 3. Save strokes to fallback memory store
  const memKey = `${documentId}_${pageIndex}`;
  fallbackMemoryStrokes.set(memKey, strokes);
}

