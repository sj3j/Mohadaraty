import { collection, getDocs, query, where } from 'firebase/firestore';
import { getMetadata, ref } from 'firebase/storage';
import { db, storage } from './firebase';
import { subjectSlugOf, denormalizedSubjectName } from '../../shared/subjectSlug';

/**
 * Collecting a year's lectures and recordings into a downloadable archive.
 *
 * `exportYear` in shared/yearWipe.ts snapshots the Firestore DOCUMENTS into
 * contentArchives and deliberately leaves the bytes alone - its own comment
 * says a year of recordings cannot live in Firestore, and that the manifest
 * exists so you can fetch the files yourself first. This is that fetch, made
 * into a button.
 *
 * It runs entirely in the browser because both stores already allow it:
 *
 *   records   Cloudflare R2 on a public pub-*.r2.dev host, which answers with
 *             `Access-Control-Allow-Origin: *`
 *   lectures  Firebase Storage download URLs, which return the same header on
 *             GET - the app's own offline PDF cache (useOfflinePDF) has been
 *             relying on that in production all along
 *
 * So no proxy, no serverless function, and no size ceiling imposed by either.
 * The ceiling that remains is the browser's, which is why the download streams
 * rather than buffering - see ContentExportPanel.
 */

export interface ArchiveFile {
  id: string;
  title: string;
  url: string;
  /** Bytes. 0 when it could not be determined without downloading. */
  bytes: number;
  /** Extension taken from the stored URL, so the file opens after extraction. */
  ext: string;
  number?: number;
}

export interface ArchiveSubject {
  subjectId: string;
  subjectName: string;
  stageId: string;
  lectures: ArchiveFile[];
  records: ArchiveFile[];
}

/** Windows forbids \ / : * ? " < > | in a name, and trailing dots. */
export function safeFileName(name: string, fallback = 'untitled'): string {
  const cleaned = (name || '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '');
  return cleaned.slice(0, 120) || fallback;
}

/** ".pdf" from a Firebase download URL, ".m4a" from an R2 key. */
function extensionOf(url: string, fallback: string): string {
  try {
    const path = decodeURIComponent(new URL(url).pathname);
    const match = path.match(/\.([a-z0-9]{2,5})$/i);
    return match ? `.${match[1].toLowerCase()}` : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Firebase Storage does not put the size on the lecture document, and a HEAD
 * request against a download URL comes back without the CORS header (only GET
 * carries it), so the size cannot be read that way. getMetadata goes through
 * the Storage SDK instead, which is authenticated and unaffected.
 *
 * Best-effort: a lecture whose metadata cannot be read is still exported, just
 * without contributing to the size estimate.
 */
async function lectureSizes(urls: string[]): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  const CHUNK = 12;
  for (let i = 0; i < urls.length; i += CHUNK) {
    await Promise.all(urls.slice(i, i + CHUNK).map(async url => {
      try {
        const meta = await getMetadata(ref(storage, url));
        if (meta.size) sizes.set(url, meta.size);
      } catch {
        // Deleted, moved, or uploaded outside this bucket. Not fatal.
      }
    }));
  }
  return sizes;
}

/**
 * Everything downloadable for a stage, grouped the way the ZIP is laid out.
 *
 * `stageId` of null gathers every stage, which only the master admin can do -
 * firestore.rules scopes both collections by stage for everyone else.
 */
export async function collectArchive(stageId: string | null): Promise<ArchiveSubject[]> {
  const scoped = (name: string) => stageId
    ? query(collection(db, name), where('stageId', '==', stageId))
    : query(collection(db, name));

  const [lectureSnap, recordSnap] = await Promise.all([
    getDocs(scoped('lectures')),
    getDocs(scoped('records')),
  ]);

  const subjects = new Map<string, ArchiveSubject>();
  const keyFor = (d: any) => `${d.stageId || 'unknown'}::${d.subjectId || 'uncategorised'}`;
  const bucket = (d: any): ArchiveSubject => {
    const key = keyFor(d);
    if (!subjects.has(key)) {
      subjects.set(key, {
        subjectId: subjectSlugOf(d) || 'uncategorised',
        // subjectName is denormalised onto both documents at upload time, so
        // the archive never has to join against the subjects collection - and
        // still names folders correctly for content whose subject was deleted.
        // That is exactly denormalizedSubjectName's tier-1-then-slug chain.
        subjectName: denormalizedSubjectName(d) || 'Uncategorised',
        stageId: d.stageId || 'unknown',
        lectures: [],
        records: [],
      });
    }
    return subjects.get(key)!;
  };

  const pdfUrls: string[] = [];
  lectureSnap.docs.forEach(doc => {
    const d = doc.data();
    if (!d.pdfUrl) return; // a stub left behind by a previous wipe
    pdfUrls.push(d.pdfUrl);
    bucket(d).lectures.push({
      id: doc.id,
      title: d.title || doc.id,
      url: d.pdfUrl,
      bytes: 0,
      ext: extensionOf(d.pdfUrl, '.pdf'),
      number: typeof d.number === 'number' ? d.number : undefined,
    });
  });

  recordSnap.docs.forEach(doc => {
    const d = doc.data();
    if (!d.audioUrl) return;
    bucket(d).records.push({
      id: doc.id,
      title: d.title || doc.id,
      url: d.audioUrl,
      // `size` is stored in MB at upload time; the ZIP works in bytes.
      bytes: typeof d.size === 'number' ? Math.round(d.size * 1024 * 1024) : 0,
      ext: extensionOf(d.audioUrl, '.m4a'),
      number: typeof d.number === 'number' ? d.number : undefined,
    });
  });

  const sizes = await lectureSizes(pdfUrls);
  for (const subject of subjects.values()) {
    for (const lecture of subject.lectures) {
      lecture.bytes = sizes.get(lecture.url) || 0;
    }
    const byNumber = (a: ArchiveFile, b: ArchiveFile) =>
      (a.number ?? 9999) - (b.number ?? 9999) || a.title.localeCompare(b.title);
    subject.lectures.sort(byNumber);
    subject.records.sort(byNumber);
  }

  return [...subjects.values()].sort((a, b) =>
    a.stageId.localeCompare(b.stageId) || a.subjectName.localeCompare(b.subjectName));
}

/**
 * The path a file takes inside the ZIP.
 *
 * One folder per subject, with lectures and recordings separated inside it.
 * The leading number keeps them in teaching order once extracted, since most
 * file managers sort alphabetically and "10" would otherwise precede "2".
 */
export function archivePath(
  subject: ArchiveSubject,
  kind: 'lectures' | 'records',
  file: ArchiveFile,
  includeStage: boolean,
): string {
  const folder = kind === 'lectures' ? 'المحاضرات' : 'التسجيلات';
  const prefix = file.number != null ? `${String(file.number).padStart(2, '0')} - ` : '';
  const parts = [
    includeStage ? safeFileName(subject.stageId, 'stage') : null,
    safeFileName(subject.subjectName, subject.subjectId),
    folder,
    `${prefix}${safeFileName(file.title, file.id)}${file.ext}`,
  ].filter(Boolean);
  return parts.join('/');
}

export function formatBytes(bytes: number, isRtl: boolean): string {
  if (!bytes) return isRtl ? '—' : '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
