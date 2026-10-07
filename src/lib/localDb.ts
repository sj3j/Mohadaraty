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

const DB_NAME = 'mylecture-local';
const DB_VERSION = 4;

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

export const listOfflineLectures = () =>
  dbGetAll<OfflineLecture>(STORE_OFFLINE_LECTURES);

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
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 9);
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


