/**
 * The device-local database.
 *
 * A deliberate departure from this codebase's localStorage habit, for two
 * reasons that are specific rather than stylistic:
 *
 *   1. localStorage is one ~5MB quota shared across the whole origin, and
 *      `mcq_cache_${lectureId}` already fills it with generated MCQ payloads,
 *      unbounded and never evicted. `setItem` throws SYNCHRONOUSLY on overflow,
 *      so a student with a semester of highlights would not merely fail to save
 *      a note - they would break MCQ caching and offline-PDF bookkeeping too.
 *      Quota exhaustion here is an app-wide failure, not a feature-local one.
 *
 *   2. The native build's service worker (vite.config.ts `selfDestroying`)
 *      deletes EVERY CacheStorage cache on activate, and re-registers on every
 *      page load - so CacheStorage is wiped each launch. IndexedDB is untouched
 *      by it.
 *
 * Hand-rolled rather than pulling in `idb`: this is one open plus four helpers,
 * and the main bundle is already large enough to warn.
 */

import type { LocalAttendanceReceipt } from '../../shared/attendance';
import { secureRequestId } from './secureRandom';

const DB_NAME = 'mylecture-local';
const DB_VERSION = 6;

export const STORE_ANNOTATIONS = 'pdfAnnotations';
export const STORE_BLOBS = 'pdfBlobs';
export const STORE_META = 'meta';
/**
 * Metadata for lectures the student downloaded, so a saved PDF stays reachable
 * with no network.
 *
 * The bytes alone were never enough: the lecture LIST comes from a Firestore
 * listener, and the Downloads tab filtered that array. Offline the array was
 * empty, so a student with a dozen saved PDFs saw "no saved downloads" - the
 * bytes were on the device with no title or id to reach them by.
 */
export const STORE_OFFLINE_LECTURES = 'offlineLectures';

/** Stores for "مساحتك" (Personal Space) local folder & file organization */
export const STORE_USER_FOLDERS = 'userFolders';
export const STORE_USER_FILES = 'userFiles';
export const STORE_USER_BLOBS = 'userFileBlobs';

/** v4 Stores for timetable schedule image and stage homeworks */
export const STORE_SCHEDULE_IMAGES = 'scheduleImages';
export const STORE_OFFLINE_HOMEWORKS = 'offlineHomeworks';
/** v5. Immutable attendance evidence and last canonical student snapshot. */
export const STORE_ATTENDANCE_OUTBOX = 'attendanceOutbox';
export const STORE_ATTENDANCE_STATE = 'attendanceState';
export const STORE_ATTENDANCE_LOCKS = 'attendanceSessionLocks';
export const STORE_ATTENDANCE_COMMANDS = 'attendanceDoctorCommands';

let dbPromise: Promise<IDBDatabase> | null = null;

