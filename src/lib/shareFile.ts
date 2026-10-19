/**
 * Hand a real file or link to the OS share sheet.
 *
 * On iOS and Android (Capacitor native builds):
 * Shares the actual native file directly using native file:// URIs via
 * @capacitor/share and @capacitor/filesystem (Directory.Cache/shared).
 *
 * CRITICAL: Zero FileReader, zero base64 encoding, and zero in-WebView fetch
 * are used on native paths. This ensures full compatibility with iOS Lockdown Mode
 * (which disables both IndexedDB and FileReader) and avoids memory blowups on large PDFs.
 *
 * On Web:
 * Shares the URL directly ("Share link") via navigator.share({ url }), or falls
 * back to downloading the file via forceDownload.
 */

import { forceDownload } from './utils';
import { safeFileName } from './shareFileName';

export type ShareFileResult =
  /** The share sheet opened and the user picked a target. */
  | 'shared'
  /** No share target exists, so the file was downloaded instead. */
  | 'downloaded'
  /** The user dismissed the chooser. Not an error - say nothing. */
  | 'cancelled'
  | 'failed';

export interface ShareFileInput {
  /** Remote URL, used when local file is absent and as the link share target. */
  url: string;
  /** Display name WITHOUT extension; `extension` is appended after sanitising. */
  name: string;
  extension: string;
  mimeType: string;
  /** Subject line on targets that have one (email, Drive). */
  title?: string;
  /** Associated lecture ID if sharing a lecture file. */
  lectureId?: string;
  /**
   * Bytes already on the device (Web/IDB fallback).
   */
  bytes?: ArrayBuffer | null;
}

/** Cache subdirectory the shared copies live in, so the sweep below cannot
 *  touch anything else the app cached. */
const SHARE_DIR = 'shared';

/** A copy older than this is certainly no longer being read by anyone. */
const STALE_MS = 60 * 60 * 1000;

async function isNative(): Promise<boolean> {
  if ((globalThis as any).__mockIsNative !== undefined) {
    return (globalThis as any).__mockIsNative;
  }
  try {
    const { Capacitor } = await import('@capacitor/core');
    return Capacitor?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

/**
 * Delete copies left behind by earlier shares.
 *
 * They cannot be deleted at the end of a share: `Share.share()` resolves when
 * the user PICKS a target, and the receiving app reads the file afterwards -
 * deleting on resolve races it and delivers an empty attachment. Sweeping stale
 * ones on the NEXT share is the version that cannot truncate a live read.
 */
async function sweepStaleCopies(Filesystem: any, Directory: any): Promise<void> {
  try {
    const { files } = await Filesystem.readdir({ path: SHARE_DIR, directory: Directory.Cache });
    const cutoff = Date.now() - STALE_MS;
    const stale = [...(files || [])]
      .filter((f: any) => typeof f?.name === 'string')
      .sort((a: any, b: any) => (b.mtime ?? 0) - (a.mtime ?? 0))
      .slice(1)
      .filter((f: any) => (f.mtime ?? 0) < cutoff);

    await Promise.all(
      stale.map((f: any) =>
        Filesystem.deleteFile({ path: `${SHARE_DIR}/${f.name}`, directory: Directory.Cache })
          .catch(() => undefined),
      ),
    );
  } catch {
    // Directory does not exist yet - nothing to sweep.
  }
}

/** A dismissed chooser rejects exactly like a broken one; only the message
 *  tells them apart, and telling a student "sharing failed" because they
 *  changed their mind is worse than saying nothing. */
function isCancellation(err: unknown): boolean {
  const msg = (err as any)?.message ?? String(err ?? '');
  return /cancel|abort|dismiss/i.test(msg) || (err as any)?.name === 'AbortError';
}

export async function shareFile(input: ShareFileInput): Promise<ShareFileResult> {
  const filename = safeFileName(input.name, input.extension);

  if (await isNative()) {
    try {
      const Share = (globalThis as any).__mockShare || (await import('@capacitor/share')).Share;
      const { Filesystem, Directory } = (globalThis as any).__mockFs
        ? { Filesystem: (globalThis as any).__mockFs, Directory: { Cache: 'CACHE', Data: 'DATA' } }
        : await import('@capacitor/filesystem');

      await sweepStaleCopies(Filesystem, Directory);

      const { getNativeShareUri } = await import('./nativePdfRepository');
      const fileUri = await getNativeShareUri(input.lectureId, filename, input.url);

      await Share.share({
        title: input.title,
        files: [fileUri],
        dialogTitle: input.title,
      });
      return 'shared';
    } catch (err) {
      if (isCancellation(err)) return 'cancelled';
      console.error('[shareFile] Native share failed:', err);
      return 'failed';
    }
  }

  // Web Platform
  // If native file sharing is not available on this browser, prefer link sharing.
  try {
    const nav = typeof navigator !== 'undefined' ? (navigator as any) : null;

    // 1. If bytes are already present in memory and the browser can share files:
    if (input.bytes && input.bytes.byteLength > 0 && nav && typeof nav.canShare === 'function') {
      try {
        const blob = new Blob([input.bytes], { type: input.mimeType });
        const file = new File([blob], filename, { type: input.mimeType });
        if (nav.canShare({ files: [file] }) && typeof nav.share === 'function') {
          await nav.share({ files: [file], title: input.title });
          return 'shared';
        }
      } catch (err) {
        if (isCancellation(err)) return 'cancelled';
      }
    }

    // 2. Web URL sharing ("Share link"):
    if (nav && typeof nav.share === 'function') {
      try {
        await nav.share({
          title: input.title,
          url: input.url,
        });
        return 'shared';
      } catch (err) {
        if (isCancellation(err)) return 'cancelled';
      }
    }

    // 3. Fallback: trigger download on desktop / browsers without Web Share API
    await forceDownload(input.url, filename);
    return 'downloaded';
  } catch {
    return 'failed';
  }
}
