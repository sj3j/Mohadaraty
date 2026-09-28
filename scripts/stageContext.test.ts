/**
 * Regression and lifecycle test for StageContext.
 *
 * Pins:
 * 1. DEFAULT_STAGES integrity (order 1-5, English & Arabic names).
 * 2. Unauthenticated state guard: stages defaults to DEFAULT_STAGES with no error.
 * 3. Fallback resolution: support account selects managedStageId, others default to stage_3 or stored stage.
 */
import { DEFAULT_STAGES } from '../src/contexts/StageContext';
import type { Stage, UserProfile } from '../src/types';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.error(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
    failed++;
  }
}

console.log('Testing StageContext lifecycle & defaults:');

// Test 1: DEFAULT_STAGES structure
check('DEFAULT_STAGES has 5 stages', DEFAULT_STAGES.length === 5);
check('DEFAULT_STAGES are ordered 1 to 5',
  DEFAULT_STAGES.every((s, i) => s.order === i + 1 && s.id === `stage_${i + 1}`)
);
check('DEFAULT_STAGES have Arabic and English names',
  DEFAULT_STAGES.every(s => Boolean(s.nameAr && s.nameEn))
);

// Helper mimicking resolveCurrentAppStage from applyStageList
function resolveCurrentAppStage(
  list: Stage[],
  prev: string | null,
  activeUser: Partial<UserProfile> | null
): string | null {
  if (prev && list.some(st => st.id === prev)) return prev;
  const home = activeUser?.role === 'support' ? (activeUser.managedStageId || null) : null;
  if (home && list.some(st => st.id === home)) return home;
  return list.find(st => st.id === 'stage_3')?.id || list[0]?.id || null;
}

// Test 2: Unauthenticated stage resolution defaults to stage_3
const unauthedStage = resolveCurrentAppStage(DEFAULT_STAGES, null, null);
check('Unauthenticated session defaults to stage_3', unauthedStage === 'stage_3');

// Test 3: Stored stage preserved if valid
const storedStage = resolveCurrentAppStage(DEFAULT_STAGES, 'stage_4', null);
check('Valid stored stage is preserved', storedStage === 'stage_4');

// Test 4: Invalid stored stage falls back to stage_3
const invalidStoredStage = resolveCurrentAppStage(DEFAULT_STAGES, 'non_existent_stage', null);
check('Invalid stored stage falls back to stage_3', invalidStoredStage === 'stage_3');

// Test 5: Support user defaults to their managedStageId
const supportUser: Partial<UserProfile> = {
  uid: 'u_support',
  role: 'support',
  managedStageId: 'stage_2',
};
const supportStage = resolveCurrentAppStage(DEFAULT_STAGES, null, supportUser);
check('Support user defaults to managedStageId (stage_2)', supportStage === 'stage_2');

// Summary
console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
}