/** True when IndexedDB is usable at all (private modes and old WebViews may not be). */
export function isLocalDbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (!isLocalDbAvailable()) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }

    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains(STORE_ANNOTATIONS)) {
        const s = db.createObjectStore(STORE_ANNOTATIONS, { keyPath: 'id' });
        s.createIndex('by_lecture', 'lectureId', { unique: false });
        s.createIndex('by_lecture_page', ['lectureId', 'page'], { unique: false });
        s.createIndex('by_updated', 'updatedAt', { unique: false });
      }
      // Downloaded PDF bytes. Keyed by URL to match how useOfflinePDF already
      // thinks about them.
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS, { keyPath: 'url' });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
      // v2. Keyed by lecture id, not by URL: an admin re-upload mints a new
      // pdfUrl, and anything keyed on the URL silently stops matching.
      if (!db.objectStoreNames.contains(STORE_OFFLINE_LECTURES)) {
        db.createObjectStore(STORE_OFFLINE_LECTURES, { keyPath: 'id' });
      }
      // v3. Personal Space ("مساحتك") stores for local student files and folders.
      if (!db.objectStoreNames.contains(STORE_USER_FOLDERS)) {
        const sf = db.createObjectStore(STORE_USER_FOLDERS, { keyPath: 'id' });
        sf.createIndex('by_user', 'userId', { unique: false });
        sf.createIndex('by_user_parent', ['userId', 'parentId'], { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_USER_FILES)) {
        const sfi = db.createObjectStore(STORE_USER_FILES, { keyPath: 'id' });
        sfi.createIndex('by_user', 'userId', { unique: false });
        sfi.createIndex('by_user_folder', ['userId', 'folderId'], { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_USER_BLOBS)) {
        db.createObjectStore(STORE_USER_BLOBS, { keyPath: 'id' });
      }
      // v4. Schedule images (الجدول الأصلي) and stage homeworks
      if (!db.objectStoreNames.contains(STORE_SCHEDULE_IMAGES)) {
        db.createObjectStore(STORE_SCHEDULE_IMAGES, { keyPath: 'stageId' });
      }
      if (!db.objectStoreNames.contains(STORE_OFFLINE_HOMEWORKS)) {
        db.createObjectStore(STORE_OFFLINE_HOMEWORKS, { keyPath: 'stageId' });
      }
      if (!db.objectStoreNames.contains(STORE_ATTENDANCE_OUTBOX)) {
        const attendance = db.createObjectStore(STORE_ATTENDANCE_OUTBOX, { keyPath: 'requestId' });
        attendance.createIndex('by_owner', 'ownerUid', { unique: false });
        attendance.createIndex('by_owner_session', ['ownerUid', 'sessionId'], { unique: false });
        attendance.createIndex('by_owner_occurrence', ['ownerUid', 'occurrenceId'], { unique: false });
        attendance.createIndex('by_owner_status', ['ownerUid', 'status'], { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_ATTENDANCE_STATE)) {
        db.createObjectStore(STORE_ATTENDANCE_STATE, { keyPath: 'ownerUid' });
      }
      const attendanceOutbox = req.transaction!.objectStore(STORE_ATTENDANCE_OUTBOX);
      if (!attendanceOutbox.indexNames.contains('by_session')) attendanceOutbox.createIndex('by_session', 'sessionId');
      if (!db.objectStoreNames.contains(STORE_ATTENDANCE_LOCKS)) {
        db.createObjectStore(STORE_ATTENDANCE_LOCKS, { keyPath: 'sessionId' });
      }
      if (!db.objectStoreNames.contains(STORE_ATTENDANCE_COMMANDS)) {
        const commands = db.createObjectStore(STORE_ATTENDANCE_COMMANDS, { keyPath: 'requestId' });
        commands.createIndex('by_owner', 'ownerUid');
      }
    };

    req.onsuccess = () => {
      const db = req.result;
      // Another tab opened a newer version; let go so it can upgrade.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB blocked by another tab'));
  });

  // A failed open must not be cached forever - a later call may succeed.
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(db => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const dbGet = <T>(store: string, key: IDBValidKey) =>
  run<T | undefined>(store, 'readonly', s => s.get(key));

export const dbPut = <T>(store: string, value: T) =>
  run<IDBValidKey>(store, 'readwrite', s => s.put(value as any));

export const dbDelete = (store: string, key: IDBValidKey) =>
  run<undefined>(store, 'readwrite', s => s.delete(key));

export const dbGetAllByIndex = <T>(store: string, index: string, query: IDBValidKey | IDBKeyRange) =>
  run<T[]>(store, 'readonly', s => s.index(index).getAll(query));

export const dbCountByIndex = (store: string, index: string, query: IDBValidKey | IDBKeyRange) =>
  run<number>(store, 'readonly', s => s.index(index).count(query));

/**
 * Every record in a store.
 *
 * Only safe on small stores - never call it on STORE_BLOBS, which holds whole
 * PDFs and would pull every downloaded lecture into memory at once.
 */
export const dbGetAll = <T>(store: string) =>
  run<T[]>(store, 'readonly', s => s.getAll());

/** Attendance writes resolve only after the full transaction commits. The
 * generic helpers above intentionally retain their old behavior for callers
 * that may depend on request-level completion. */
function attendanceTransaction(db: IDBDatabase, store: string | string[]): IDBTransaction {
  try {
    return db.transaction(store, 'readwrite', { durability: 'strict' });
  } catch {
    return db.transaction(store, 'readwrite');
  }
}

export function attendanceDurablePut<T>(store: string, value: T): Promise<IDBValidKey> {
  return openDb().then(db => new Promise<IDBValidKey>((resolve, reject) => {
    const tx = attendanceTransaction(db, store);
    const request = tx.objectStore(store).put(value as any);
    let key: IDBValidKey | undefined;
    request.onsuccess = () => { key = request.result; };
    request.onerror = () => reject(request.error || new Error('Attendance evidence write failed'));
    tx.oncomplete = () => key === undefined
      ? reject(new Error('Attendance evidence committed without a key'))
      : resolve(key);
    tx.onabort = () => reject(tx.error || new Error('Attendance evidence transaction aborted'));
    tx.onerror = () => reject(tx.error || new Error('Attendance evidence transaction failed'));
  }));
}

export function commitDoctorAttendanceSession<T extends { requestId: string; ownerUid: string }>(meta: { key: string; data: unknown }, command: T): Promise<void> {
  return openDb().then(database => new Promise<void>((resolve, reject) => {
    const transaction = attendanceTransaction(database, [STORE_META, STORE_ATTENDANCE_COMMANDS]);
    const store = transaction.objectStore(STORE_META);
    const commands = transaction.objectStore(STORE_ATTENDANCE_COMMANDS);
    const existing = commands.get(command.requestId);
    existing.onsuccess = () => {
      const order = store.get('attendance-command-sequence');
      order.onsuccess = () => {
        const sequence = existing.result?.localOrder ?? Number(order.result?.value || 0) + 1;
        if (!existing.result) store.put({ key: 'attendance-command-sequence', value: sequence });
        store.put({ ...meta, ownerUid: command.ownerUid });
        commands.put({ ...command, localOrder: sequence });
      };
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('attendance_not_saved'));
    transaction.onerror = () => reject(transaction.error || new Error('attendance_not_saved'));
  }));
}

/** The callback must be synchronous: keep lease selection and writes in one transaction. */
export async function transactAttendanceReceipts<T>(
  mutate: (receipts: LocalAttendanceReceipt[], put: (receipt: LocalAttendanceReceipt) => void) => T,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = attendanceTransaction(db, STORE_ATTENDANCE_OUTBOX);
    const store = tx.objectStore(STORE_ATTENDANCE_OUTBOX);
    let result: T;
    let failure: unknown;
    store.getAll().onsuccess = event => {
      try {
        result = mutate((event.target as IDBRequest).result, receipt => { store.put(receipt); });
      } catch (error) {
        failure = error;
        tx.abort();
      }
    };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(failure || tx.error || new Error('attendance_not_saved'));
    tx.onerror = () => reject(tx.error || new Error('attendance_not_saved'));
  });
}

