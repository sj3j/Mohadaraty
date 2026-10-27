import fs from 'node:fs';
import {
  DEFAULT_MOBILE_RELEASE_POLICY,
  evaluateUpdateRequirement,
  isValidStoreUrl,
  normalizeMobileReleasePolicy,
  parseNativeBuild,
  validateMobileReleasePolicy,
} from '../src/lib/mobileReleasePolicy';

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean) => {
  if (ok) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}`); failed++; }
};

const active = {
  ...DEFAULT_MOBILE_RELEASE_POLICY,
  enforcementEnabled: true,
  android: { ...DEFAULT_MOBILE_RELEASE_POLICY.android, enabled: true, minBuild: 23 },
  ios: { ...DEFAULT_MOBILE_RELEASE_POLICY.ios, enabled: true, minBuild: 33 },
};
const evaluate = (overrides: Partial<Parameters<typeof evaluateUpdateRequirement>[0]> = {}) =>
  evaluateUpdateRequirement({
    policy: active,
    platform: 'android',
    installedBuild: 22,
    role: 'student',
    isNative: true,
    isFresh: true,
    ...overrides,
  });

console.log('Build parsing and comparison:');
check('Capacitor build string parses', parseNativeBuild('22') === 22);
check('malformed build fails open', parseNativeBuild('1.3.1') === null);
check('older build is blocked', evaluate().required === true);
check('minimum build is accepted', evaluate({ installedBuild: 23 }).required === false);
check('newer build is accepted', evaluate({ installedBuild: 24 }).required === false);
check('iOS uses its own minimum', evaluate({ platform: 'ios', installedBuild: 32 }).required === true);

console.log('\nTargeting and fail-open behavior:');
check('web is outside the gate', evaluate({ isNative: false }).required === false);
check('staff are outside the gate', evaluate({ role: 'admin' }).required === false);
check('doctors are outside the gate', evaluate({ role: 'doctor' }).required === false);
check('cached policy cannot start a block', evaluate({ isFresh: false }).required === false);
check('global kill switch opens the gate', evaluate({ policy: { ...active, enforcementEnabled: false } }).required === false);
check('platform switch opens the gate', evaluate({ policy: { ...active, android: { ...active.android, enabled: false } } }).required === false);
check('missing build fails open', evaluate({ installedBuild: null }).required === false);

console.log('\nPolicy validation:');
const missing = normalizeMobileReleasePolicy(undefined);
check('missing policy defaults to disabled', missing.enforcementEnabled === false && !missing.android.enabled && !missing.ios.enabled);
const malformed = normalizeMobileReleasePolicy({ enforcementEnabled: true, android: { enabled: true, minBuild: 'bad' } });
check('malformed platform configuration fails open', malformed.android.minBuild === 1 && malformed.android.enabled === false);
const missingUrl = normalizeMobileReleasePolicy({ enforcementEnabled: true, android: { enabled: true, minBuild: 99 } });
check('enabled platform with missing URL fails open', missingUrl.android.enabled === false);
check('Google Play URL is accepted', isValidStoreUrl('android', DEFAULT_MOBILE_RELEASE_POLICY.android.storeUrl));
check('App Store URL is accepted', isValidStoreUrl('ios', DEFAULT_MOBILE_RELEASE_POLICY.ios.storeUrl));
check('cross-platform store URL is rejected', !isValidStoreUrl('ios', DEFAULT_MOBILE_RELEASE_POLICY.android.storeUrl));
check('non-store URL is rejected', !isValidStoreUrl('android', 'https://example.com/app'));
check('valid default policy has no errors', validateMobileReleasePolicy(DEFAULT_MOBILE_RELEASE_POLICY).length === 0);

console.log('\nNative gate wiring:');
const hook = fs.readFileSync('src/hooks/useMobileReleaseGate.ts', 'utf8');
const screen = fs.readFileSync('src/components/ForceUpdateScreen.tsx', 'utf8');
const back = fs.readFileSync('src/hooks/useBackDismiss.ts', 'utf8');
check('cached Firestore snapshots are ignored', hook.includes('snapshot.metadata.fromCache'));
check('reconnect and foreground trigger a recheck', hook.includes("addEventListener('online'") && hook.includes("addListener('appStateChange'"));
check('store-open failures have visible handling', screen.includes('setOpenFailed(true)') && screen.includes('role="alert"'));
check('forced gate registers a non-dismissible Back layer', screen.includes("'force-update'") && back.includes('layers[layers.length - 1]'));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
