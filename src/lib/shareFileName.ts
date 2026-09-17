/**
 * The one rule a shared file's NAME has to obey.
 *
 * Split out of shareFile.ts and kept import-free for the same reason
 * pdfAnchor.ts and subjectSplit.ts are: it is the only part of the share with
 * a hard external contract, it is the only part worth pinning with a test, and
 * a test should not have to pull in Capacitor or the DOM to check a string.
 *
 * Pinned by `npm run test:share`.
 */

/**
 * Make a filename the share sheet can type correctly.
 *
 * Android derives the MIME type with `MimeTypeMap.getFileExtensionFromUrl`,
 * which only returns an extension when the PERCENT-ENCODED filename matches
 * `[a-zA-Z_0-9.\-()%]+`. Miss it and the intent goes out with a null type:
 * WhatsApp drops out of the chooser and Gmail attaches an untyped blob.
 *
 * The name reaching that check has been through `Uri.encode(path, "/")`, whose
 * unreserved set is `A-Za-z0-9` plus `` _ - ! . ~ ' ( ) * ``. So Arabic, spaces
 * and commas are all SAFE - they arrive as `%D8%A7`, `%20`, `%2C`, and `%` is
 * inside the pattern. The characters that actually break it are the ones
 * `Uri.encode` leaves alone but the pattern rejects: `'` `!` `~` `*`.
 *
 * This whitelists rather than blacklists on purpose: a blacklist has to be
 * right about the whole of `Uri.encode`'s private allow-list, a whitelist only
 * has to be conservative.
 */
export function safeFileName(name: string, extension: string): string {
  const cleaned = (name || '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} ._-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Sliced by CODE POINT, not by UTF-16 unit: `.slice()` would cut an emoji or
  // any astral character in half and leave a lone surrogate in the path. 80
  // code points of Arabic is ~160 UTF-8 bytes, well inside the 255-byte
  // directory-entry limit on ext4/f2fs.
  const capped = Array.from(cleaned)
    .slice(0, 80)
    .join('')
    // A leading dot makes it a hidden file on every Unix-derived filesystem,
    // Android's included; a trailing one is rejected outright on Windows, which
    // is where a shared PDF often ends up.
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  return `${capped || 'file'}.${extension}`;
}
