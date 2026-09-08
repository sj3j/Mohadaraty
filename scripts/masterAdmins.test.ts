/**
 * The master-admin list is one array in shared/masterAdmins.ts - except in the
 * two .rules files, which cannot import anything. This asserts those two copies
 * still say exactly what the module says, and that no call site has quietly
 * reintroduced an inline literal.
 *
 * It exists because the inline lists HAD already drifted: LoginScreen.tsx,
 * ChatScreen.tsx and AdminGradesScreen.tsx carried one address while the two
 * servers carried two. LoginScreen decides the role written onto a brand-new
 * users document, so a master admin whose first-ever sign-in was Google landed
 * as a student and had to be repaired by hand.
 *
 *   npx tsx scripts/masterAdmins.test.ts     (no emulator, no network)
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, sep } from 'path';
import { MASTER_ADMIN_EMAILS, isMasterAdminEmail } from '../shared/masterAdmins';

let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); failed++; }
};

const root = join(import.meta.dirname, '..');
const expected = [...MASTER_ADMIN_EMAILS].sort();

console.log('\nThe module itself');
check('every address is lowercase',
  MASTER_ADMIN_EMAILS.every(e => e === e.toLowerCase()));
check('no duplicates', new Set(MASTER_ADMIN_EMAILS).size === MASTER_ADMIN_EMAILS.length);
check('isMasterAdminEmail is case-insensitive',
  isMasterAdminEmail(MASTER_ADMIN_EMAILS[0].toUpperCase()));
check('isMasterAdminEmail is null-safe',
  !isMasterAdminEmail(null) && !isMasterAdminEmail(undefined) && !isMasterAdminEmail(''));
check('a non-master address is refused', !isMasterAdminEmail('someone@else.com'));

/**
 * The copies that CANNOT import the module, and what to read the list out of.
 *
 *   .rules      - a rules file has no import statement at all.
 *   functions/  - deploys as its own package, so ../shared is not on disk there.
 *   *.mjs       - plain ESM scripts run by node, not tsx.
 *
 * Each is matched by the bracketed literal following its own declaration, so a
 * hand-edit to one of them fails here rather than in production.
 */
const COPIES: Array<{ file: string; pattern: RegExp }> = [
  { file: 'firestore.rules', pattern: /request\.auth\.token\.email\.lower\(\)\s+in\s+\[([^\]]*)\]/ },
  { file: 'storage.rules', pattern: /request\.auth\.token\.email\.lower\(\)\s+in\s+\[([^\]]*)\]/ },
  { file: 'functions/index.js', pattern: /const MASTER_ADMIN_EMAILS = \[([^\]]*)\]/ },
  { file: 'scripts/assignStageRepresentatives.mjs', pattern: /const MASTER_ADMIN_EMAILS = \[([^\]]*)\]/ },
  { file: 'scripts/rules.test.mjs', pattern: /const MASTER_ADMIN_EMAILS = \[([^\]]*)\]/ },
];

console.log('\nCopies that cannot import');
const verified = new Set(COPIES.map(c => c.file));
for (const { file, pattern } of COPIES) {
  const src = readFileSync(join(root, file), 'utf8');
  const block = src.match(pattern);
  if (!block) { check(`${file} declares a master-admin list`, false); continue; }
  const found = [...block[1].matchAll(/'([^']+)'/g)].map(m => m[1]).sort();
  check(`${file} matches shared/masterAdmins.ts`,
    JSON.stringify(found) === JSON.stringify(expected),
    `copy=${JSON.stringify(found)} module=${JSON.stringify(expected)}`);
}

console.log('\nNo inline literals left behind');
// Any source file that names a master-admin address without importing the
// module - and is not one of the verified copies above - is a copy waiting to
// drift again.
const SKIP = new Set(['node_modules', 'dist', 'android', 'ios', '.git', 'graphify-out', 'build']);
const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(full);
  }
  return out;
};
const offenders: string[] = [];
for (const file of walk(root)) {
  const rel = file.slice(root.length + 1).split(sep).join('/');
  if (rel === 'shared/masterAdmins.ts' || rel === 'scripts/masterAdmins.test.ts') continue;
  if (verified.has(rel)) continue;
  const src = readFileSync(file, 'utf8');
  if (!MASTER_ADMIN_EMAILS.some(e => src.includes(e))) continue;
  if (!/from ['"][^'"]*masterAdmins(\.js)?['"]/.test(src)) offenders.push(rel);
}
check('no source file hardcodes a master-admin address', offenders.length === 0,
  offenders.join(', '));

console.log(failed === 0 ? '\nAll master-admin checks passed.\n' : `\n${failed} check(s) FAILED.\n`);
process.exit(failed === 0 ? 0 : 1);
