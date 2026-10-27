import {
  SUBSCRIPTION_MASTER_CAPABILITIES,
  SUBSCRIPTION_SUPPORT_CAPABILITIES,
  hasStaffCapability,
} from '../shared/staffCapabilities';
import { GRANT_PLANS, MANUAL_PAYMENT_METHODS, PAID_MANUAL_PLANS } from '../shared/subscriptionTypes';
import { deleteUserAccount } from '../shared/adminUsers';
import {
  baghdadRange,
  canonicalJson,
  computeSubscriptionExpiry,
  generateReferenceCode,
  normalizeLimitedText,
  requestPayloadHash,
  withUniqueReference,
} from '../shared/subscriptionManagement';

let failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  if (!ok) failed++;
};

console.log('\n--- permission matrix ---');
for (const capability of SUBSCRIPTION_SUPPORT_CAPABILITIES) {
  check(`${capability} defaults denied`, !hasStaffCapability({ role: 'support', permissions: {} }, capability));
  check(`${capability} explicit true grants`, hasStaffCapability({ role: 'support', permissions: { [capability]: true } }, capability));
  check(`${capability} disabled override`, !hasStaffCapability({ role: 'support', staffDisabled: true, permissions: { [capability]: true } }, capability));
  check(`${capability} is denied to a representative`, !hasStaffCapability({ role: 'admin', permissions: {} }, capability));
}
for (const capability of SUBSCRIPTION_MASTER_CAPABILITIES) {
  check(`${capability} cannot be stored onto Support`, !hasStaffCapability({ role: 'support', permissions: { [capability]: true } }, capability));
  check(`${capability} belongs to Master`, hasStaffCapability({ role: 'master_admin' }, capability));
}
check('legacy manageSubscriptions grants no activation', !hasStaffCapability({ role: 'support', permissions: { manageSubscriptions: true } }, 'canActivate'));

console.log('\n--- enums and plans ---');
check('manual methods exact', canonicalJson(MANUAL_PAYMENT_METHODS) === canonicalJson(['cash', 'zaincash', 'superkey', 'grant', 'other']));
check('annual included in paid manual', PAID_MANUAL_PLANS.includes('annual'));
check('annual included in grants', GRANT_PLANS.includes('annual'));
check('ten_days included in grants', GRANT_PLANS.includes('ten_days'));

console.log('\n--- expiry and Baghdad ranges ---');
const now = new Date('2026-10-12T09:00:00.000Z');
const future = new Date('2026-10-20T09:00:00.000Z');
check('active entitlement stacks from future expiry', computeSubscriptionExpiry(now, future, true, 'monthly').expiresAt.toISOString() === '2026-11-19T09:00:00.000Z');
check('inactive entitlement starts from server time', computeSubscriptionExpiry(now, future, false, 'monthly').expiresAt.toISOString() === '2026-11-11T09:00:00.000Z');
const day = baghdadRange('today', new Date('2026-10-12T22:30:00.000Z'));
check('Baghdad today crosses UTC date correctly', day.start.toISOString() === '2026-10-12T21:00:00.000Z' && day.end.toISOString() === '2026-10-13T21:00:00.000Z');
const beforeMidnight = baghdadRange('today', new Date('2026-10-12T20:59:59.999Z'));
const afterMidnight = baghdadRange('today', new Date('2026-10-12T21:00:00.001Z'));
check('Baghdad midnight switches at the exact UTC boundary',
  beforeMidnight.start.toISOString() === '2026-10-11T21:00:00.000Z'
  && afterMidnight.start.toISOString() === '2026-10-12T21:00:00.000Z');
const lastMonth = baghdadRange('last_month', new Date('2026-01-15T12:00:00.000Z'));
check('last month crosses year boundary', lastMonth.start.toISOString() === '2025-11-30T21:00:00.000Z' && lastMonth.end.toISOString() === '2025-12-31T21:00:00.000Z');

console.log('\n--- references, hashes and text ---');
for (const prefix of ['ACT', 'RCT', 'RST', 'VOID', 'PAY'] as const) {
  check(`${prefix} reference shape`, new RegExp(`^${prefix}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$`).test(generateReferenceCode(prefix)));
}
const collisionCodes = ['ACT-222222', 'ACT-333333'];
let collisionAttempts = 0;
const retriedReference = await withUniqueReference('ACT', async (code) => {
  collisionAttempts++;
  if (collisionAttempts === 1) {
    const error: any = new Error('collision');
    error.code = 'REFERENCE_COLLISION';
    throw error;
  }
  return code;
}, () => collisionCodes.shift()!);
check('reference collisions retry with a new candidate', collisionAttempts === 2 && retriedReference === 'ACT-333333');
check('canonical hash ignores object key order', requestPayloadHash({ b: 2, a: 1 }) === requestPayloadHash({ a: 1, b: 2 }));
check('trimmed notes are canonical', normalizeLimitedText('  paid at desk  ') === 'paid at desk');
let lengthRejected = false;
try { normalizeLimitedText('x'.repeat(201)); } catch { lengthRejected = true; }
check('notes over 200 Unicode characters rejected', lengthRejected);

console.log('\n--- permanent Support deletion guard ---');
let firestoreUserDeleted = false;
let authUserDeleted = false;
const deletionDb = (outstanding: number) => ({
  collection(name: string) {
    return {
      doc() {
        if (name === 'supportBalances') {
          return { get: async () => ({ exists: true, data: () => ({ outstanding }) }) };
        }
        return { delete: async () => { firestoreUserDeleted = true; } };
      },
    };
  },
});
const deletionAuth = { deleteUser: async () => { authUserDeleted = true; } };
let guardedDeletionCode = '';
try { await deleteUserAccount(deletionDb(-500), deletionAuth, 'support@test.dev'); }
catch (error: any) { guardedDeletionCode = error?.code || ''; }
check('permanent deletion rejects a negative Support balance before deleting anything',
  guardedDeletionCode === 'NON_ZERO_SUPPORT_BALANCE' && !firestoreUserDeleted && !authUserDeleted);
await deleteUserAccount(deletionDb(0), deletionAuth, 'support@test.dev');
check('permanent deletion proceeds after exact settlement', firestoreUserDeleted && authUserDeleted);

console.log(failed ? `\n${failed} check(s) failed.\n` : '\nAll subscription-management unit checks passed.\n');
process.exit(failed ? 1 : 0);