export const listAttendanceReceipts = <T>(ownerUid: string) =>
  dbGetAllByIndex<T>(STORE_ATTENDANCE_OUTBOX, 'by_owner', IDBKeyRange.only(ownerUid));

export const getAttendanceReceipt = <T>(requestId: string) =>
  dbGet<T>(STORE_ATTENDANCE_OUTBOX, requestId);

export const saveAttendanceReceipt = <T>(receipt: T) =>
  attendanceDurablePut(STORE_ATTENDANCE_OUTBOX, receipt);

export const getAttendanceState = <T>(ownerUid: string) =>
  dbGet<T>(STORE_ATTENDANCE_STATE, ownerUid);

export const saveAttendanceState = <T>(state: T) =>
  attendanceDurablePut(STORE_ATTENDANCE_STATE, state);

export async function commitAttendanceCapture(receipt: LocalAttendanceReceipt, conflictSignature?: string): Promise<{ receipt: LocalAttendanceReceipt; alreadySaved: boolean }> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = attendanceTransaction(db, [STORE_ATTENDANCE_OUTBOX, STORE_ATTENDANCE_LOCKS]);
    const outbox = tx.objectStore(STORE_ATTENDANCE_OUTBOX);
    const locks = tx.objectStore(STORE_ATTENDANCE_LOCKS);
    let result: { receipt: LocalAttendanceReceipt; alreadySaved: boolean };
    const existing = outbox.index('by_session').getAll(receipt.sessionId);
    existing.onsuccess = () => {
      const saved = existing.result as LocalAttendanceReceipt[];
      const duplicate = saved.find(item => item.ownerUid === receipt.ownerUid && item.status !== 'invalid');
      if (duplicate) {
        result = { receipt: duplicate, alreadySaved: true };
        return;
      }
      const lock = locks.get(receipt.sessionId);
      lock.onsuccess = () => {
        const ownerUid = lock.result?.ownerUid || saved.find(item => !item.localDeviceConflict && item.status !== 'invalid')?.ownerUid || receipt.ownerUid;
        const localDeviceConflict = ownerUid !== receipt.ownerUid;
        const committed = { ...receipt, localDeviceConflict, deviceSignature: localDeviceConflict ? conflictSignature : receipt.deviceSignature };
        locks.put({ sessionId: receipt.sessionId, ownerUid });
        outbox.put(committed);
        result = { receipt: committed, alreadySaved: false };
      };
    };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || new Error('attendance_not_saved'));
    tx.onerror = () => reject(tx.error || new Error('attendance_not_saved'));
  });
}

