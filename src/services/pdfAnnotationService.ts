/**
 * CRUD for device-local PDF annotations.
 *
 * Structurally parallel to mcqAnswerService.ts - module-level key constants, a
 * flat function surface, failures logged rather than thrown at the UI. The one
 * addition is a localStorage PRESENCE INDEX (`pdfnotes_${lectureId}` = count),
 * which is the same trick useOfflinePDF plays with `pdf_${lectureId}`: it lets
 * a card render an "N highlights" badge synchronously, with no async DB open in
 * the render path.
 */

import {
  STORE_ANNOTATIONS,
  STORE_META,
  dbGet,
  dbPut,
  dbDelete,
  dbGetAllByIndex,
  dbDeleteByIndex,
  isLocalDbAvailable,
} from '../lib/localDb';
import {
  SCHEMA_VERSION,
  type PdfAnnotation,
  type DocMeta,
} from '../types/pdfAnnotation.types';

const COUNT_KEY = (lectureId: string) => `pdfnotes_${lectureId}`;
const META_KEY = (lectureId: string) => `doc:${lectureId}`;

/**
 * Bring an older record up to the current shape.
 *
 * Lazy and on-read, so a schema change never needs a blocking migration pass.
 * Note this is separate from the DB_VERSION axis in localDb: changing a FIELD
 * bumps SCHEMA_VERSION, changing a STORE bumps DB_VERSION.
 */
function migrateRecord(rec: PdfAnnotation): PdfAnnotation {
  if (rec.schema === SCHEMA_VERSION) return rec;
  // No migrations yet - v1 is the first shape. Future steps chain here.
  return { ...rec, schema: SCHEMA_VERSION };
}

function writeCountIndex(lectureId: string, n: number): void {
  try {
    if (n > 0) localStorage.setItem(COUNT_KEY(lectureId), String(n));
    else localStorage.removeItem(COUNT_KEY(lectureId));
  } catch {
    // A full quota must not take the annotation down with it - the index is
    // only a render hint, the DB remains the truth.
  }
}

export async function listAnnotations(lectureId: string): Promise<PdfAnnotation[]> {
  if (!isLocalDbAvailable()) return [];
  try {
    const rows = await dbGetAllByIndex<PdfAnnotation>(STORE_ANNOTATIONS, 'by_lecture', lectureId);
    const out = rows.map(migrateRecord).sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);
    writeCountIndex(lectureId, out.length);
    return out;
  } catch (e) {
    console.error('listAnnotations failed', e);
    return [];
  }
}

export async function saveAnnotation(a: PdfAnnotation): Promise<boolean> {
  if (!isLocalDbAvailable()) return false;
  try {
    await dbPut(STORE_ANNOTATIONS, { ...a, schema: SCHEMA_VERSION, updatedAt: Date.now() });
    // Recount from the source of truth rather than trusting an increment.
    const rows = await dbGetAllByIndex<PdfAnnotation>(STORE_ANNOTATIONS, 'by_lecture', a.lectureId);
    writeCountIndex(a.lectureId, rows.length);
    return true;
  } catch (e) {
    console.error('saveAnnotation failed', e);
    return false;
  }
}

export async function deleteAnnotation(id: string, lectureId: string): Promise<boolean> {
  if (!isLocalDbAvailable()) return false;
  try {
    await dbDelete(STORE_ANNOTATIONS, id);
    const rows = await dbGetAllByIndex<PdfAnnotation>(STORE_ANNOTATIONS, 'by_lecture', lectureId);
    writeCountIndex(lectureId, rows.length);
    return true;
  } catch (e) {
    console.error('deleteAnnotation failed', e);
    return false;
  }
}

/**
 * Wipes every annotation for a lecture.
 *
 * Deliberately NOT called from removePDF(): deleting a downloaded file is about
 * reclaiming space, and a student's notes are not the app's to throw away with
 * it. This runs only from an explicit, confirmed action.
 */
export async function deleteAllForLecture(lectureId: string): Promise<number> {
  if (!isLocalDbAvailable()) return 0;
  try {
    const n = await dbDeleteByIndex(STORE_ANNOTATIONS, 'by_lecture', lectureId);
    writeCountIndex(lectureId, 0);
    return n;
  } catch (e) {
    console.error('deleteAllForLecture failed', e);
    return 0;
  }
}

export async function getDocMeta(lectureId: string): Promise<DocMeta | null> {
  if (!isLocalDbAvailable()) return null;
  try {
    return (await dbGet<DocMeta>(STORE_META, META_KEY(lectureId))) ?? null;
  } catch {
    return null;
  }
}

export async function setDocMeta(lectureId: string, patch: Partial<DocMeta>): Promise<void> {
  if (!isLocalDbAvailable()) return;
  try {
    const prev = await getDocMeta(lectureId);
    await dbPut(STORE_META, {
      key: META_KEY(lectureId),
      fingerprint: '', pageCount: 0, lastPage: 1, lastScale: 1,
      ...prev, ...patch,
      updatedAt: Date.now(),
    });
  } catch (e) {
    console.error('setDocMeta failed', e);
  }
}

/**
 * Everything for one lecture as JSON.
 *
 * The honest counterpart to device-only storage: a student changing phones can
 * carry their notes across instead of losing a semester of them.
 */
export async function exportLecture(lectureId: string, lectureTitle: string): Promise<string> {
  const annotations = await listAnnotations(lectureId);
  return JSON.stringify({
    app: 'MyLecture',
    kind: 'pdf-annotations',
    schema: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    lectureId,
    lectureTitle,
    annotations,
  }, null, 2);
}
