import { useState, useEffect, useCallback, useRef } from 'react';
import {
  STORE_BLOBS, dbGet, dbPut, dbDelete, isLocalDbAvailable,
  saveOfflineLecture, removeOfflineLecture, type OfflineLecture,
} from '../lib/localDb';
import {
  isNativePlatform,
  isNativeLectureDownloaded,
  downloadAndPublishLecture,
  readNativePdfBytes,
  removeNativePdf,
} from '../lib/nativePdfRepository';

/**
 * Downloaded lecture PDFs, kept on the device.
 *
 * On iOS and Android (Capacitor native builds), files are stored directly in the
 * native filesystem (Directory.Data) via NativePdfRepository and downloaded via
 * @capacitor/file-transfer. This is immune to WebKit IndexedDB wiping, storage
 * limits, or Safari Lockdown Mode restrictions.
 *
 * On Web/PWA, IndexedDB remains the storage mechanism.
 */

const LEGACY_CACHE = 'offline-pdfs-v1';

interface StoredPdf {
  url: string;
  blob: Blob;
  savedAt: number;
}

/** One-time rescue of anything the old cache still happens to hold. */
async function migrateFromCacheStorage(url: string): Promise<Blob | null> {
  if (typeof window === 'undefined' || !('caches' in window)) return null;
  try {
    const cache = await caches.open(LEGACY_CACHE);
    const hit = await cache.match(url);
    if (!hit) return null;
    const blob = await hit.blob();
    await dbPut<StoredPdf>(STORE_BLOBS, { url, blob, savedAt: Date.now() });
    await cache.delete(url);
    return blob;
  } catch {
    return null;
  }
}

/**
 * Stored bytes for a URL / lecture, or null. Standalone so the reader can prefer the
 * downloaded copy without needing the hook's React lifecycle.
 */
export async function readStoredPdf(url: string, lectureId?: string): Promise<ArrayBuffer | null> {
  if (await isNativePlatform()) {
    const nativeBytes = await readNativePdfBytes(lectureId, url);
    if (nativeBytes) return nativeBytes;
  }

  if (!isLocalDbAvailable()) return null;
  try {
    const rec = await dbGet<StoredPdf>(STORE_BLOBS, url);
    return rec?.blob ? await rec.blob.arrayBuffer() : null;
  } catch {
    return null;
  }
}

/**
 * @param meta Snapshot of the lecture, stored alongside the bytes so the
 *   Downloads tab can list it when the Firestore listener has nothing.
 *   Omitting it still downloads, but the lecture is only reachable while
 *   the lecture list itself is available.
 */