export interface AttendanceInstallation {
  key: 'attendance_installation_id';
  value: string;
  privateKey: CryptoKey;
  publicKey: JsonWebKey;
}

export async function getOrCreateAttendanceInstallation(candidate: AttendanceInstallation): Promise<AttendanceInstallation> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = attendanceTransaction(db, STORE_META);
    const store = tx.objectStore(STORE_META);
    const request = store.get(candidate.key);
    let result: AttendanceInstallation;
    request.onsuccess = () => {
      result = request.result?.privateKey ? request.result : { ...candidate, value: request.result?.value || candidate.value };
      if (!request.result?.privateKey) store.put(result);
    };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || new Error('attendance_not_saved'));
    tx.onerror = () => reject(tx.error || new Error('attendance_not_saved'));
  });
}

export async function changeAttendanceReceipt(requestId: string, update: (current: LocalAttendanceReceipt) => LocalAttendanceReceipt): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = attendanceTransaction(db, STORE_ATTENDANCE_OUTBOX);
    const store = tx.objectStore(STORE_ATTENDANCE_OUTBOX);
    const request = store.get(requestId);
    request.onsuccess = () => { if (request.result) store.put(update(request.result)); };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('attendance_not_saved'));
    tx.onerror = () => reject(tx.error || new Error('attendance_not_saved'));
  });
}

/**
 * The snapshot of a lecture taken when its PDF was downloaded.
 *
 * Only what the Downloads tab needs to render a row and open the reader. It is a
 * COPY, deliberately: the point is to survive the Firestore listener returning
 * nothing, so it cannot depend on that listener.
 */
export interface OfflineLecture {
  id: string;
  title: string;
  pdfUrl: string;
  subjectId?: string | null;
  stageId?: string | null;
  number?: number | null;
  type?: string | null;
  savedAt: number;
}

export const saveOfflineLecture = (rec: OfflineLecture) =>
  dbPut<OfflineLecture>(STORE_OFFLINE_LECTURES, rec);

export const listOfflineLectures = async (): Promise<OfflineLecture[]> => {
  try {
    const { isNativePlatform, listNativeOfflineLectures } = await import('./nativePdfRepository');
    if (await isNativePlatform()) {
      return await listNativeOfflineLectures();
    }
  } catch {}
  return dbGetAll<OfflineLecture>(STORE_OFFLINE_LECTURES);
};

export const removeOfflineLecture = (id: string) =>
  dbDelete(STORE_OFFLINE_LECTURES, id);

/**
 * Cached weekly schedule image ("الجدول الأصلي") blob per stage.
 */
export interface OfflineScheduleImage {
  stageId: string;
  photoUrl: string;
  blob: Blob;
  updatedAt: number;
}

export const saveOfflineScheduleImage = (rec: OfflineScheduleImage) =>
  dbPut<OfflineScheduleImage>(STORE_SCHEDULE_IMAGES, rec);

export const getOfflineScheduleImage = (stageId: string) =>
  dbGet<OfflineScheduleImage>(STORE_SCHEDULE_IMAGES, stageId);

