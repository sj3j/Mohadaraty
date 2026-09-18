/**
 * Hand a real file to the OS share sheet.
 *
 * This replaces the old "share to chat" buttons, which wrote an embeddedItem
 * message into `chat_messages`. What goes out now is the FILE, not a link: a
 * student sending a lecture to a classmate on WhatsApp sends the PDF, and the
 * classmate does not need the app, an account, or the network to open it.
 *
 * WHY THIS IS NOT IN textActions.ts
 *
 * That module is the PDF reader's SELECTION toolbar - copy, translate, web
 * search, share-a-passage - and its header documents constraints that belong to
 * that surface. This is a whole-document share reached from a card. It borrows
 * the conventions (dynamic Capacitor imports so the web bundle never pulls
 * native code; a result union rather than a thrown error) and nothing else.
 *
 * THE NATIVE PATH, and why each step is load-bearing
 *
 * `@capacitor/share` takes `files: string[]`, and its Android implementation
 * runs every entry through
 *
 *     FileProvider.getUriForFile(activity, packageName + ".fileprovider", file)
 *
 * so the argument must be a `file://` URL pointing INSIDE a directory the app's
 * FileProvider is configured to serve. Two things already in the repo make that
 * work, and neither is obvious:
 *
 *   - `android/app/src/main/AndroidManifest.xml` declares that provider with
 *     authority `${applicationId}.fileprovider` - the exact string the plugin
 *     builds.
 *   - `android/app/src/main/res/xml/file_paths.xml` carries
 *     `<cache-path name="my_cache_images" path="." />`, and Capacitor's
 *     `Directory.Cache` resolves to `context.cacheDir`, which is what that
 *     covers.
 *
 * So writing into `Directory.Cache` needs NO native change. Writing anywhere
 * else does, and fails at runtime with an IllegalArgumentException from
 * FileProvider rather than anything a build would catch.
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
  /** Remote URL, used when `bytes` is absent and as the download fallback. */
  url: string;
  /** Display name WITHOUT extension; `extension` is appended after sanitising. */
  name: string;
  extension: string;
  mimeType: string;
  /** Subject line on targets that have one (email, Drive). */
  title?: string;
  /**
   * Bytes already on the device. Downloaded lectures live in IndexedDB
   * (useOfflinePDF's readStoredPdf), so passing them here skips the network
   * entirely - which is the difference between sharing offline and not.
   */
  bytes?: ArrayBuffer | null;
}

/** Cache subdirectory the shared copies live in, so the sweep below cannot
 *  touch anything else the app cached. */
const SHARE_DIR = 'shared';

/** A copy older than this is certainly no longer being read by anyone. */
const STALE_MS = 60 * 60 * 1000;

async function isNative(): Promise<boolean> {
  try {
    const { Capacitor } = await import('@capacitor/core');
    return Capacitor?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

/**
 * Blob -> bare base64.
 *
 * `btoa(String.fromCharCode(...bytes))` is the obvious version and it throws on
 * a real lecture: the argument spread blows the call stack somewhere around
 * 100k elements, and a PDF is millions. readAsDataURL encodes natively, off the
 * JS stack, at any size.
 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const out = String(reader.result || '');
      const comma = out.indexOf(',');
      resolve(comma >= 0 ? out.slice(comma + 1) : out);
    };
    reader.readAsDataURL(blob);
  });
}

async function resolveBlob(input: ShareFileInput): Promise<Blob> {
  if (input.bytes && input.bytes.byteLength > 0) {
    return new Blob([input.bytes], { type: input.mimeType });
  }
  const res = await fetch(input.url);
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const blob = await res.blob();
  // Storage and R2 both serve a usable content-type, but a blob typed
  // application/octet-stream reaches the chooser as "unknown file".
  return blob.type === input.mimeType ? blob : new Blob([blob], { type: input.mimeType });
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
    // Newest first, and the newest is NEVER swept whatever its age. If any
    // recipient anywhere is still reading a copy, that is the one - a student
    // who shares once a month should not have last month's file pulled out
    // from under a slow upload.
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
      const [{ Filesystem, Directory }, { Share }] = await Promise.all([
        import('@capacitor/filesystem'),
        import('@capacitor/share'),
      ]);

      await sweepStaleCopies(Filesystem, Directory);

      const blob = await resolveBlob(input);
      const written = await Filesystem.writeFile({
        path: `${SHARE_DIR}/${filename}`,
        data: await blobToBase64(blob),
        directory: Directory.Cache,
        recursive: true,
      });

      // writeFile already reports where it landed; getUri is the fallback for
      // any build where it comes back empty.
      const uri =
        written?.uri ||
        (await Filesystem.getUri({ path: `${SHARE_DIR}/${filename}`, directory: Directory.Cache })).uri;

      await Share.share({ title: input.title, files: [uri], dialogTitle: input.title });
      return 'shared';
    } catch (err) {
      return isCancellation(err) ? 'cancelled' : 'failed';
    }
  }

  // Web. navigator.share only accepts files over HTTPS and only where the
  // platform has a share target at all - desktop Linux and Firefox have none.
  try {
    const blob = await resolveBlob(input);
    const file = new File([blob], filename, { type: input.mimeType });
    const nav = navigator as any;
    if (typeof nav.canShare === 'function' && nav.canShare({ files: [file] }) && typeof nav.share === 'function') {
      try {
        await nav.share({ files: [file], title: input.title });
        return 'shared';
      } catch (err) {
        if (isCancellation(err)) return 'cancelled';
        // Fall through: a rejected share is still better answered with the file.
      }
    }
    await forceDownload(input.url, filename);
    return 'downloaded';
  } catch {
    return 'failed';
  }
}