export function useOfflinePDF(
  pdfUrl: string | undefined,
  lectureId?: string,
  meta?: Omit<OfflineLecture, 'savedAt'>,
) {
  const [isDownloaded, setIsDownloaded] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [offlineUrl, setOfflineUrl] = useState<string | null>(null);

  // Revoking on unmount alone leaks whenever the URL is replaced mid-life.
  const objectUrlRef = useRef<string | null>(null);

  const setObjectUrl = useCallback((blob: Blob | null) => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = blob ? URL.createObjectURL(blob) : null;
    setOfflineUrl(objectUrlRef.current);
  }, []);

  const checkIsDownloaded = useCallback(async () => {
    if (!pdfUrl) return;

    if (await isNativePlatform()) {
      const downloaded = await isNativeLectureDownloaded(lectureId, pdfUrl);
      setIsDownloaded(downloaded);
      if (downloaded) {
        try {
          if (lectureId && !localStorage.getItem(`pdf_${lectureId}`)) {
            localStorage.setItem(`pdf_${lectureId}`, Date.now().toString());
          }
        } catch {}
      } else {
        try {
          if (lectureId) localStorage.removeItem(`pdf_${lectureId}`);
        } catch {}
      }
      return;
    }

    if (!isLocalDbAvailable()) return;
    try {
      let rec = await dbGet<StoredPdf>(STORE_BLOBS, pdfUrl);
      let blob = rec?.blob ?? null;

      if (!blob) blob = await migrateFromCacheStorage(pdfUrl);

      if (blob) {
        setIsDownloaded(true);
        setObjectUrl(blob);
        try {
          if (lectureId && !localStorage.getItem(`pdf_${lectureId}`)) {
            localStorage.setItem(`pdf_${lectureId}`, Date.now().toString());
          }
        } catch {}
      } else {
        setIsDownloaded(false);
        setObjectUrl(null);
        try {
          if (lectureId) localStorage.removeItem(`pdf_${lectureId}`);
        } catch {}
      }
    } catch (error) {
      console.error('Error checking offline store:', error);
    }
  }, [pdfUrl, lectureId, setObjectUrl]);

  useEffect(() => {
    checkIsDownloaded();
  }, [checkIsDownloaded]);

  // Release the blob URL only when the hook itself goes away.
  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
  }, []);

  /** Raw bytes for the in-app reader, skipping the blob-URL round trip. */
  const getBytes = useCallback(async (): Promise<ArrayBuffer | null> => {
    if (!pdfUrl) return null;
    if (await isNativePlatform()) {
      return readNativePdfBytes(lectureId, pdfUrl);
    }

    if (!isLocalDbAvailable()) return null;
    try {
      const rec = await dbGet<StoredPdf>(STORE_BLOBS, pdfUrl);
      return rec?.blob ? await rec.blob.arrayBuffer() : null;
    } catch {
      return null;
    }
  }, [pdfUrl, lectureId]);

  const downloadPDF = async () => {
    if (!pdfUrl) return;

    setIsDownloading(true);
    setDownloadProgress(0);

    try {
      if (await isNativePlatform()) {
        const payload: Omit<OfflineLecture, 'savedAt'> = {
          id: lectureId || meta?.id || 'unknown',
          title: meta?.title || 'محاضرة',
          pdfUrl,
          subjectId: meta?.subjectId || null,
          stageId: meta?.stageId || null,
          number: meta?.number || null,
          type: meta?.type || null,
        };

        const result = await downloadAndPublishLecture(payload, (pct) => {
          setDownloadProgress(pct);
        });

        if (!result.success) {
          throw new Error(result.error || 'Failed to download lecture natively');
        }

        try {
          if (lectureId) localStorage.setItem(`pdf_${lectureId}`, Date.now().toString());
        } catch {}

        await checkIsDownloaded();
        return;
      }

      // Web fallback
      if (!isLocalDbAvailable()) {
        alert('التخزين على الجهاز غير متاح في هذا المتصفح.');
        return;
      }

      const response = await fetch(pdfUrl);
      if (!response.ok) throw new Error('Network response was not ok');

      const contentLength = response.headers.get('content-length');
      const total = contentLength ? parseInt(contentLength, 10) : 0;

      let blob: Blob;
      if (total === 0 || !response.body) {
        blob = await response.blob();
      } else {
        const reader = response.body.getReader();
        const chunks: BlobPart[] = [];
        let loaded = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value as unknown as BlobPart);
          loaded += value.length;
          setDownloadProgress(Math.round((loaded / total) * 100));
        }
        blob = new Blob(chunks, { type: 'application/pdf' });
      }

      await dbPut<StoredPdf>(STORE_BLOBS, { url: pdfUrl, blob, savedAt: Date.now() });
      try {
        if (lectureId) localStorage.setItem(`pdf_${lectureId}`, Date.now().toString());
      } catch {}

      if (meta?.id) {
        try {
          await saveOfflineLecture({ ...meta, savedAt: Date.now() });
        } catch (err) {
          console.error('Saved the PDF but failed to record its metadata:', err);
        }
      }

      await checkIsDownloaded();
    } catch (error) {
      console.error('Error downloading PDF:', error);
      const diagnostic = await isNativePlatform()
        ? ` (${String((error as any)?.message || '').split(':', 1)[0] || 'FILE_UNKNOWN'})`
        : '';
      if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
        alert(`تعذّر تنزيل الملف. تحقق من اتصالك بالإنترنت.${diagnostic}`);
      } else {
        alert(`تعذّر تنزيل الملف للقراءة بدون إنترنت.${diagnostic}`);
      }
    } finally {
      setIsDownloading(false);
      setDownloadProgress(0);
    }
  };

  /**
   * Removes the downloaded bytes.
   *
   * Deliberately leaves annotations alone: this is about reclaiming space, and
   * a student's highlights are not the app's to discard alongside the file.
   * Deleting notes is its own confirmed action in the reader's notes drawer.
   */
  const removePDF = async () => {
    if (!pdfUrl) return;

    try {
      if (await isNativePlatform()) {
        if (lectureId) {
          await removeNativePdf(lectureId);
          try { localStorage.removeItem(`pdf_${lectureId}`); } catch {}
        }
        setIsDownloaded(false);
        setObjectUrl(null);
        return;
      }

      if (!isLocalDbAvailable()) return;
      await dbDelete(STORE_BLOBS, pdfUrl);
      setIsDownloaded(false);
      setObjectUrl(null);
      if (lectureId) {
        try { localStorage.removeItem(`pdf_${lectureId}`); } catch {}
        await removeOfflineLecture(lectureId).catch(() => {});
      }
    } catch (error) {
      console.error('Error removing offline PDF:', error);
    }
  };

  return {
    isDownloaded,
    isDownloading,
    downloadProgress,
    offlineUrl,
    getBytes,
    downloadPDF,
    removePDF,
  };
}