export const removeOfflineScheduleImage = (stageId: string) =>
  dbDelete(STORE_SCHEDULE_IMAGES, stageId);

/**
 * Cached homework list for a stage.
 */
export interface OfflineStageHomeworks {
  stageId: string;
  homeworks: any[];
  updatedAt: number;
}

export const saveOfflineHomeworks = (stageId: string, homeworks: any[]) =>
  dbPut<OfflineStageHomeworks>(STORE_OFFLINE_HOMEWORKS, { stageId, homeworks, updatedAt: Date.now() });

export const getOfflineHomeworks = async <T = any>(stageId: string): Promise<T[]> => {
  try {
    const rec = await dbGet<OfflineStageHomeworks>(STORE_OFFLINE_HOMEWORKS, stageId);
    return (rec?.homeworks as T[]) ?? [];
  } catch (err) {
    console.warn('[localDb] getOfflineHomeworks failed:', err);
    return [];
  }
};

/** Deletes every record matching an index query, in one transaction. */
export function dbDeleteByIndex(store: string, index: string, query: IDBValidKey | IDBKeyRange): Promise<number> {
  return openDb().then(db => new Promise<number>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const cursorReq = tx.objectStore(store).index(index).openCursor(query);
    let removed = 0;
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) { cursor.delete(); removed++; cursor.continue(); }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
    tx.oncomplete = () => resolve(removed);
    tx.onabort = () => reject(tx.error);
  }));
}

// ============================================================================
// Personal Space ("مساحتك") Types & Local Operations
// ============================================================================

export interface UserFolder {
  id: string;
  userId: string;
  name: string;
  parentId: string; // '' for root folder
  color?: string;
  createdAt: number;
  updatedAt: number;
}

export interface UserFile {
  id: string;
  userId: string;
  folderId: string; // '' for root folder
  name: string;
  size: number;
  pageCount?: number;
  createdAt: number;
  updatedAt: number;
}

export interface UserFileBlob {
  id: string;
  blob: Blob;
}

function generateLocalId(): string {
  return secureRequestId();
}

export async function createUserFolder(
  data: Omit<UserFolder, 'id' | 'createdAt' | 'updatedAt'>
): Promise<UserFolder> {
  const now = Date.now();
  const folder: UserFolder = {
    ...data,
    id: generateLocalId(),
    parentId: data.parentId || '',
    createdAt: now,
    updatedAt: now,
  };
  await dbPut<UserFolder>(STORE_USER_FOLDERS, folder);
  return folder;
}

export async function getUserFolders(userId: string, parentId: string = ''): Promise<UserFolder[]> {
  try {
    const range = IDBKeyRange.only([userId, parentId]);
    const items = await dbGetAllByIndex<UserFolder>(STORE_USER_FOLDERS, 'by_user_parent', range);
    return items.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  } catch {
    const all = await dbGetAllByIndex<UserFolder>(STORE_USER_FOLDERS, 'by_user', IDBKeyRange.only(userId));
    return all.filter(f => (f.parentId || '') === parentId).sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  }
}

export async function getAllUserFolders(userId: string): Promise<UserFolder[]> {
  try {
    const items = await dbGetAllByIndex<UserFolder>(STORE_USER_FOLDERS, 'by_user', IDBKeyRange.only(userId));
    return items;
  } catch {
    const all = await dbGetAll<UserFolder>(STORE_USER_FOLDERS);
    return all.filter(f => f.userId === userId);
  }
}

export async function renameUserFolder(folderId: string, newName: string): Promise<void> {
  const folder = await dbGet<UserFolder>(STORE_USER_FOLDERS, folderId);
  if (!folder) return;
  folder.name = newName.trim();
  folder.updatedAt = Date.now();
  await dbPut<UserFolder>(STORE_USER_FOLDERS, folder);
}

