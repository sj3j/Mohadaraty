/**
 * Verifies 10-day grant plan and Support grant request flow.
 *
 * Run with: npx tsx scripts/subscriptionGrantRequest.test.ts
 */
import { PLAN_CONFIG, type SubscriptionPlan } from '../src/types';
import { PLAN_CONFIG as SERVER_PLAN_CONFIG } from '../shared/subscriptions';
import { GRANT_PLANS, MANUAL_PAYMENT_METHODS } from '../shared/subscriptionTypes';
import { requestSupportGrant } from '../shared/subscriptionManagement';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail: unknown = '') {
  if (ok) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${detail !== '' ? ' -> ' + String(detail) : ''}`);
    failed++;
  }
}

console.log('1. Plan configuration and types:');
check(
  'GRANT_PLANS includes ten_days',
  (GRANT_PLANS as readonly string[]).includes('ten_days')
);

check(
  'MANUAL_PAYMENT_METHODS includes grant',
  (MANUAL_PAYMENT_METHODS as readonly string[]).includes('grant')
);

check(
  'Client PLAN_CONFIG has ten_days with 10 days and price 0',
  PLAN_CONFIG.ten_days.days === 10 &&
    PLAN_CONFIG.ten_days.price === 0 &&
    PLAN_CONFIG.ten_days.labelAr.includes('10')
);

check(
  'Server PLAN_CONFIG has ten_days matching client',
  SERVER_PLAN_CONFIG.ten_days.days === 10 &&
    SERVER_PLAN_CONFIG.ten_days.price === 0
);

console.log('\n2. Mock Support Grant Request Logic:');

async function testSupportGrant() {
  const usersStore: Record<string, any> = {
    'student@example.com': {
      name: 'Talib Test',
      email: 'student@example.com',
    },
  };
  const subsStore: Record<string, any> = {};

  const mockDb = {
    collection(name: string) {
      if (name === 'users') {
        return {
          doc(id: string) {
            return {
              async get() {
                const data = usersStore[id];
                return {
                  exists: !!data,
                  data: () => data,
                };
              },
            };
          },
        };
      }
      if (name === 'subscriptions') {
        return {
          doc(id: string) {
            return {
              async get() {
                const data = subsStore[id];
                return {
                  exists: !!data,
                  data: () => data,
                };
              },
              async set(doc: any) {
                subsStore[id] = doc;
              },
            };
          },
        };
      }
      throw new Error('Unknown collection ' + name);
    },
  };

  const mockAdmin = {
    firestore: Object.assign(() => mockDb, {
      FieldValue: {
        serverTimestamp: () => 'SERVER_TIMESTAMP',
      },
    }),
  };

  const supportActor = {
    uid: 'support_staff_1',
    email: 'support1@alsafwa.edu.iq',
    name: 'Support Agent 1',
    role: 'support',
    isMasterAdmin: false,
    staffDisabled: false,
    permissions: {
      canActivate: true,
    },
  };

  // Test 1: Successful request for ten_days
  const res1 = await requestSupportGrant(mockAdmin as any, supportActor as any, {
    requestId: 'req_grant_1',
    studentEmail: 'student@example.com',
    plan: 'ten_days',
    reason: 'طالب متميز يحتاج منحة',
  });

  check('returns success and id', res1.success === true && res1.id === 'req_grant_1');
  const doc1 = subsStore['req_grant_1'];
  check('subscription status is pending', doc1?.status === 'pending');
  check('subscription paymentMethod is grant', doc1?.paymentMethod === 'grant');
  check('subscription amount is 0', doc1?.amount === 0);
  check('subscription plan is ten_days', doc1?.plan === 'ten_days');
  check('subscription notes contain reason', doc1?.notes === 'طالب متميز يحتاج منحة');
  check('requestedBy matches support actor', doc1?.requestedBy?.uid === 'support_staff_1');

  // Test 2: Successful request for seasonal (grants can be any GRANT_PLANS)
  const res2 = await requestSupportGrant(mockAdmin as any, supportActor as any, {
    requestId: 'req_grant_2',
    studentEmail: 'student@example.com',
    plan: 'seasonal',
  });
  check('allows seasonal grant request', res2.success === true);
  const doc2 = subsStore['req_grant_2'];
  check('seasonal grant request amount is 0', doc2?.amount === 0);
  check('seasonal grant plan is seasonal', doc2?.plan === 'seasonal');

  // Test 3: Idempotent replay
  const resReplay = await requestSupportGrant(mockAdmin as any, supportActor as any, {
    requestId: 'req_grant_1',
    studentEmail: 'student@example.com',
    plan: 'ten_days',
  });
  check('idempotently returns replayed: true on duplicate requestId', resReplay.replayed === true);

  // Test 4: Rejection of non-existent student
  let errorStudentNotFound = false;
  try {
    await requestSupportGrant(mockAdmin as any, supportActor as any, {
      requestId: 'req_grant_3',
      studentEmail: 'unknown@example.com',
      plan: 'ten_days',
    });
  } catch (err: any) {
    if (err.status === 404) errorStudentNotFound = true;
  }
  check('rejects unknown student with 404', errorStudentNotFound);

  // Test 5: Rejection of invalid plan
  let errorInvalidPlan = false;
  try {
    await requestSupportGrant(mockAdmin as any, supportActor as any, {
      requestId: 'req_grant_4',
      studentEmail: 'student@example.com',
      plan: 'lifetime' as any,
    });
  } catch (err: any) {
    if (err.status === 400) errorInvalidPlan = true;
  }
  check('rejects invalid grant plan with 400', errorInvalidPlan);

  // Test 6: Rejection if support account has no canActivate capability
  let errorNoCapability = false;
  try {
    await requestSupportGrant(mockAdmin as any, { ...supportActor, permissions: {} } as any, {
      requestId: 'req_grant_5',
      studentEmail: 'student@example.com',
      plan: 'ten_days',
    });
  } catch (err: any) {
    if (err.status === 403) errorNoCapability = true;
  }
  check('rejects actor without canActivate capability with 403', errorNoCapability);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

testSupportGrant().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
