import { useState, useEffect, useCallback, useRef } from 'react';
import {
  STORE_BLOBS, dbGet, dbPut, dbDelete, isLocalDbAvailable,
  saveOfflineLecture, removeOfflineLecture, type OfflineLecture,
} from '../lib/localDb';

/**
 * Downloaded lecture PDFs, kept on the device.
 *
 * These used to live in CacheStorage under 'offline-pdfs-v1'. They cannot any
 * more: the native build registers a self-destroying service worker (see
 * vite.config.ts `selfDestroying`) whose activate handler calls caches.keys()
 * and deletes EVERY cache, with no allowlist - and registerSW re-registers it on
 * every page load. Downloads were therefore wiped on each launch, and because
 * checkIsDownloaded() removes the `pdf_${id}` marker when the bytes are missing,
 * the Downloads tab emptied itself too.
 *
 * IndexedDB is untouched by that worker, so the bytes now live there. The
 * localStorage marker stays exactly as it was - HomeScreen's DownloadsTab scans
 * it synchronously to build the list.
 */

const LEGACY_CACHE = 'offline-pdfs-v1';

interface StoredPdf {
  url: string;
  blob: Blob;
  savedAt: number;
}

/** One-time rescue of anything the old cache still happens to hold. */
async function migrateFromCacheStorage(url: string): Promise<Blob | null> {
  if (!('caches' in window)) return null;
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
 * Stored bytes for a URL, or null. Standalone so the reader can prefer the
 * downloaded copy without needing the hook's React lifecycle.
 */
export async function readStoredPdf(url: string): Promise<ArrayBuffer | null> {
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
    if (!pdfUrl || !isLocalDbAvailable()) return;
    try {
      let rec = await dbGet<StoredPdf>(STORE_BLOBS, pdfUrl);
      let blob = rec?.blob ?? null;

      if (!blob) blob = await migrateFromCacheStorage(pdfUrl);

      if (blob) {
        setIsDownloaded(true);
        setObjectUrl(blob);
        if (lectureId && !localStorage.getItem(`pdf_${lectureId}`)) {
          localStorage.setItem(`pdf_${lectureId}`, Date.now().toString());
        }
      } else {
        setIsDownloaded(false);
        setObjectUrl(null);
        if (lectureId) localStorage.removeItem(`pdf_${lectureId}`);
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
    if (!pdfUrl || !isLocalDbAvailable()) return null;
    try {
      const rec = await dbGet<StoredPdf>(STORE_BLOBS, pdfUrl);
      return rec?.blob ? await rec.blob.arrayBuffer() : null;
    } catch {
      return null;
    }
  }, [pdfUrl]);

  const downloadPDF = async () => {
    if (!pdfUrl) return;
    if (!isLocalDbAvailable()) {
      alert('التخزين على الجهاز غير متاح في هذا المتصفح.');
      return;
    }

    setIsDownloading(true);
    setDownloadProgress(0);

    try {
      const response = await fetch(pdfUrl);
      if (!response.ok) throw new Error('Network response was not ok');

      const contentLength = response.headers.get('content-length');
      const total = contentLength ? parseInt(contentLength, 10) : 0;

      let blob: Blob;
      if (total === 0 || !response.body) {
        // No length header - no progress to report, just take the bytes.
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
      if (lectureId) localStorage.setItem(`pdf_${lectureId}`, Date.now().toString());

      // Without this the bytes are unreachable offline: the Downloads tab lists
      // lectures from the Firestore listener, which yields nothing with no
      // network. Best-effort - a failure here must not undo a good download.
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
      if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
        // Lectures are served from Firebase Storage; a cross-origin GET needs
        // that bucket's CORS policy to allow this origin.
        alert('تعذّر تنزيل الملف. تحقق من إعدادات CORS في Firebase Storage.');
        console.info(
          '%cHow to fix the CORS error:', 'font-size: 16px; font-weight: bold;',
          '\n\n1. Go to the Google Cloud Console: https://console.cloud.google.com/',
          '\n2. Click the terminal icon (Activate Cloud Shell) in the top right.',
          '\n3. Run this command to create a cors.json file:',
          '\n   echo \'[{"origin": ["*"],"method": ["GET"],"maxAgeSeconds": 3600}]\' > cors.json',
          '\n4. Run this command to apply it to your bucket:',
          '\n   gsutil cors set cors.json gs://mylectures-app.firebasestorage.app',
        );
      } else {
        alert('تعذّر تنزيل الملف للقراءة بدون إنترنت.');
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
    if (!pdfUrl || !isLocalDbAvailable()) return;
    try {
      await dbDelete(STORE_BLOBS, pdfUrl);
      setIsDownloaded(false);
      setObjectUrl(null);
      if (lectureId) {
        localStorage.removeItem(`pdf_${lectureId}`);
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