export async function deleteUserFolderCascade(
  userId: string,
  folderId: string
): Promise<{ deletedFolders: number; deletedFiles: number }> {
  const allFolders = await getAllUserFolders(userId);
  const allFiles = (await dbGetAll<UserFile>(STORE_USER_FILES)).filter(f => f.userId === userId);

  // Collect all descendant folder IDs recursively
  const folderIdsToDelete = new Set<string>([folderId]);
  let added = true;
  while (added) {
    added = false;
    for (const f of allFolders) {
      if (!folderIdsToDelete.has(f.id) && f.parentId && folderIdsToDelete.has(f.parentId)) {
        folderIdsToDelete.add(f.id);
        added = true;
      }
    }
  }

  // Find all files belonging to these folders
  const filesToDelete = allFiles.filter(f => folderIdsToDelete.has(f.folderId));

  // 1. Delete file blobs and records
  for (const file of filesToDelete) {
    await dbDelete(STORE_USER_BLOBS, file.id);
    await dbDelete(STORE_USER_FILES, file.id);
    // Also remove any annotations saved for this local file
    try {
      await dbDeleteByIndex(STORE_ANNOTATIONS, 'by_lecture', file.id);
    } catch { /* best effort */ }
  }

  // 2. Delete folders
  for (const fId of folderIdsToDelete) {
    await dbDelete(STORE_USER_FOLDERS, fId);
  }

  return {
    deletedFolders: folderIdsToDelete.size,
    deletedFiles: filesToDelete.length,
  };
}

export async function saveUserFile(
  data: Omit<UserFile, 'id' | 'createdAt' | 'updatedAt'>,
  blob: Blob
): Promise<UserFile> {
  const now = Date.now();
  const file: UserFile = {
    ...data,
    id: generateLocalId(),
    folderId: data.folderId || '',
    createdAt: now,
    updatedAt: now,
  };
  await dbPut<UserFileBlob>(STORE_USER_BLOBS, { id: file.id, blob });
  await dbPut<UserFile>(STORE_USER_FILES, file);
  return file;
}

export async function getUserFiles(userId: string, folderId: string = ''): Promise<UserFile[]> {
  try {
    const range = IDBKeyRange.only([userId, folderId]);
    const items = await dbGetAllByIndex<UserFile>(STORE_USER_FILES, 'by_user_folder', range);
    return items.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    const all = await dbGetAllByIndex<UserFile>(STORE_USER_FILES, 'by_user', IDBKeyRange.only(userId));
    return all.filter(f => (f.folderId || '') === folderId).sort((a, b) => b.createdAt - a.createdAt);
  }
}

export async function renameUserFile(fileId: string, newName: string): Promise<void> {
  const file = await dbGet<UserFile>(STORE_USER_FILES, fileId);
  if (!file) return;
  file.name = newName.trim();
  file.updatedAt = Date.now();
  await dbPut<UserFile>(STORE_USER_FILES, file);
}

export async function moveUserFile(fileId: string, targetFolderId: string = ''): Promise<void> {
  const file = await dbGet<UserFile>(STORE_USER_FILES, fileId);
  if (!file) return;
  file.folderId = targetFolderId || '';
  file.updatedAt = Date.now();
  await dbPut<UserFile>(STORE_USER_FILES, file);
}

export async function deleteUserFile(fileId: string): Promise<void> {
  await dbDelete(STORE_USER_BLOBS, fileId);
  await dbDelete(STORE_USER_FILES, fileId);
  try {
    await dbDeleteByIndex(STORE_ANNOTATIONS, 'by_lecture', fileId);
  } catch { /* best effort */ }
}

export async function getUserFileBlob(fileId: string): Promise<Blob | null> {
  const rec = await dbGet<UserFileBlob>(STORE_USER_BLOBS, fileId);
  return rec?.blob ?? null;
}

export async function searchUserFiles(userId: string, query: string): Promise<UserFile[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const all = (await dbGetAll<UserFile>(STORE_USER_FILES)).filter(f => f.userId === userId);
  return all.filter(f => f.name.toLowerCase().includes(q));
}

export const FREE_PERSONAL_SPACE_FILE_LIMIT = 6;

export async function countAllUserFiles(userId: string): Promise<number> {
  try {
    const count = await dbCountByIndex(STORE_USER_FILES, 'by_user', IDBKeyRange.only(userId));
    return typeof count === 'number' ? count : 0;
  } catch {
    const all = await dbGetAll<UserFile>(STORE_USER_FILES);
    return all.filter(f => f.userId === userId).length;
  }
}


