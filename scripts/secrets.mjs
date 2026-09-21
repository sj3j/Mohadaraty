#!/usr/bin/env node
/**
 * Machine-to-machine sync for the files git deliberately does not carry.
 *
 * The code already travels: it is on GitHub. What does not travel is the
 * handful of untracked files a fresh clone needs before it can run or ship -
 * .env, bot/.env, and the Play upload keystore with its passwords. That is
 * FOUR FILES, about 12 KB. Syncing the working tree through a cloud drive to
 * carry them would mean syncing ~1.2 GB across ~50,000 files, of which
 * node_modules is 48,508 and .git is 1,732.
 *
 * Both of those are actively hostile to a synced drive, for different reasons:
 *
 *   - git writes refs, the index and packfiles non-atomically. A sync client
 *     that uploads mid-write, or two machines touching the repo in the same
 *     window, corrupts it - and the drive's conflict handling renames the
 *     casualty to `index (1)`, which git does not recognise at all.
 *   - node_modules is 48,508 small files. A half-synced package tree fails at
 *     require() time, which surfaces as a bug in application code rather than
 *     as a sync problem.
 *
 * Google Drive for Desktop also cannot exclude a subfolder of a mirrored
 * folder, so "just don't sync node_modules" is not available. Hence: keep the
 * working copy on a local disk on each machine, clone it with git, and move
 * only the secrets through the drive.
 *
 *   node scripts/secrets.mjs status   # what differs between repo and vault
 *   node scripts/secrets.mjs pull     # vault -> repo (new laptop setup)
 *   node scripts/secrets.mjs push     # repo -> vault (after changing a secret)
 *
 * Pull and push both REFUSE to overwrite a destination file that is newer than
 * its source, because the common accident here is pulling a stale .env over
 * one you edited an hour ago. Pass --force to override once you have looked.
 *
 * The vault location is auto-detected (see CANDIDATES) or set explicitly with
 * MYLECTURE_VAULT. Exits 1 when the vault is unreachable - a sync that reports
 * success when it could not see the vault is worse than no sync.
 */

import { existsSync, mkdirSync, copyFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORCE = process.argv.includes('--force');
const command = process.argv[2] ?? 'status';

/**
 * Files carried through the vault, relative to the repo root.
 *
 * `secret: true` is not a permission flag - it only controls whether the file's
 * contents may be echoed to the terminal. Everything here is sensitive; the
 * field exists so a future non-secret entry does not have to be special-cased.
 *
 * android/local.properties is deliberately ABSENT. It holds an absolute SDK
 * path (sdk.dir=C:/Users/<name>/AppData/Local/Android/Sdk) which is wrong on
 * any machine with a different username or SDK location, and a wrong sdk.dir
 * fails the Gradle build with an error that points at the SDK rather than at
 * the synced file. `pull` regenerates it locally instead - see writeLocalProps.
 */
const MANIFEST = [
  { repoPath: '.env', note: 'Firebase admin, Gemini keys, ZainCash' },
  { repoPath: 'bot/.env', note: 'Telegram mirror bot' },
  { repoPath: 'android/keystore.properties', note: 'keystore passwords' },
  { repoPath: 'android/keys/upload-keystore.jks', note: 'PLAY UPLOAD KEY - irreplaceable' },
];

/**
 * Drive letters and mount points differ per machine, so the vault is found
 * rather than hardcoded. MYLECTURE_VAULT wins; after that this is ordered
 * most- to least-specific so a real Drive mount beats a stray local folder.
 */
const CANDIDATES = [
  process.env.MYLECTURE_VAULT,
  'H:/My Drive/dev-secrets/MyLecture',
  'G:/My Drive/dev-secrets/MyLecture',
  path.join(homedir(), 'My Drive', 'dev-secrets', 'MyLecture'),
  path.join(homedir(), 'Google Drive', 'My Drive', 'dev-secrets', 'MyLecture'),
].filter(Boolean);

/**
 * A vault counts as found when some ANCESTOR of it exists - the vault folder
 * itself is created on first push, so requiring it would mean the first push
 * could never happen. Walking up rather than checking a single parent is what
 * makes "H:/My Drive is mounted but empty" resolve, which is the state a fresh
 * Drive install is in.
 *
 * It still distinguishes that from "Drive is not mounted": an unmounted drive
 * letter fails existsSync at every level including the root, so the walk ends
 * with nothing found. The two must not be conflated - treating an unmounted
 * drive as present would write secrets to a local folder that never syncs,
 * and report success while doing it.
 */
function findVault() {
  for (const candidate of CANDIDATES) {
    const resolved = path.resolve(candidate);
    let dir = resolved;
    while (!existsSync(dir)) {
      const parent = path.dirname(dir);
      if (parent === dir) break; // hit the root without finding anything
      dir = parent;
    }
    if (existsSync(dir)) return resolved;
  }
  return null;
}

const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12);
const mtime = (file) => statSync(file).mtimeMs;

