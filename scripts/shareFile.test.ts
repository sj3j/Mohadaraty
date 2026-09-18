/**
 * Pins the filename contract the OS share sheet depends on.
 *
 * Run with:  npm run test:share
 *
 * ONE invariant, and it is not cosmetic. @capacitor/share's Android plugin
 * types the outgoing intent with
 *
 *     MimeTypeMap.getFileExtensionFromUrl(uri)
 *
 * which returns an extension ONLY when the last segment of the percent-encoded
 * file:// URI matches [a-zA-Z_0-9.\-()%]+. Miss it and the extension comes back
 * empty, the intent's type is null, WhatsApp disappears from the chooser and
 * Gmail attaches an untyped blob - a failure that appears only on a device and
 * only for certain lecture titles.
 *
 * The name is encoded by Uri.encode(path, "/"), whose unreserved set is
 * A-Za-z0-9 plus  _ - ! . ~ ' ( ) *  . encodeURIComponent below encodes a
 * SUPERSET of what that leaves alone, so a title passing this check passes on
 * Android too.
 */
import { safeFileName } from '../src/lib/shareFileName';

/** Exactly the pattern MimeTypeMap tests. */
const ANDROID_MIME_SAFE = /^[a-zA-Z_0-9.\-()%]+$/;

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); failed++; }
};

const TITLES = [
  'تشريح الجهاز الدوري',
  'Physiology I + Computer Science',   // the "+" pair, straight out of CLAUDE.md
  "O'Brien's notes",                   // the apostrophe Uri.encode leaves alone
  'Lecture 1,2 & 3',
  'أحياء ٣ * مراجعة',                   // asterisk, and Arabic-Indic digits
  'Wave~form! analysis',               // tilde and bang
  'المستحضرات الصيدلانية والتجميلية',
  'emoji 🧪 title',
  'a'.repeat(300),
  'ن'.repeat(300),
  '',
  '   ',
  '...hidden',
  'path/with\\separators',
];

console.log('Every title survives the MimeTypeMap pattern:');
for (const t of TITLES) {
  const out = safeFileName(t, 'pdf');
  const encoded = encodeURIComponent(out);
  check(`"${t.slice(0, 32)}" -> ${out.slice(0, 40)}`, ANDROID_MIME_SAFE.test(encoded), encoded.slice(0, 60));
}

console.log('\nShape:');
check('the extension is always appended', safeFileName('محاضرة', 'pdf').endsWith('.pdf'));
check('an empty title still yields a usable name', safeFileName('', 'pdf') === 'file.pdf');
check('a whitespace-only title does too', safeFileName('   ', 'pdf') === 'file.pdf');
check('Arabic is KEPT, not stripped - the recipient sees the real title',
  safeFileName('تشريح', 'pdf') === 'تشريح.pdf', safeFileName('تشريح', 'pdf'));
check('a path separator cannot survive into the path',
  !safeFileName('a/../../b', 'pdf').includes('/'), safeFileName('a/../../b', 'pdf'));
check('a leading dot cannot make it a hidden file',
  !safeFileName('...hidden', 'pdf').startsWith('.'), safeFileName('...hidden', 'pdf'));
check('the apostrophe that breaks the pattern is gone',
  !safeFileName("O'Brien", 'pdf').includes("'"), safeFileName("O'Brien", 'pdf'));

// ext4/f2fs cap a directory entry at 255 BYTES, and Arabic is two per letter.
const longArabic = safeFileName('ن'.repeat(300), 'pdf');
check('a long Arabic title is truncated well inside the 255-byte limit',
  new TextEncoder().encode(longArabic).length <= 255,
  String(new TextEncoder().encode(longArabic).length));
check('truncation never splits a surrogate pair',
  !/[\uD800-\uDFFF]/.test(safeFileName('🧪'.repeat(200), 'pdf').replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
