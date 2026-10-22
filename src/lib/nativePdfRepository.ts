/**
 * Native PDF Repository for iOS and Android.
 *
 * Provides persistent offline storage backed by @capacitor/filesystem (Directory.Data)
 * and @capacitor/file-transfer. Operates as the primary repository on mobile platforms,
 * eliminating all dependencies on WebKit IndexedDB, FileReader, and in-webview fetch.
 */

import type { OfflineLecture } from './localDb';
import type { PdfAnnotation, DocMeta } from '../types/pdfAnnotation.types';

const LECTURES_DIR = 'lectures';
const STAGING_DIR = 'staging';
const ANNOTATIONS_DIR = 'annotations';
const MANIFEST_FILE = 'offline_manifest.json';
const MIGRATION_FLAG_FILE = 'migration_completed.flag';

export interface DownloadResult {
  success: boolean;
  localPath?: string;
  error?: string;
}

export type ProgressCallback = (percent: number) => void;

/**
 * Detects whether the current runtime is a native Capacitor platform (iOS or Android).
 */
export async function isNativePlatform(): Promise<boolean> {
  try {
    const { Capacitor } = await import('@capacitor/core');
    return Capacitor?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

/**
 * Helper to get Filesystem and Directory lazily.
 */
async function getFs() {
  if ((globalThis as any).__mockFs) {
    return {
      Filesystem: (globalThis as any).__mockFs,
      Directory: { Data: 'DATA', Cache: 'CACHE' },
      Encoding: { UTF8: 'utf8' },
    };
  }
  const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
  return { Filesystem, Directory, Encoding };
}

/**
 * Helper to get FileTransfer lazily.
 */
async function getTransfer() {
  if ((globalThis as any).__mockFt) {
    return { FileTransfer: (globalThis as any).__mockFt };
  }
  const { FileTransfer } = await import('@capacitor/file-transfer');
  return { FileTransfer };
}

/**
 * Converts a base64 string to an ArrayBuffer in memory without using FileReader.
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  // Strip any data URI prefix if present
  const cleanBase64 = base64.includes(',') ? base64.split(',')[1] : base64;
  const binaryString = atob(cleanBase64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Converts an ArrayBuffer to a base64 string in memory without using FileReader.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

/**
 * Ensures necessary directories exist inside Directory.Data.
 */
async function ensureDirectoriesExist(): Promise<void> {
  const { Filesystem, Directory } = await getFs();
  const dirs = [LECTURES_DIR, STAGING_DIR, ANNOTATIONS_DIR];
  for (const dir of dirs) {
    try {
      await Filesystem.mkdir({ path: dir, directory: Directory.Data, recursive: true });
    } catch {
      // Directory already exists or cannot be created; stat check will catch failures later
    }
  }
}

/**
 * Loads the offline lectures manifest from Directory.Data.
 */
export async function loadNativeManifest(): Promise<Record<string, OfflineLecture>> {
  try {
    const { Filesystem, Directory, Encoding } = await getFs();
    const result = await Filesystem.readFile({
      path: MANIFEST_FILE,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    });
    const content = typeof result.data === 'string' ? result.data : '';
    return content ? JSON.parse(content) : {};
  } catch {
    return {};
  }
}

/**
 * Atomically saves the offline lectures manifest using a temporary file.
 */
export async function saveNativeManifest(manifest: Record<string, OfflineLecture>): Promise<void> {
  const { Filesystem, Directory, Encoding } = await getFs();
  const tempPath = `${MANIFEST_FILE}.tmp`;
  const data = JSON.stringify(manifest, null, 2);

  await Filesystem.writeFile({
    path: tempPath,
    data,
    directory: Directory.Data,
    encoding: Encoding.UTF8,
    recursive: true,
  });

  await Filesystem.rename({
    from: tempPath,
    to: MANIFEST_FILE,
    directory: Directory.Data,
  });
}

/**
 * Lists all offline lectures recorded in the native repository.
 */
export async function listNativeOfflineLectures(): Promise<OfflineLecture[]> {
  const manifest = await loadNativeManifest();
  return Object.values(manifest);
}

/**
 * Checks whether a lecture is downloaded and verified on the native filesystem.
 */
export async function isNativeLectureDownloaded(lectureId?: string, pdfUrl?: string): Promise<boolean> {
  if (!lectureId && !pdfUrl) return false;
  try {
    const manifest = await loadNativeManifest();
    let entry: OfflineLecture | undefined;
    if (lectureId && manifest[lectureId]) {
      entry = manifest[lectureId];
    } else if (pdfUrl) {
      entry = Object.values(manifest).find(item => item.pdfUrl === pdfUrl);
    }
    if (!entry) return false;

    const id = entry.id || lectureId;
    if (!id) return false;

    const { Filesystem, Directory } = await getFs();
    const stat = await Filesystem.stat({
      path: `${LECTURES_DIR}/${id}.pdf`,
      directory: Directory.Data,
    });

    return (stat?.size ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Downloads a lecture using @capacitor/file-transfer into a staging file,
 * verifies completion and non-zero size, then publishes the file and its metadata.
 */
export async function downloadAndPublishLecture(
  lecture: Omit<OfflineLecture, 'savedAt'>,
  onProgress?: ProgressCallback,
): Promise<DownloadResult> {
  const timestamp = Date.now();
  const stagingPath = `${STAGING_DIR}/${lecture.id}_${timestamp}.tmp`;
  const publishedPath = `${LECTURES_DIR}/${lecture.id}.pdf`;

  let listenerHandle: any = null;
  let Filesystem: any;
  let Directory: any;
  let published = false;

  try {
    // Plugin loading and directory setup can fail on a malformed native build.
    // Keep that failure on the same recoverable path as a failed transfer.
    await ensureDirectoriesExist();
    ({ Filesystem, Directory } = await getFs());
    const { FileTransfer } = await getTransfer();
    const { uri: destinationUri } = await Filesystem.getUri({
      path: stagingPath,
      directory: Directory.Data,
    });

    if (onProgress) {
      listenerHandle = await FileTransfer.addListener('progress', (status: any) => {
        if (status.type === 'download' && status.lengthComputable && status.contentLength > 0) {
          const percent = Math.min(100, Math.round((status.bytes / status.contentLength) * 100));
          onProgress(percent);
        }
      });
    }

    await FileTransfer.downloadFile({
      url: lecture.pdfUrl,
      path: destinationUri,
      progress: !!onProgress,
    });

    // Validate the staged download
    const stat = await Filesystem.stat({
      path: stagingPath,
      directory: Directory.Data,
    });

    if (!stat || (stat.size ?? 0) <= 0) {
      throw new Error('Downloaded file is empty or missing');
    }

    // Atomically move staging file to published destination
    await Filesystem.rename({
      from: stagingPath,
      to: publishedPath,
      directory: Directory.Data,
    });
    published = true;

    // Update manifest
    const manifest = await loadNativeManifest();
    manifest[lecture.id] = {
      ...lecture,
      savedAt: timestamp,
    };
    await saveNativeManifest(manifest);

    return { success: true, localPath: publishedPath };
  } catch (err: any) {
    console.error('[NativePdfRepository] Download failed:', err);
    // Cleanup temporary file
    if (Filesystem && Directory) {
      try {
        await Filesystem.deleteFile({
          path: stagingPath,
          directory: Directory.Data,
        });
      } catch {
        // Ignore cleanup error
      }
      if (published) {
        try {
          await Filesystem.deleteFile({
            path: publishedPath,
            directory: Directory.Data,
          });
        } catch {
          // Ignore cleanup error
        }
      }
    }
    return { success: false, error: err?.message || 'Download failed' };
  } finally {
    if (listenerHandle?.remove) {
      listenerHandle.remove();
    }
  }
}

/**
 * Reads binary bytes for a downloaded lecture directly from Directory.Data.
 * Bypasses IndexedDB and FileReader.
 */
export async function readNativePdfBytes(lectureId?: string, pdfUrl?: string): Promise<ArrayBuffer | null> {
  try {
    let targetId = lectureId;
    if (!targetId && pdfUrl) {
      const manifest = await loadNativeManifest();
      const match = Object.values(manifest).find(l => l.pdfUrl === pdfUrl);
      if (match) targetId = match.id;
    }
    if (!targetId) return null;

    const { Filesystem, Directory } = await getFs();
    const result = await Filesystem.readFile({
      path: `${LECTURES_DIR}/${targetId}.pdf`,
      directory: Directory.Data,
    });

    if (!result?.data) return null;

    if (typeof result.data === 'string') {
      return base64ToArrayBuffer(result.data);
    }
    if (result.data instanceof Blob) {
      return await result.data.arrayBuffer();
    }
    return null;
  } catch (err) {
    console.warn('[NativePdfRepository] readNativePdfBytes failed:', err);
    return null;
  }
}

/**
 * Removes a downloaded lecture and updates the native manifest.
 */
export async function removeNativePdf(lectureId: string): Promise<void> {
  try {
    const { Filesystem, Directory } = await getFs();
    try {
      await Filesystem.deleteFile({
        path: `${LECTURES_DIR}/${lectureId}.pdf`,
        directory: Directory.Data,
      });
    } catch {
      // Ignore if file doesn't exist
    }

    const manifest = await loadNativeManifest();
    if (manifest[lectureId]) {
      delete manifest[lectureId];
      await saveNativeManifest(manifest);
    }
  } catch (err) {
    console.error('[NativePdfRepository] removeNativePdf failed:', err);
  }
}

/**
 * Copies a local downloaded file into Directory.Cache/shared, or downloads directly to cache
 * if not already downloaded, returning the native file:// URI for Share.share().
 * ZERO FileReader or base64 conversion is performed.
 */
export async function getNativeShareUri(
  lectureId: string | undefined,
  safeFileName: string,
  remoteUrl: string,
): Promise<string> {
  const { Filesystem, Directory } = await getFs();
  const cachePath = `shared/${safeFileName}`;

  // Ensure shared directory exists in cache
  try {
    await Filesystem.mkdir({ path: 'shared', directory: Directory.Cache, recursive: true });
  } catch {
    // Ignore if exists
  }

  // 1. If lecture is downloaded, copy from Directory.Data to Directory.Cache
  if (lectureId) {
    const publishedPath = `${LECTURES_DIR}/${lectureId}.pdf`;
    try {
      const stat = await Filesystem.stat({ path: publishedPath, directory: Directory.Data });
      if ((stat?.size ?? 0) > 0) {
        await Filesystem.copy({
          from: publishedPath,
          directory: Directory.Data,
          to: cachePath,
          toDirectory: Directory.Cache,
        });
        const { uri } = await Filesystem.getUri({ path: cachePath, directory: Directory.Cache });
        return uri;
      }
    } catch {
      // File not present in local repository, fall through to native download
    }
  }

  // 2. Not downloaded locally: download directly to Directory.Cache/shared using native FileTransfer
  const { FileTransfer } = await getTransfer();
  const { uri: targetUri } = await Filesystem.getUri({ path: cachePath, directory: Directory.Cache });

  await FileTransfer.downloadFile({
    url: remoteUrl,
    path: targetUri,
  });

  return targetUri;
}

// ============================================================================
// PDF Annotations & DocMeta Native Storage (Lockdown Mode Resilient)
// ============================================================================

export async function listNativeAnnotations(lectureId: string): Promise<PdfAnnotation[]> {
  try {
    const { Filesystem, Directory, Encoding } = await getFs();
    const result = await Filesystem.readFile({
      path: `${ANNOTATIONS_DIR}/${lectureId}.json`,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    });
    const content = typeof result.data === 'string' ? result.data : '';
    return content ? JSON.parse(content) : [];
  } catch {
    return [];
  }
}

export async function saveNativeAnnotation(annotation: PdfAnnotation): Promise<boolean> {
  try {
    await ensureDirectoriesExist();
    const { Filesystem, Directory, Encoding } = await getFs();
    const existing = await listNativeAnnotations(annotation.lectureId);
    const index = existing.findIndex(a => a.id === annotation.id);
    const updated = [...existing];
    if (index >= 0) {
      updated[index] = annotation;
    } else {
      updated.push(annotation);
    }

    await Filesystem.writeFile({
      path: `${ANNOTATIONS_DIR}/${annotation.lectureId}.json`,
      data: JSON.stringify(updated, null, 2),
      directory: Directory.Data,
      encoding: Encoding.UTF8,
      recursive: true,
    });
    return true;
  } catch (err) {
    console.error('[NativePdfRepository] saveNativeAnnotation failed:', err);
    return false;
  }
}

export async function deleteNativeAnnotation(id: string, lectureId: string): Promise<boolean> {
  try {
    const { Filesystem, Directory, Encoding } = await getFs();
    const existing = await listNativeAnnotations(lectureId);
    const filtered = existing.filter(a => a.id !== id);

    await Filesystem.writeFile({
      path: `${ANNOTATIONS_DIR}/${lectureId}.json`,
      data: JSON.stringify(filtered, null, 2),
      directory: Directory.Data,
      encoding: Encoding.UTF8,
      recursive: true,
    });
    return true;
  } catch (err) {
    console.error('[NativePdfRepository] deleteNativeAnnotation failed:', err);
    return false;
  }
}

export async function deleteAllNativeAnnotations(lectureId: string): Promise<number> {
  try {
    const { Filesystem, Directory } = await getFs();
    const existing = await listNativeAnnotations(lectureId);
    try {
      await Filesystem.deleteFile({
        path: `${ANNOTATIONS_DIR}/${lectureId}.json`,
        directory: Directory.Data,
      });
    } catch {
      // Ignore if file doesn't exist
    }
    return existing.length;
  } catch {
    return 0;
  }
}

export async function getNativeDocMeta(lectureId: string): Promise<DocMeta | null> {
  try {
    const { Filesystem, Directory, Encoding } = await getFs();
    const result = await Filesystem.readFile({
      path: `${ANNOTATIONS_DIR}/meta_${lectureId}.json`,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    });
    const content = typeof result.data === 'string' ? result.data : '';
    return content ? JSON.parse(content) : null;
  } catch {
    return null;
  }
}

export async function setNativeDocMeta(lectureId: string, meta: Partial<DocMeta>): Promise<void> {
  try {
    await ensureDirectoriesExist();
    const { Filesystem, Directory, Encoding } = await getFs();
    const prev = await getNativeDocMeta(lectureId);
    const merged = { ...prev, ...meta, updatedAt: Date.now() };

    await Filesystem.writeFile({
      path: `${ANNOTATIONS_DIR}/meta_${lectureId}.json`,
      data: JSON.stringify(merged, null, 2),
      directory: Directory.Data,
      encoding: Encoding.UTF8,
      recursive: true,
    });
  } catch (err) {
    console.error('[NativePdfRepository] setNativeDocMeta failed:', err);
  }
}

// ============================================================================
// Migration: Legacy IndexedDB -> Native Repository
// ============================================================================

export async function migrateLegacyIndexedDbToNative(): Promise<{
  migratedLectures: number;
  migratedBlobs: number;
  migratedAnnotations: number;
}> {
  const result = { migratedLectures: 0, migratedBlobs: 0, migratedAnnotations: 0 };

  if (!(await isNativePlatform())) return result;

  try {
    const { Filesystem, Directory, Encoding } = await getFs();
    // Check if migration already ran
    try {
      const check = await Filesystem.stat({
        path: MIGRATION_FLAG_FILE,
        directory: Directory.Data,
      });
      if (check) return result; // Already migrated
    } catch {
      // Flag not found, proceed
    }

    const { isLocalDbAvailable, openDb, STORE_OFFLINE_LECTURES, STORE_BLOBS, STORE_ANNOTATIONS, STORE_META } =
      await import('./localDb');

    if (!isLocalDbAvailable()) {
      return result; // IndexedDB unavailable; nothing to migrate from
    }

    const db = await openDb().catch(() => null);
    if (!db) return result;

    await ensureDirectoriesExist();

    // 1. Migrate offline lectures metadata
    try {
      const txLectures = db.transaction(STORE_OFFLINE_LECTURES, 'readonly');
      const reqLectures = txLectures.objectStore(STORE_OFFLINE_LECTURES).getAll();
      const lectures: OfflineLecture[] = await new Promise((res, rej) => {
        reqLectures.onsuccess = () => res(reqLectures.result || []);
        reqLectures.onerror = () => rej(reqLectures.error);
      });

      if (lectures.length > 0) {
        const manifest = await loadNativeManifest();
        for (const l of lectures) {
          if (!manifest[l.id]) {
            manifest[l.id] = l;
            result.migratedLectures++;
          }
        }
        await saveNativeManifest(manifest);
      }
    } catch (e) {
      console.warn('[Migration] Failed migrating offline lectures:', e);
    }

    // 2. Migrate PDF blobs to native files
    try {
      const txBlobs = db.transaction(STORE_BLOBS, 'readonly');
      const reqBlobs = txBlobs.objectStore(STORE_BLOBS).getAll();
      const blobs: { url: string; blob: Blob; savedAt: number }[] = await new Promise((res, rej) => {
        reqBlobs.onsuccess = () => res(reqBlobs.result || []);
        reqBlobs.onerror = () => rej(reqBlobs.error);
      });

      const manifest = await loadNativeManifest();
      for (const item of blobs) {
        const match = Object.values(manifest).find(l => l.pdfUrl === item.url);
        if (match && item.blob) {
          const filePath = `${LECTURES_DIR}/${match.id}.pdf`;
          try {
            const stat = await Filesystem.stat({ path: filePath, directory: Directory.Data });
            if ((stat?.size ?? 0) > 0) continue; // Already written
          } catch {
            // Need to write
          }

          const buf = await item.blob.arrayBuffer();
          const base64 = arrayBufferToBase64(buf);
          await Filesystem.writeFile({
            path: filePath,
            data: base64,
            directory: Directory.Data,
            recursive: true,
          });
          result.migratedBlobs++;
        }
      }
    } catch (e) {
      console.warn('[Migration] Failed migrating blobs:', e);
    }

    // 3. Migrate annotations
    try {
      const txAnn = db.transaction(STORE_ANNOTATIONS, 'readonly');
      const reqAnn = txAnn.objectStore(STORE_ANNOTATIONS).getAll();
      const annotations: PdfAnnotation[] = await new Promise((res, rej) => {
        reqAnn.onsuccess = () => res(reqAnn.result || []);
        reqAnn.onerror = () => rej(reqAnn.error);
      });

      const byLecture = new Map<string, PdfAnnotation[]>();
      for (const a of annotations) {
        const list = byLecture.get(a.lectureId) || [];
        list.push(a);
        byLecture.set(a.lectureId, list);
      }

      for (const [lectureId, items] of byLecture.entries()) {
        const existing = await listNativeAnnotations(lectureId);
        if (existing.length === 0) {
          await Filesystem.writeFile({
            path: `${ANNOTATIONS_DIR}/${lectureId}.json`,
            data: JSON.stringify(items, null, 2),
            directory: Directory.Data,
            encoding: Encoding.UTF8,
            recursive: true,
          });
          result.migratedAnnotations += items.length;
        }
      }
    } catch (e) {
      console.warn('[Migration] Failed migrating annotations:', e);
    }

    // Mark migration completed
    await Filesystem.writeFile({
      path: MIGRATION_FLAG_FILE,
      data: JSON.stringify({ completedAt: Date.now(), result }),
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    });
  } catch (err) {
    console.error('[Migration] Migration error:', err);
  }

  return result;
}

/**
 * Returns the native local file path/URI for a downloaded lecture PDF, or null if not saved.
 */
export async function getNativePdfFilePath(lectureId?: string, url?: string): Promise<string | null> {
  if (!(await isNativePlatform())) return null;

  try {
    const { Filesystem, Directory } = await getFs();
    if (lectureId) {
      const publishedPath = `${LECTURES_DIR}/${lectureId}.pdf`;
      try {
        const stat = await Filesystem.stat({ path: publishedPath, directory: Directory.Data });
        if (stat && (stat.size ?? 0) > 0) {
          const { uri } = await Filesystem.getUri({ path: publishedPath, directory: Directory.Data });
          return uri;
        }
      } catch {}
    }

    if (url) {
      const manifest = await loadNativeManifest();
      for (const [id, item] of Object.entries(manifest)) {
        if (item.pdfUrl === url) {
          const publishedPath = `${LECTURES_DIR}/${id}.pdf`;
          try {
            const stat = await Filesystem.stat({ path: publishedPath, directory: Directory.Data });
            if (stat && (stat.size ?? 0) > 0) {
              const { uri } = await Filesystem.getUri({ path: publishedPath, directory: Directory.Data });
              return uri;
            }
          } catch {}
        }
      }
    }
  } catch (err) {
    console.warn('[NativePdfRepository] getNativePdfFilePath failed:', err);
  }

  return null;
}

/**
 * Caches an in-memory PDF buffer into the native cache directory and returns its native file path/URI.
 */
export async function cacheNativePdfBytes(lectureId: string, buffer: ArrayBuffer): Promise<string | null> {
  if (!(await isNativePlatform())) return null;

  try {
    const { Filesystem, Directory } = await getFs();
    const cacheFileName = `temp_${lectureId || Date.now()}.pdf`;
    const base64Data = arrayBufferToBase64(buffer);

    await Filesystem.writeFile({
      path: cacheFileName,
      data: base64Data,
      directory: Directory.Cache,
      recursive: true,
    });

    const { uri } = await Filesystem.getUri({
      path: cacheFileName,
      directory: Directory.Cache,
    });

    return uri;
  } catch (err) {
    console.error('[NativePdfRepository] cacheNativePdfBytes failed:', err);
    return null;
  }
}