function describe(repoFile, vaultFile) {
  const inRepo = existsSync(repoFile);
  const inVault = existsSync(vaultFile);
  if (!inRepo && !inVault) return { state: 'missing', label: 'absent both sides' };
  if (inRepo && !inVault) return { state: 'repo-only', label: 'repo only - not backed up' };
  if (!inRepo && inVault) return { state: 'vault-only', label: 'vault only - not pulled yet' };
  if (hash(repoFile) === hash(vaultFile)) return { state: 'same', label: 'in sync' };
  const newer = mtime(repoFile) > mtime(vaultFile) ? 'repo' : 'vault';
  return { state: 'differs', label: `differs - ${newer} is newer`, newer };
}

/**
 * android/local.properties, written from whatever SDK this machine has rather
 * than copied from another one. Silent no-op when the file already exists: a
 * machine that has opened Android Studio already has a correct one, and
 * overwriting it is how you break a working build during "setup".
 */
function writeLocalProps() {
  const target = path.join(REPO, 'android', 'local.properties');
  if (existsSync(target)) return null;

  const sdkCandidates = [
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    path.join(homedir(), 'AppData', 'Local', 'Android', 'Sdk'),
    path.join(homedir(), 'Library', 'Android', 'sdk'),
    path.join(homedir(), 'Android', 'Sdk'),
  ].filter(Boolean);

  const sdk = sdkCandidates.find((dir) => existsSync(dir));
  if (!sdk) return 'no Android SDK found - write android/local.properties by hand before building';

  writeFileSync(target, `sdk.dir=${sdk.replace(/\\/g, '/')}\n`);
  return `generated android/local.properties -> ${sdk}`;
}

function transfer(direction, vault) {
  const pulling = direction === 'pull';
  let moved = 0;
  let blocked = 0;

  for (const { repoPath, note } of MANIFEST) {
    const repoFile = path.join(REPO, repoPath);
    const vaultFile = path.join(vault, repoPath);
    const src = pulling ? vaultFile : repoFile;
    const dest = pulling ? repoFile : vaultFile;

    if (!existsSync(src)) {
      console.log(`  skip    ${repoPath} - not present in ${pulling ? 'vault' : 'repo'}`);
      continue;
    }
    if (existsSync(dest)) {
      if (hash(src) === hash(dest)) {
        console.log(`  same    ${repoPath}`);
        continue;
      }
      if (mtime(dest) > mtime(src) && !FORCE) {
        console.log(`  BLOCKED ${repoPath} - destination is newer. Inspect, then --force.`);
        blocked += 1;
        continue;
      }
    }

    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    console.log(`  ${pulling ? 'pulled ' : 'pushed '} ${repoPath}  (${note})`);
    moved += 1;
  }

  return { moved, blocked };
}

const vault = findVault();
if (!vault) {
  console.error('No vault found. Checked:');
  for (const c of CANDIDATES) console.error(`  ${c}`);
  console.error('\nIs Google Drive mounted? Otherwise set MYLECTURE_VAULT to the folder.');
  process.exit(1);
}

console.log(`vault: ${vault}`);
console.log(`repo:  ${REPO}\n`);

if (command === 'status') {
  for (const { repoPath, note } of MANIFEST) {
    const { label } = describe(path.join(REPO, repoPath), path.join(vault, repoPath));
    console.log(`  ${label.padEnd(28)} ${repoPath}  (${note})`);
  }
  console.log('\n  pull = vault -> repo,  push = repo -> vault');
} else if (command === 'pull' || command === 'push') {
  const { moved, blocked } = transfer(command, vault);
  if (command === 'pull') {
    const props = writeLocalProps();
    if (props) console.log(`  ${props}`);
  }
  console.log(`\n${moved} file(s) ${command}ed${blocked ? `, ${blocked} blocked` : ''}.`);
  if (blocked) process.exit(1);
} else {
  console.error(`Unknown command "${command}". Use: status | pull | push  [--force]`);
  process.exit(1);
}
