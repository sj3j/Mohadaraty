/**
 * PDF Export Service using pdf-lib.
 *
 * Renders vector strokes (pen and highlighter with correct opacity/blending)
 * and text notes onto a duplicate/copy of the original lecture PDF.
 *
 * Guarantees:
 * 1. The original PDF file is NEVER modified or overwritten.
 * 2. Works completely offline.
 * 3. Incorporates all pages, not just the visible page.
 * 4. Respects page orientation, dimensions, and normalized page coordinates.
 */

import { PDFDocument, rgb, StandardFonts, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import reshaperModule, { convertArabic } from 'arabic-persian-reshaper';
import type { CanonicalAnnotation, CanonicalInkAnnotation, CanonicalTextAnnotation } from '../types/canonicalAnnotation.types';
import { loadCanonicalDocument } from './unifiedPdfAnnotationService';
import { readStoredPdf } from '../hooks/useOfflinePDF';
import { isNativePlatform } from '../lib/nativePdfRepository';

function reshapeArabic(text: string): string {
  if (typeof convertArabic === 'function') {
    return convertArabic(text);
  }
  const anyMod = reshaperModule as any;
  if (typeof anyMod?.convertArabic === 'function') {
    return anyMod.convertArabic(text);
  }
  if (typeof anyMod?.ArabicShaper?.convertArabic === 'function') {
    return anyMod.ArabicShaper.convertArabic(text);
  }
  return text;
}

export interface PdfExportOptions {
  lectureId: string;
  /** Account-scoped canonical document key; defaults to legacy lectureId. */
  annotationDocumentId?: string;
  lectureTitle: string;
  pdfUrl?: string;
  pdfArrayBuffer?: ArrayBuffer;
  onProgress?: (percent: number, message: string) => void;
}

export interface PdfExportResult {
  success: boolean;
  exportedBlob?: Blob;
  exportedBytes?: Uint8Array;
  error?: string;
}

/**
 * Converts a hex color string (#rrggbb) to pdf-lib RGB format [0..1].
 */
export function hexToPdfRgb(hex: string): { r: number; g: number; b: number } {
  let clean = hex.replace('#', '').trim();
  if (clean.length === 3) {
    clean = clean.split('').map((c) => c + c).join('');
  }
  const intVal = parseInt(clean, 16);
  if (isNaN(intVal)) {
    return { r: 0.31, g: 0.27, b: 0.9 }; // Default indigo
  }
  return {
    r: ((intVal >> 16) & 255) / 255,
    g: ((intVal >> 8) & 255) / 255,
    b: (intVal & 255) / 255,
  };
}

// In-memory cache for loaded Tajawal font bytes across exports
let cachedFontBytes: Uint8Array | null = null;

/**
 * Loads Tajawal font bytes across Web, Capacitor mobile, and Node testing environments.
 */
export async function loadTajawalFontBytes(): Promise<Uint8Array | null> {
  if (cachedFontBytes) {
    return cachedFontBytes;
  }

  // 1. Try Node.js filesystem (used in test runners and scripts)
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    try {
      const fs = await import('fs');
      const path = await import('path');
      const candidatePaths = [
        path.resolve(process.cwd(), 'public/fonts/Tajawal-Regular.ttf'),
        path.resolve(process.cwd(), 'dist/fonts/Tajawal-Regular.ttf'),
      ];
      // __dirname is absent in the ESM test/browser build. Do not let that
      // optional fallback prevent the process.cwd() candidates from running.
      if (typeof __dirname !== 'undefined') {
        candidatePaths.push(path.resolve(__dirname, '../../public/fonts/Tajawal-Regular.ttf'));
      }
      for (const p of candidatePaths) {
        if (fs.existsSync(p)) {
          const buf = fs.readFileSync(p);
          cachedFontBytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
          return cachedFontBytes;
        }
      }
    } catch {
      // Not in a Node.js filesystem environment
    }
  }

  // 2. Try browser / Capacitor fetch from public assets
  if (typeof fetch === 'function') {
    const urls = ['/fonts/Tajawal-Regular.ttf', 'fonts/Tajawal-Regular.ttf'];
    for (const u of urls) {
      try {
        const res = await fetch(u);
        if (res.ok) {
          const ab = await res.arrayBuffer();
          cachedFontBytes = new Uint8Array(ab);
          return cachedFontBytes;
        }
      } catch {
        // Continue to next URL candidate
      }
    }
  }

  return null;
}

