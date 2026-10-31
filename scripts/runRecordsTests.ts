/**
 * Mohadaraty Records E2E Test Runner
 * Executes the opaque-box test suite for Requirements R1, R2, R3 across Tiers 1-4.
 *
 * Usage:
 *   npx tsx scripts/runRecordsTests.ts
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

console.log('===============================================================');
console.log('   MOHADARATY OPAQUE-BOX E2E TEST SUITE (TIERS 1-4)');
console.log('   Requirements: R1, R2, R3');
console.log('===============================================================\n');

// 1. Run the primary E2E test suite
const startTime = Date.now();
const testResult = spawnSync(
  process.execPath,
  ['node_modules/tsx/dist/cli.mjs', '--test', 'scripts/recordsOpaqueE2E.test.ts'],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '1' },
  }
);
const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

console.log('\n---------------------------------------------------------------');
if (testResult.status === 0) {
  console.log(`✅ ALL E2E TESTS PASSED (${elapsed}s)`);
} else {
  console.log(`❌ SOME TESTS FAILED (Exit code: ${testResult.status})`);
}
console.log('---------------------------------------------------------------\n');

// 2. Codebase Implementation Audit (Readiness Check for M2 / M3)
console.log('--- Codebase Implementation Status (M2 Tracking) ---');

const checkItem = (name: string, ok: boolean, note: string = '') => {
  const icon = ok ? '✅' : '⏳';
  console.log(`  ${icon} ${name} ${note ? `(${note})` : ''}`);
};

const homeSrc = existsSync(join(root, 'src/components/HomeScreen.tsx'))
  ? readFileSync(join(root, 'src/components/HomeScreen.tsx'), 'utf8')
  : '';
const attachmentsSrc = existsSync(join(root, 'src/components/lecture/LectureAttachmentsSection.tsx'))
  ? readFileSync(join(root, 'src/components/lecture/LectureAttachmentsSection.tsx'), 'utf8')
  : '';
const appSrc = existsSync(join(root, 'src/App.tsx'))
  ? readFileSync(join(root, 'src/App.tsx'), 'utf8')
  : '';
const recordsScreenExists = existsSync(join(root, 'src/components/RecordsScreen.tsx'));
const audioPlayerSrc = existsSync(join(root, 'src/components/AudioPlayer.tsx'))
  ? readFileSync(join(root, 'src/components/AudioPlayer.tsx'), 'utf8')
  : '';
const serverSrc = existsSync(join(root, 'server.ts'))
  ? readFileSync(join(root, 'server.ts'), 'utf8')
  : '';

// R1 Checks
const r1InlinePlayer = attachmentsSrc.includes('AudioPlayer') || attachmentsSrc.includes('LectureRecordingsSection');
const r1AudioPlayerPreserved = audioPlayerSrc.includes('forceDownload') && audioPlayerSrc.includes('cyclePlaybackRate');
checkItem('R1: Attachments view embeds AudioPlayer/recordings', r1InlinePlayer, r1InlinePlayer ? 'Embedded' : 'Pending M2 worker');
checkItem('R1: AudioPlayer preserves all waveform/speed/download controls', r1AudioPlayerPreserved, 'Preserved');

// R2 Checks
const r2ChipRemoved = !homeSrc.includes("{ id: 'records'");
const r2RecordsScreenRemoved = !recordsScreenExists || !homeSrc.includes('<RecordsScreen');
const r2AppRedirects = appSrc.includes('/records') || appSrc.includes('tab=records');
checkItem('R2: Records tab chip removed from HomeScreen', r2ChipRemoved, r2ChipRemoved ? 'Removed' : 'Pending M2 worker');
checkItem('R2: RecordsScreen component decommissioned', r2RecordsScreenRemoved, r2RecordsScreenRemoved ? 'Decommissioned' : 'Pending M2 worker');
checkItem('R2: Legacy /records and ?tab=records routes redirected in App', r2AppRedirects, r2AppRedirects ? 'Redirected' : 'Pending M2 worker');

// R3 Checks
const r3PresignedUrl = serverSrc.includes('/api/get-upload-url') && serverSrc.includes('PutObjectCommand');
const r3Rules = existsSync(join(root, 'firestore.rules')) && readFileSync(join(root, 'firestore.rules'), 'utf8').includes('/records/{recordId}');
checkItem('R3: Cloudflare R2 presigned upload endpoint preserved', r3PresignedUrl, 'Preserved in server.ts');
checkItem('R3: Firestore security rules for records collection preserved', r3Rules, 'Preserved in firestore.rules');

console.log('\n===============================================================');
process.exit(testResult.status || 0);
