import { safeFileName } from './shareFileName';
import { forceDownload } from './utils';
import { IS_MACOS_BUILD } from './platform';
import { macFiles } from '../macos/macBridge';
import { isNativeFileCancellation, nativeFileErrorCode, saveNativePdf } from './nativeFileTransfer';

export interface DeviceExportInput {
  url: string;
  title: string;
  lectureId: string;
  lang?: 'ar' | 'en';
}

export interface DeviceExportResult {
  success: boolean;
  cancelled?: boolean;
  message?: string;
  errorCode?: string;
  uri?: string;
}

/**
 * Exports a PDF directly to the user's device storage:
 * - Android: Saves directly to the public Downloads folder with MediaScanner indexing,
 *   returning the content URI so it can be opened immediately.
 * - iOS: Saves to the visible Documents sandbox and opens the native iOS Action Sheet
 *   (UIActivityViewController) so the user can choose "Save to Files" or open in their chosen app.
 * - Web/EXE (PC): Triggers direct browser/Electron download using forceDownload.
 */
export async function exportPdfToDevice(input: DeviceExportInput): Promise<DeviceExportResult> {
  const filename = safeFileName(input.title, 'pdf');
  const isRtl = input.lang !== 'en';

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
    return {
      success: true,
      message: isRtl ? 'جاري تنزيل الملف على جهازك' : 'Downloading file to your device',
    };
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
        uri: result.uri,
        message: platform === 'android'
          ? (isRtl ? 'تم حفظ المحاضرة في مجلد التنزيلات' : 'Lecture saved to Downloads folder')
          : (isRtl ? 'تم حفظ المحاضرة في الملفات / On My iPhone' : 'Lecture saved to Files / On My iPhone'),
      };
    } catch (error) {
      if (isNativeFileCancellation(error)) return { success: false, cancelled: true };
      const errorCode = nativeFileErrorCode(error);
      console.error('[deviceExport] Native save failed:', { errorCode, error });
      return { success: false, errorCode };
    }
  }

  await forceDownload(input.url, filename);
  return {
    success: true,
    message: isRtl ? 'جاري تنزيل الملف' : 'Downloading file',
  };
}
