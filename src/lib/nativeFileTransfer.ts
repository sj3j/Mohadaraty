import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

interface NativeFilesPlugin {
  getRuntimeInfo(): Promise<{ platform: string; sdkInt: number }>;
  downloadPrivate(options: { url: string; path: string; transferId: string }): Promise<{ path: string; bytes: number }>;
  savePdf(options: { sourceUri: string; filename: string; mimeType: string }): Promise<{
    status: 'saved' | 'cancelled';
    uri?: string;
    location?: string;
    bytes?: number;
  }>;
  addListener(
    eventName: 'downloadProgress',
    listener: (event: { transferId: string; bytes: number; contentLength: number }) => void,
  ): Promise<PluginListenerHandle>;
}

export const NativeFiles = registerPlugin<NativeFilesPlugin>('NativeFiles');

export interface NativeDownloadOptions {
  url: string;
  path: string;
  onProgress?: (percent: number) => void;
}

function errorData(error: any): any {
  return error?.data && typeof error.data === 'object' ? error.data : error;
}

export function nativeFileErrorCode(error: unknown): string {
  const value = errorData(error as any);
  return String(value?.code || (error as any)?.code || 'FILE_UNKNOWN');
}

export function isNativeFileCancellation(error: unknown): boolean {
  const code = nativeFileErrorCode(error);
  const message = String((error as any)?.message || error || '');
  return code === 'FILE_CANCELLED' || /cancel|abort|dismiss/i.test(message);
}

function isTransientTransferError(error: unknown): boolean {
  const value = errorData(error as any);
  const code = nativeFileErrorCode(error);
  const status = Number(value?.httpStatus || value?.status || 0);
  const message = String(value?.message || (error as any)?.message || '');
  return code === 'NATIVE_TRANSFER_NETWORK'
    || code === 'OS-PLUG-FLTR-0008'
    || status === 408
    || status === 425
    || status === 429
    || status >= 500
    || /timeout|timed out|connection reset|temporar|network.*unreachable/i.test(message);
}

async function runWithOneTransientRetry<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isTransientTransferError(error)) throw error;
    return operation();
  }
}

function newTransferId(): string {
  return `pdf_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Download into an app-private file URI. Android 7-10 bypasses the stock
 * plugin because it incorrectly gates private destinations on public storage.
 */
export async function downloadNativeFile(options: NativeDownloadOptions): Promise<{ path: string; bytes?: number }> {
  const mockNativeFiles = (globalThis as any).__mockNativeFiles as NativeFilesPlugin | undefined;
  const mockFileTransfer = (globalThis as any).__mockFt;
  const platform = (globalThis as any).__mockPlatform || Capacitor.getPlatform();
  const nativeFiles = mockNativeFiles || NativeFiles;

  let usePrivateAndroidTransfer = false;
  if (platform === 'android') {
    const runtime = (globalThis as any).__mockAndroidSdk !== undefined
      ? { sdkInt: Number((globalThis as any).__mockAndroidSdk) }
      : await nativeFiles.getRuntimeInfo();
    usePrivateAndroidTransfer = runtime.sdkInt < 30;
  }

  if (usePrivateAndroidTransfer) {
    const transferId = newTransferId();
    let listener: PluginListenerHandle | null = null;
    try {
      if (options.onProgress && typeof nativeFiles.addListener === 'function') {
        listener = await nativeFiles.addListener('downloadProgress', event => {
          if (event.transferId !== transferId || event.contentLength <= 0) return;
          options.onProgress!(Math.min(100, Math.round((event.bytes / event.contentLength) * 100)));
        });
      }
      return await runWithOneTransientRetry(() => nativeFiles.downloadPrivate({
        url: options.url,
        path: options.path,
        transferId,
      }));
    } finally {
      await Promise.resolve(listener?.remove()).catch(() => undefined);
    }
  }

  const FileTransfer = mockFileTransfer || (await import('@capacitor/file-transfer')).FileTransfer;
  let listener: PluginListenerHandle | null = null;
  try {
    if (options.onProgress) {
      listener = await FileTransfer.addListener('progress', (status: any) => {
        if (status.type !== 'download' || status.url !== options.url) return;
        if (!status.lengthComputable || status.contentLength <= 0) return;
        options.onProgress!(Math.min(100, Math.round((status.bytes / status.contentLength) * 100)));
      });
    }
    return await runWithOneTransientRetry(() => FileTransfer.downloadFile({
      url: options.url,
      path: options.path,
      progress: !!options.onProgress,
    }));
  } finally {
    await Promise.resolve(listener?.remove()).catch(() => undefined);
  }
}

export async function saveNativePdf(sourceUri: string, filename: string) {
  const plugin = (globalThis as any).__mockNativeFiles || NativeFiles;
  return plugin.savePdf({ sourceUri, filename, mimeType: 'application/pdf' });
}
