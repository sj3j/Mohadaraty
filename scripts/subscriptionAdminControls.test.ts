import {
  baghdadRange,
  generateReferenceCode,
  modifySubscriptionEnd,
  terminateSubscription,
  resolveStudent,
  getActiveSubscriptions,
  getReports,
  SubscriptionManagementError,
  type SubscriptionActor,
} from '../shared/subscriptionManagement';

let failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  if (!ok) failed++;
};

console.log('\n--- 1. baghdadRange this_year ---');
const testDate = new Date('2026-06-15T12:00:00.000Z');
const yearRange = baghdadRange('this_year', testDate);
check('this_year start is Dec 31 21:00 UTC of previous year', yearRange.start.toISOString() === '2025-12-31T21:00:00.000Z');
check('this_year end is Dec 31 21:00 UTC of current year', yearRange.end.toISOString() === '2026-12-31T21:00:00.000Z');

console.log('\n--- 2. Reference codes with MOD and TRM ---');
const modCode = generateReferenceCode('MOD');
check('MOD reference shape', /^MOD-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/.test(modCode));
const trmCode = generateReferenceCode('TRM');
check('TRM reference shape', /^TRM-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/.test(trmCode));

console.log('\n--- 3. Master admin authorization checks ---');
const masterActor: SubscriptionActor = {
  uid: 'master_1',
  email: 'master@test.dev',
  name: 'Master Admin',
  role: 'master_admin',
  isMasterAdmin: true,
  staffDisabled: false,
  permissions: { canGrant: true, canViewExpiring: true },
};

const supportActor: SubscriptionActor = {
  uid: 'support_1',
  email: 'support@test.dev',
  name: 'Support User',
  role: 'support',
  isMasterAdmin: false,
  staffDisabled: false,
  permissions: { canActivate: true, canViewExpiring: true },
};

let nonMasterCaught = false;
try {
  await modifySubscriptionEnd({} as any, supportActor, {
    requestId: 'req_12345678',
    studentEmail: 'student@test.dev',
    newEndDate: '2026-11-01T00:00:00.000Z',
  });
} catch (err: any) {
  if (err instanceof SubscriptionManagementError && err.code === 'MASTER_ONLY') {
    nonMasterCaught = true;
  }
}
check('modifySubscriptionEnd rejects non-master actor with 403 MASTER_ONLY', nonMasterCaught);

let nonMasterTerminateCaught = false;
try {
  await terminateSubscription({} as any, supportActor, {
    requestId: 'req_12345678',
    studentEmail: 'student@test.dev',
    immediate: true,
  });
} catch (err: any) {
  if (err instanceof SubscriptionManagementError && err.code === 'MASTER_ONLY') {
    nonMasterTerminateCaught = true;
  }
}
check('terminateSubscription rejects non-master actor with 403 MASTER_ONLY', nonMasterTerminateCaught);

console.log('\n--- 4. Mock Transaction tests for modifySubscriptionEnd & terminateSubscription ---');
const mockUserDoc = {
  name: 'Ahmed Student',
  email: 'student@test.dev',
  isSubscribed: true,
  subscriptionPlan: 'monthly',
  subscriptionEnd: { toDate: () => new Date('2026-10-20T00:00:00.000Z') },
};

const writtenRecords: Record<string, any> = {};
const userUpdates: Record<string, any> = {};
const refCodes: Record<string, any> = {};

const mockAdmin = {
  firestore: () => ({
    collection: (col: string) => ({
      doc: (id: string) => ({
        get: async () => ({
          exists: col === 'users' && id === 'student@test.dev',
          id,
          data: () => col === 'users' ? mockUserDoc : undefined,
        }),
      }),
      where: () => ({
        limit: () => ({
          get: async () => ({ empty: true, docs: [] }),
        }),
        where: () => ({
          get: async () => ({ empty: true, docs: [] }),
        }),
      }),
    }),
    runTransaction: async (updateFn: any) => {
      const tx = {
        get: async (ref: any) => {
          if (ref._col === 'subscriptionRecords') {
            return { exists: !!writtenRecords[ref._id], data: () => writtenRecords[ref._id] };
          }
          if (ref._col === 'referenceCodes') {
            return { exists: !!refCodes[ref._id] };
          }
          if (ref._col === 'users') {
            return { exists: true, data: () => mockUserDoc };
          }
          if (ref._col === 'subscriptions') {
            return { docs: [] };
          }
          return { exists: false };
        },
        create: (ref: any, data: any) => {
          if (ref._col === 'subscriptionRecords') writtenRecords[ref._id] = data;
          if (ref._col === 'referenceCodes') refCodes[ref._id] = data;
        },
        update: (ref: any, data: any) => {
          if (ref._col === 'users') Object.assign(userUpdates, data);
        },
      };
      return updateFn(tx);
    },
    Timestamp: {
      fromDate: (d: Date) => ({ toDate: () => d, toMillis: () => d.getTime(), isTimestamp: true }),
      now: () => ({ toDate: () => new Date(), toMillis: () => Date.now(), isTimestamp: true }),
    },
  }),
};