/**
 * Shapes Arabic text with contextual glyph forms and lays out lines in visual order
 * for PDF-lib coordinate rendering (RTL visual bidi handling).
 */
export function shapeAndOrderText(text: string): string {
  const hasArabic = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text);
  if (!hasArabic) {
    return text;
  }

  try {
    // 1. Reshape Arabic letters into contextual Presentation Forms
    const reshaped = reshapeArabic(text);

    // 2. Tokenize preserving Latin word phrases (including spaces between Latin words/numbers) vs Arabic words vs punctuation
    const tokens = reshaped.match(/[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]+|[A-Za-z0-9_.-]+(?:\s+[A-Za-z0-9_.-]+)*|\s+|[^\s\w\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/g) || [reshaped];

    // 3. For visual RTL presentation:
    // Arabic characters within a token are drawn right-to-left (so their character sequence is reversed)
    // Latin / number tokens keep standard left-to-right character sequence
    const processedTokens = tokens.map((tok) => {
      if (/[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(tok)) {
        return tok.split('').reverse().join('');
      }
      return tok;
    });

    // 4. Reverse the order of tokens on the line for RTL reading direction
    return processedTokens.reverse().join('');
  } catch (err) {
    console.warn('[PdfExportService] Arabic shaping fallback to raw text:', err);
    return text;
  }
}

/**
 * Generates an annotated PDF document without modifying the original.
 */
export async function exportAnnotatedPdf(options: PdfExportOptions): Promise<PdfExportResult> {
  const { lectureId, annotationDocumentId = lectureId, lectureTitle, pdfUrl, pdfArrayBuffer, onProgress } = options;

  try {
    onProgress?.(10, 'Loading original lecture PDF...');
    let sourceBuffer: ArrayBuffer | null = pdfArrayBuffer || null;

    if (!sourceBuffer && pdfUrl) {
      // 1. Try local offline blobs or native cache
      sourceBuffer = await readStoredPdf(pdfUrl, lectureId);
    }

    // 2. Try native mobile filesystem if on Capacitor
    if (!sourceBuffer && (await isNativePlatform())) {
      try {
        const { Filesystem, Directory } = await import('@capacitor/filesystem');
        const fileResult = await Filesystem.readFile({
          path: `lectures/${lectureId}.pdf`,
          directory: Directory.Data,
        });
        if (fileResult.data) {
          const { base64ToArrayBuffer } = await import('../lib/nativePdfRepository');
          sourceBuffer = base64ToArrayBuffer(fileResult.data as string);
        }
      } catch {
        // Native file reading failed, will fall back to fetch
      }
    }

    // 3. Fallback to web fetch if online
    if (!sourceBuffer && pdfUrl) {
      const res = await fetch(pdfUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching PDF`);
      sourceBuffer = await res.arrayBuffer();
    }

    if (!sourceBuffer) {
      throw new Error('Original PDF data could not be retrieved.');
    }

    onProgress?.(30, 'Parsing PDF document...');
    const pdfDoc = await PDFDocument.load(sourceBuffer, { ignoreEncryption: true });
    pdfDoc.registerFontkit(fontkit);

    const pages = pdfDoc.getPages();
    const pageCount = pages.length;

    onProgress?.(50, 'Loading canonical annotations...');
    let docState = await loadCanonicalDocument(annotationDocumentId, pageCount);
    // Account-scoped V3 data wins. A legacy document is read only when V3 has
    // no annotations, preserving historical exports without auto-migrating
    // viewport-relative geometry.
    if (annotationDocumentId !== lectureId && Object.keys(docState.annotationsByPage).length === 0) {
      docState = await loadCanonicalDocument(lectureId, pageCount);
    }

    // Load Unicode font for Arabic & English annotations
    let unicodeFont: PDFFont | null = null;
    const fontBytes = await loadTajawalFontBytes();
    if (fontBytes) {
      try {
        unicodeFont = await pdfDoc.embedFont(fontBytes);
      } catch (fontErr) {
        console.warn('[PdfExportService] Tajawal font embedding failed, falling back:', fontErr);
      }
    }
    const textAnnotations = Object.values(docState.annotationsByPage)
      .flatMap((annotations) => annotations.filter((annotation): annotation is CanonicalTextAnnotation => annotation.kind === 'text'));
    const requiresUnicodeFont = textAnnotations.some((annotation) =>
      /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(annotation.text),
    );
    // Replacing missing Arabic glyphs with spaces produces a technically valid
    // but academically unusable PDF. Export must fail loudly instead.
    if (requiresUnicodeFont && !unicodeFont) {
      throw new Error('Required Tajawal font could not be embedded for text annotations.');
    }
    const helveticaFallback = unicodeFont ? null : await pdfDoc.embedFont(StandardFonts.Helvetica);
    const activeFont = unicodeFont || helveticaFallback;

    onProgress?.(70, 'Rendering annotations onto pages...');
    for (let pIndex = 0; pIndex < pageCount; pIndex++) {
      const pageNum = pIndex + 1;
      const page = pages[pIndex];
      // Canonical coordinates are relative to the visible crop box, not the
      // media box. PDF pages can have a non-zero crop origin and a different
      // crop size; using getSize() silently displaces annotations on them.
      const cropBox = page.getCropBox();
      const pageWidth = cropBox.width;
      const pageHeight = cropBox.height;
      const annotations: CanonicalAnnotation[] = docState.annotationsByPage[pageNum] || [];

      for (const anno of annotations) {
        if (anno.kind === 'ink' || anno.kind === 'highlighter') {
          const ink = anno as CanonicalInkAnnotation;
          if (!ink.points || ink.points.length < 2) continue;

          const colorRgb = hexToPdfRgb(ink.color);
          const pdfColor = rgb(colorRgb.r, colorRgb.g, colorRgb.b);
          const isHighlighter = ink.kind === 'highlighter';
          const strokeWidth = ink.width || (isHighlighter ? 20 : 3);
          const opacity = ink.opacity ?? (isHighlighter ? 0.38 : 1.0);

          // Draw vector stroke segments in PDF coordinates (Y is inverted: 0 at bottom)
          for (let i = 0; i < ink.points.length - 1; i++) {
            const p1 = ink.points[i];
            const p2 = ink.points[i + 1];

            const x1 = cropBox.x + p1.x * pageWidth;
            const y1 = cropBox.y + (1.0 - p1.y) * pageHeight;
            const x2 = cropBox.x + p2.x * pageWidth;
            const y2 = cropBox.y + (1.0 - p2.y) * pageHeight;

            page.drawLine({
              start: { x: x1, y: y1 },
              end: { x: x2, y: y2 },
              thickness: strokeWidth,
              color: pdfColor,
              opacity: opacity,
            });
          }
        } else if (anno.kind === 'text') {
          const textAnno = anno as CanonicalTextAnnotation;
          if (!textAnno.text) continue;

          const colorRgb = hexToPdfRgb(textAnno.color || '#4f46e5');
          const pdfColor = rgb(colorRgb.r, colorRgb.g, colorRgb.b);
          const fontSize = textAnno.fontSize === 'lg' ? 18 : textAnno.fontSize === 'sm' ? 11 : 14;

          const x = cropBox.x + (textAnno.point?.x ?? 0.1) * pageWidth;
          const y = cropBox.y + (1.0 - (textAnno.point?.y ?? 0.1)) * pageHeight;

          const lines = textAnno.text.split('\n');
          lines.forEach((lineText, lineIdx) => {
            const shapedText = shapeAndOrderText(lineText);
            const lineY = y - (lineIdx * fontSize * 1.25);

            page.drawText(shapedText, {
              x: Math.max(cropBox.x + 10, Math.min(cropBox.x + pageWidth - 60, x)),
              y: Math.max(cropBox.y + 10, Math.min(cropBox.y + pageHeight - 20, lineY)),
              size: fontSize,
              font: activeFont!,
              color: pdfColor,
            });
          });
        }
      }
    }

    onProgress?.(90, 'Finalizing annotated PDF document...');
    const pdfBytes = await pdfDoc.save();
    const exportedBlob = new Blob([pdfBytes], { type: 'application/pdf' });

    onProgress?.(100, 'Export completed successfully!');
    return {
      success: true,
      exportedBlob,
      exportedBytes: pdfBytes,
    };
  } catch (error: any) {
    console.error('[PdfExportService] Export failed:', error);
    return {
      success: false,
      error: error?.message || 'Unknown export error',
    };
  }
}

