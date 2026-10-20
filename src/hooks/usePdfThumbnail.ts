import { useState, useEffect } from 'react';
import { STORE_META, dbGet, dbPut, isLocalDbAvailable } from '../lib/localDb';
import { loadPdfjs, PDFJS_DOC_OPTIONS, fetchPdfBytes, freshBytes } from '../lib/pdfjs';
import { readStoredPdf } from './useOfflinePDF';

interface CachedThumbEntry {
  dataUrl: string;
  aspectRatio: number;
}

const memoryCache = new Map<string, CachedThumbEntry>();

interface UsePdfThumbnailResult {
  thumbnail: string | null;
  aspectRatio: number;
  isLoading: boolean;
  error: boolean;
}

/**
 * Hook to retrieve or generate a cached page 1 thumbnail for a lecture PDF.
 * Checks memory cache -> IndexedDB -> renders offscreen with pdfjs-dist.
 * Calculates exact slide aspect ratio so slides auto-fit without horizontal cropping.
 */
export function usePdfThumbnail(
  lectureId: string | undefined,
  pdfUrl: string | undefined,
  enabled: boolean = true
): UsePdfThumbnailResult {
  const [thumbnail, setThumbnail] = useState<string | null>(() => {
    if (lectureId && memoryCache.has(lectureId)) {
      return memoryCache.get(lectureId)!.dataUrl;
    }
    return null;
  });
  const [aspectRatio, setAspectRatio] = useState<number>(() => {
    if (lectureId && memoryCache.has(lectureId)) {
      return memoryCache.get(lectureId)!.aspectRatio;
    }
    return 16 / 9;
  });
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<boolean>(false);

  useEffect(() => {
    if (!enabled || !lectureId || !pdfUrl) {
      return;
    }

    if (memoryCache.has(lectureId)) {
      const entry = memoryCache.get(lectureId)!;
      setThumbnail(entry.dataUrl);
      setAspectRatio(entry.aspectRatio);
      setIsLoading(false);
      setError(false);
      return;
    }

    let isCancelled = false;
    const abortController = new AbortController();

    async function load() {
      setIsLoading(true);
      setError(false);

      try {
        // 1. Check persistent IndexedDB cache
        if (isLocalDbAvailable()) {
          try {
            const cached = await dbGet<{ key: string; dataUrl: string; aspectRatio?: number }>(
              STORE_META,
              `pdf_thumb_${lectureId}`
            );
            if (cached?.dataUrl) {
              const ratio = cached.aspectRatio && cached.aspectRatio > 0.2 ? cached.aspectRatio : 16 / 9;
              if (!isCancelled) {
                memoryCache.set(lectureId, { dataUrl: cached.dataUrl, aspectRatio: ratio });
                setThumbnail(cached.dataUrl);
                setAspectRatio(ratio);
                setIsLoading(false);
              }
              return;
            }
          } catch (e) {
            console.warn('[usePdfThumbnail] IndexedDB cache read failed:', e);
          }
        }

        if (isCancelled) return;

        // 2. Fetch or retrieve PDF bytes
        let bytes: ArrayBuffer | null = await readStoredPdf(pdfUrl, lectureId).catch(() => null);
        if (!bytes) {
          bytes = await fetchPdfBytes(pdfUrl, abortController.signal);
        }

        if (isCancelled || !bytes) return;

        // 3. Load pdf.js and render page 1 to offscreen canvas
        const pdfjs = await loadPdfjs();
        if (isCancelled) return;

        const loadingTask = pdfjs.getDocument({
          data: freshBytes(bytes),
          ...PDFJS_DOC_OPTIONS,
        });

        const doc = await loadingTask.promise;
        if (isCancelled) {
          try { (doc as any)?.destroy?.(); } catch {}
          return;
        }

        try {
          const page = await doc.getPage(1);
          if (isCancelled) return;

          const unscaledVp = page.getViewport({ scale: 1 });
          const measuredRatio = Number((unscaledVp.width / unscaledVp.height).toFixed(3)) || 16 / 9;

          // Target width ~600px for crisp retina display across mobile and desktop
          const targetWidth = Math.min(800, Math.max(480, Math.round(unscaledVp.width * 0.75)));
          const scale = Math.min(2.5, Math.max(0.3, targetWidth / unscaledVp.width));
          const viewport = page.getViewport({ scale });

          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          const ctx = canvas.getContext('2d');

          if (!ctx) {
            throw new Error('Canvas 2D context unavailable');
          }

          const renderTask = page.render({
            canvasContext: ctx,
            viewport,
            canvas: null as any,
          });

          await renderTask.promise;
          if (isCancelled) return;

          const dataUrl = canvas.toDataURL('image/jpeg', 0.85);

          // 4. Save to memory cache and IndexedDB
          memoryCache.set(lectureId, { dataUrl, aspectRatio: measuredRatio });
          if (isLocalDbAvailable()) {
            dbPut(STORE_META, {
              key: `pdf_thumb_${lectureId}`,
              dataUrl,
              aspectRatio: measuredRatio,
              savedAt: Date.now(),
            }).catch(e => console.warn('[usePdfThumbnail] IndexedDB write failed:', e));
          }

          if (!isCancelled) {
            setThumbnail(dataUrl);
            setAspectRatio(measuredRatio);
            setIsLoading(false);
          }
        } finally {
          try { (doc as any)?.destroy?.(); } catch {}
        }
      } catch (err: any) {
        if (!isCancelled && err?.name !== 'AbortError') {
          console.warn('[usePdfThumbnail] Failed to generate thumbnail:', err);
          setError(true);
          setIsLoading(false);
        }
      }
    }

    load();

    return () => {
      isCancelled = true;
      abortController.abort();
    };
  }, [lectureId, pdfUrl, enabled]);

  return { thumbnail, aspectRatio, isLoading, error };
}