const activeSubs: any[] = [
  {
    ref: { _col: 'subscriptions', _id: 'sub_active_1' },
    id: 'sub_active_1',
    data: () => ({
      userId: 'student@test.dev',
      status: 'active',
      auditedRecordId: 'act_req_999',
      plan: 'monthly',
      amount: 15000,
    }),
  },
];

writtenRecords['act_req_999'] = {
  type: 'activation',
  source: 'manual',
  plan: 'monthly',
  amount: 15000,
  actorUid: 'support_staff_1',
};

const supportBalances: Record<string, any> = {
  support_staff_1: {
    outstanding: 15000,
    totalCredited: 15000,
    totalReversed: 0,
    commissionRate: 0,
  },
};
const supportLedger: Record<string, any> = {};

const firestoreFn = () => ({
  collection: (col: string) => ({
    doc: (id: string) => ({
      _col: col,
      _id: id,
      get: async () => ({
        exists: (col === 'users' && id === 'student@test.dev') || (col === 'supportBalances' && !!supportBalances[id]),
        id,
        data: () => col === 'users' ? mockUserDoc : col === 'supportBalances' ? supportBalances[id] : undefined,
      }),
    }),
    where: () => ({
      limit: () => ({ get: async () => ({ empty: true, docs: [] }) }),
      where: () => ({ _col: 'subscriptions', get: async () => ({ docs: activeSubs }) }),
    }),
  }),
  runTransaction: async (updateFn: any) => {
    const tx = {
      get: async (ref: any) => {
        if (ref._col === 'subscriptionRecords') return { exists: !!writtenRecords[ref._id], data: () => writtenRecords[ref._id] };
        if (ref._col === 'referenceCodes') return { exists: !!refCodes[ref._id] };
        if (ref._col === 'users') return { exists: true, id: ref._id, data: () => mockUserDoc };
        if (ref._col === 'subscriptions') return { docs: activeSubs };
        if (ref._col === 'supportBalances') return { exists: !!supportBalances[ref._id], data: () => supportBalances[ref._id] };
        return { exists: false };
      },
      create: (ref: any, data: any) => {
        if (ref._col === 'subscriptionRecords') writtenRecords[ref._id] = data;
        if (ref._col === 'referenceCodes') refCodes[ref._id] = data;
        if (ref._col === 'supportLedger') supportLedger[ref._id] = data;
      },
      update: (ref: any, data: any) => {
        if (ref._col === 'users') Object.assign(userUpdates, data);
        if (ref._col === 'subscriptionRecords' && writtenRecords[ref._id]) Object.assign(writtenRecords[ref._id], data);
        if (ref._col === 'subscriptions') {
          const sub = activeSubs.find(s => s.id === ref._id);
          if (sub) Object.assign(sub.data(), data);
        }
      },
      set: (ref: any, data: any) => {
        if (ref._col === 'supportBalances') supportBalances[ref._id] = { ...(supportBalances[ref._id] || {}), ...data };
      },
    };
    return updateFn(tx);
  },
});

firestoreFn.Timestamp = {
  fromDate: (d: Date) => ({ toDate: () => d, toMillis: () => d.getTime(), isTimestamp: true }),
  now: () => ({ toDate: () => new Date(), toMillis: () => Date.now(), isTimestamp: true }),
};

mockAdmin.firestore = firestoreFn as any;

const modifyRes = await modifySubscriptionEnd(mockAdmin, masterActor, {
  requestId: 'mod_req_12345678',
  studentEmail: 'student@test.dev',
  newEndDate: '2026-12-31T23:59:59.000Z',
  reason: 'Extended by admin reward',
});

check('modifySubscriptionEnd success', modifyRes.success === true);
check('modifySubscriptionEnd returns referenceCode', /^MOD-[A-Z0-9]{6}$/.test(modifyRes.referenceCode));
check('modifySubscriptionEnd updates user subscriptionEnd', userUpdates.subscriptionEnd?.toMillis() === new Date('2026-12-31T23:59:59.000Z').getTime());
check('modifySubscriptionEnd records audit log', writtenRecords['mod_req_12345678']?.type === 'modify_expiry');
check('modifySubscriptionEnd audit contains actor snapshot', writtenRecords['mod_req_12345678']?.actor?.email === 'master@test.dev');

const termRes = await terminateSubscription(mockAdmin, masterActor, {
  requestId: 'trm_req_12345678',
  studentEmail: 'student@test.dev',
  immediate: true,
  reason: 'Course completed',
});

