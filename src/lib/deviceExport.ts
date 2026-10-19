import { safeFileName } from './shareFileName';
import { forceDownload } from './utils';

export interface DeviceExportInput {
  url: string;
  title: string;
  lectureId: string;
}

export interface DeviceExportResult {
  success: boolean;
  message?: string;
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

  if (platform === 'android') {
    try {
      const { Filesystem, Directory } = (globalThis as any).__mockFs
        ? { Filesystem: (globalThis as any).__mockFs, Directory: { Cache: 'CACHE', Data: 'DATA', Documents: 'DOCUMENTS' } }
        : await import('@capacitor/filesystem');
      const { getNativeShareUri } = await import('./nativePdfRepository');

      // Ensure file exists in native storage (Cache or Data)
      const fileUri = await getNativeShareUri(input.lectureId, filename, input.url);

      // On Android, attempt copy to Directory.Documents so user sees it in Downloads/Documents
      try {
        await Filesystem.copy({
          from: fileUri,
          to: filename,
          toDirectory: Directory.Documents,
        });
        return { success: true, message: 'تم حفظ المحاضرة في مجلد المستندات / التنزيلات' };
      } catch {
        // If direct Documents write is restricted by Android scoped storage, open system share sheet
        const Share = (globalThis as any).__mockShare || (await import('@capacitor/share')).Share;
        await Share.share({
          title: input.title,
          files: [fileUri],
          dialogTitle: 'حفظ أو مشاركة المحاضرة',
        });
        return { success: true, message: 'تم فتح نافذة الحفظ والمشاركة' };
      }
    } catch (err: any) {
      if (/cancel|abort|dismiss/i.test(err?.message || '')) {
        return { success: true };
      }
      console.error('[deviceExport] Android export failed, falling back to shareFile:', err);
      const { shareFile } = await import('./shareFile');
      await shareFile({
        url: input.url,
        name: input.title,
        extension: 'pdf',
        mimeType: 'application/pdf',
        lectureId: input.lectureId,
      });
      return { success: true };
    }
  }

  if (platform === 'ios') {
    // iOS sandboxed environment: trigger system share sheet so user can choose "Save to Files" (حفظ في الملفات)
    const { shareFile } = await import('./shareFile');
    const result = await shareFile({
      url: input.url,
      name: input.title,
      extension: 'pdf',
      mimeType: 'application/pdf',
      title: input.title,
      lectureId: input.lectureId,
    });
    return { success: result !== 'failed' };
  }

  await forceDownload(input.url, filename);
  return { success: true, message: 'جاري تنزيل الملف' };
}
