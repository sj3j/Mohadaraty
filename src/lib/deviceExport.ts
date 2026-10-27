import { safeFileName } from './shareFileName';
import { forceDownload } from './utils';
import { IS_MACOS_BUILD } from './platform';
import { macFiles } from '../macos/macBridge';
import { isNativeFileCancellation, nativeFileErrorCode, saveNativePdf } from './nativeFileTransfer';

export interface DeviceExportInput {
  url: string;
  title: string;
  lectureId: string;
}

export interface DeviceExportResult {
  success: boolean;
  cancelled?: boolean;
  message?: string;
  errorCode?: string;
}

/**
 * Exports a PDF directly to the user's device storage:
 * - Android: Attempts to copy/save to public Documents/Downloads folder via Filesystem,
 *   falling back to opening the system file sheet with the prepared file.
 * - iOS: Opens the system file sheet (Share / Save to Files) with the prepared file.
 * - Web/EXE (PC): Triggers direct browser/Electron download using forceDownload.
 */
export async function exportPdfToDevice(input: DeviceExportInput): Promise<DeviceExportResult> {
  const filename = safeFileName(input.title, 'pdf');

  if (IS_MACOS_BUILD) {
    const result = await macFiles.saveRemoteFile(input.url, filename, 'application/pdf');
    return { success: result.status !== 'cancelled' };
  }

  let isNative = false;
  if ((globalThis as any).__mockIsNative !== undefined) {
    isNative = (globalThis as any).__mockIsNative;
  } else {
    try {
      const { Capacitor } = await import('@capacitor/core');
      isNative = Capacitor?.isNativePlatform?.() === true;
    } catch {
      isNative = false;
    }
  }

  if (!isNative) {
    // Web / PC (EXE) browser download
    await forceDownload(input.url, filename);
    return { success: true, message: 'جاري تنزيل الملف على جهازك' };
  }

  const { Capacitor } = await import('@capacitor/core');
  const platform = (globalThis as any).__mockPlatform || Capacitor.getPlatform();

  if (platform === 'android' || platform === 'ios') {
    try {
      const { getNativeShareUri } = await import('./nativePdfRepository');
      // Reuses a verified offline copy when available; otherwise stages one
      // native download without putting the PDF in the WebView heap.
      const sourceUri = await getNativeShareUri(input.lectureId, filename, input.url);
      const result = await saveNativePdf(sourceUri, filename);
      if (result.status === 'cancelled') return { success: false, cancelled: true };
      return {
        success: true,
        message: platform === 'android'
          ? 'تم حفظ المحاضرة في مجلد التنزيلات / Mohadaraty'
          : 'تم حفظ المحاضرة في الملفات / على الـ iPhone / محاضراتي',
      };
    } catch (error) {
      if (isNativeFileCancellation(error)) return { success: false, cancelled: true };
      const errorCode = nativeFileErrorCode(error);
      console.error('[deviceExport] Native save failed:', { errorCode, error });
      return { success: false, errorCode };
    }
  }

  await forceDownload(input.url, filename);
  return { success: true, message: 'جاري تنزيل الملف' };
}