check('terminateSubscription success', termRes.success === true);
check('terminateSubscription returns referenceCode', /^TRM-[A-Z0-9]{6}$/.test(termRes.referenceCode));
check('terminateSubscription sets isSubscribed to false', userUpdates.isSubscribed === false);
check('terminateSubscription records audit log', writtenRecords['trm_req_12345678']?.type === 'termination');
check('terminateSubscription records immediate flag', writtenRecords['trm_req_12345678']?.immediate === true);
check('terminateSubscription marks auditedRecord with cancelledBy', !!writtenRecords['act_req_999']?.cancelledBy);
check('terminateSubscription reverses Support balance', supportBalances['support_staff_1']?.outstanding === 0);
check('terminateSubscription updates Support totalReversed', supportBalances['support_staff_1']?.totalReversed === 15000);
check('terminateSubscription creates supportLedger reversal', supportLedger['trm_req_12345678']?.type === 'void_reversal');

console.log('\n--- 5. getReports excludes grant and cancelled subscriptions ---');
const reportsFirestoreFn = () => ({
  collection: (col: string) => ({
    where: () => ({
      get: async () => ({ docs: [] }),
      where: () => ({
        get: async () => {
          if (col === 'subscriptionRecords') {
            return {
              docs: [
                // Paid monthly activation
                { data: () => ({ type: 'activation', source: 'manual', plan: 'monthly', amount: 1000, studentEmail: 'paid1@test.dev' }) },
                // Cancelled paid monthly activation (should be deducted/excluded)
                { data: () => ({ type: 'activation', source: 'manual', plan: 'monthly', amount: 2500, studentEmail: 'cancelled_paid@test.dev', cancelledBy: { recordId: 'trm_req_99' } }) },
                // Cancelled paid monthly activation without cancelledBy on record, but operational sub has status: 'cancelled'
                { data: () => ({ type: 'activation', source: 'manual', plan: 'monthly', amount: 3000, studentEmail: 'unmarked_cancelled@test.dev', entitlementId: 'op_cancelled_sub' }) },
                // Complimentary grants (should be excluded)
                { data: () => ({ type: 'grant', source: 'grant', plan: 'annual', amount: 0, studentEmail: 'grant1@test.dev' }) },
                { data: () => ({ type: 'grant', source: 'grant', plan: 'monthly', amount: 0, studentEmail: 'grant2@test.dev' }) },
                // Cancelled grant (0 amount, should not cause negative deduction)
                { data: () => ({ type: 'grant', source: 'grant', plan: 'monthly', amount: 0, studentEmail: 'grant_cancelled@test.dev', cancelledBy: { recordId: 'trm_req_100' } }) },
              ],
            };
          }
          if (col === 'subscriptions') {
            return {
              docs: [
                // Operational subscription that was cancelled
                { id: 'op_cancelled_sub', data: () => ({ status: 'cancelled', auditedRecordId: 'op_cancelled_sub', plan: 'monthly', amount: 3000, userEmail: 'unmarked_cancelled@test.dev' }) },
                // Legacy admin grant (should be excluded)
                { data: () => ({ status: 'active', paymentMethod: 'admin_grant', plan: 'monthly', amount: 0, userEmail: 'grant3@test.dev' }) },
                // Legacy paid annual subscription
                { data: () => ({ status: 'active', paymentMethod: 'zaincash', plan: 'annual', amount: 12000, userEmail: 'paid2@test.dev' }) },
                // Legacy cancelled subscription (should be excluded)
                { data: () => ({ status: 'cancelled', paymentMethod: 'zaincash', plan: 'annual', amount: 12000, userEmail: 'cancelled_legacy@test.dev' }) },
              ],
            };
          }
          return { docs: [] };
        },
      }),
    }),
    get: async () => ({ docs: [] }),
  }),
});
reportsFirestoreFn.Timestamp = firestoreFn.Timestamp;

const reportsAdmin = {
  firestore: reportsFirestoreFn,
};

const reportsResult = await getReports(reportsAdmin as any, masterActor, 'this_year');
console.log('DEBUG reportsResult:', JSON.stringify(reportsResult.revenue));
check('Total revenue is 13,000 (1000 + 12000; cancelled 2500 and 3000 deducted)', reportsResult.revenue.total === 13000);
check('Monthly paid count is 1 (grants and cancelled activations excluded)', reportsResult.revenue.planBreakdown.monthly.count === 1);
check('Monthly paid revenue is 1,000 (cancelled 2500 and 3000 deducted)', reportsResult.revenue.planBreakdown.monthly.revenue === 1000);
check('Monthly unique subscribers is 1 (grants and cancelled excluded)', reportsResult.revenue.planBreakdown.monthly.uniqueSubscribers === 1);
check('Annual paid count is 1 (grant and cancelled legacy excluded)', reportsResult.revenue.planBreakdown.annual.count === 1);
check('Annual paid revenue is 12,000 (cancelled legacy excluded)', reportsResult.revenue.planBreakdown.annual.revenue === 12000);
check('Annual unique subscribers is 1', reportsResult.revenue.planBreakdown.annual.uniqueSubscribers === 1);
check('Yearly revenue is 13,000', reportsResult.yearlyRevenue === 13000);

console.log(`\nTests completed with ${failed} failure(s).`);
if (failed > 0) process.exit(1);
