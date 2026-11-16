import {
  SUBSCRIPTION_MASTER_CAPABILITIES,
  SUBSCRIPTION_SUPPORT_CAPABILITIES,
  hasStaffCapability,
} from '../shared/staffCapabilities';
import { GRANT_PLANS, MANUAL_PAYMENT_METHODS, PAID_MANUAL_PLANS } from '../shared/subscriptionTypes';
import { deleteUserAccount } from '../shared/adminUsers';
import { buildSupportSubscriptionsWorkbook } from '../src/lib/supportExcelExport';
import {
  baghdadRange,
  canonicalJson,
  computeSubscriptionExpiry,
  enrichStudentNames,
  generateReferenceCode,
  getHistory,
  getReports,
  normalizeLimitedText,
  requestPayloadHash,
  resolveStudentDisplayName,
  resolveStudentRosterName,
  resolveStudentStageId,
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

console.log('\n--- student roster name resolution ---');
const mockRosterDb = {
  collection(name: string) {
    if (name === 'students') {
      return {
        doc(id: string) {
          const docs: Record<string, any> = {
            'ali@uob.edu.iq': { originalName: 'علي أحمد الكرخي', name: 'علي الكرخي' },
            'nour,saleh@uob,edu,iq': { originalName: 'نور صالح' },
            'justname@test.dev': { name: 'عمر فاروق' },
          };
          return {
            get: async () => ({
              exists: Boolean(docs[id]),
              data: () => docs[id],
            }),
          };
        },
        where(field: string, op: string, val: any) {
          return {
            limit() {
              return {
                get: async () => {
                  if (field === 'googleEmail' && val === 'sarah.google@uob.edu.iq') {
                    return {
                      empty: false,
                      docs: [{ id: 'std_sarah', data: () => ({ originalName: 'سارة عبد الله' }) }],
                    };
                  }
                  return { empty: true, docs: [] };
                },
              };
            },
          };
        },
      };
    }
    return {
      doc() { return { get: async () => ({ exists: false, data: () => undefined }) }; },
    };
  },
};

const directRosterName = await resolveStudentRosterName(mockRosterDb, 'ali@uob.edu.iq');
check('resolveStudentRosterName finds originalName by exact email doc', directRosterName === 'علي أحمد الكرخي');

const commaRosterName = await resolveStudentRosterName(mockRosterDb, 'nour.saleh@uob.edu.iq');
check('resolveStudentRosterName finds originalName by comma-encoded email doc', commaRosterName === 'نور صالح');

const googleRosterName = await resolveStudentRosterName(mockRosterDb, 'sarah.google@uob.edu.iq');
check('resolveStudentRosterName finds originalName via googleEmail query', googleRosterName === 'سارة عبد الله');

const nameOnlyRoster = await resolveStudentRosterName(mockRosterDb, 'justname@test.dev');
check('resolveStudentRosterName falls back to name if originalName missing', nameOnlyRoster === 'عمر فاروق');

const missingRoster = await resolveStudentRosterName(mockRosterDb, 'notfound@test.dev');
check('resolveStudentRosterName returns null when not found', missingRoster === null);

console.log('\n--- student display name prioritization ---');
const rosterBeatsUser = await resolveStudentDisplayName(
  mockRosterDb,
  { originalName: 'علي من الحساب', name: 'علي المستعار' },
  'ali@uob.edu.iq'
);
check('resolveStudentDisplayName prioritizes roster originalName over user fields', rosterBeatsUser === 'علي أحمد الكرخي');

const userOriginalFallback = await resolveStudentDisplayName(
  mockRosterDb,
  { originalName: 'فاطمة الزهراء', name: 'فاطمة' },
  'not_in_roster@test.dev'
);
check('resolveStudentDisplayName falls back to user originalName if not in roster', userOriginalFallback === 'فاطمة الزهراء');

const userNameFallback = await resolveStudentDisplayName(
  mockRosterDb,
  { name: 'حيدر علي' },
  'not_in_roster@test.dev'
);
check('resolveStudentDisplayName falls back to user name if originalName missing', userNameFallback === 'حيدر علي');

const emailFallback = await resolveStudentDisplayName(
  mockRosterDb,
  { name: 'student@test.dev' },
  'student@test.dev'
);
check('resolveStudentDisplayName falls back to email if name is email address', emailFallback === 'student@test.dev');

console.log('\n--- batch dynamic student name enrichment ---');
const rowsToEnrich = [
  { id: '1', studentEmail: 'ali@uob.edu.iq', studentName: undefined },
  { id: '2', studentEmail: 'nour.saleh@uob.edu.iq', studentName: 'nour.saleh@uob.edu.iq' },
  { id: '3', studentEmail: 'sarah.google@uob.edu.iq', studentName: '' },
  { id: '4', studentEmail: 'other@test.dev', studentName: 'اسم محفوظ مسبقا' },
];
await enrichStudentNames(mockRosterDb, rowsToEnrich);
check('enrichStudentNames enriches undefined name with roster originalName', rowsToEnrich[0].studentName === 'علي أحمد الكرخي');
check('enrichStudentNames replaces email name with roster originalName', rowsToEnrich[1].studentName === 'نور صالح');
check('enrichStudentNames enriches empty name via googleEmail lookup', rowsToEnrich[2].studentName === 'سارة عبد الله');
check('enrichStudentNames preserves existing valid studentName', rowsToEnrich[3].studentName === 'اسم محفوظ مسبقا');

console.log('\n--- getHistory Support scoping and name resolution ---');
const historyRecords = [
  {
    id: 'rec_1',
    actorUid: 'support_1',
    actor: { uid: 'support_1', name: 'Support One', email: 'support1@test.dev' },
    studentId: 'ali@uob.edu.iq',
    studentEmail: 'ali@uob.edu.iq',
    studentName: 'ali@uob.edu.iq',
    type: 'activation',
    plan: 'monthly',
    amount: 15000,
    referenceCodeNormalized: 'ACT-AAAAAA',
    createdAt: { toMillis: () => 1000 },
  },
  {
    id: 'rec_2',
    actorUid: 'support_2',
    actor: { uid: 'support_2', name: 'Support Two', email: 'support2@test.dev' },
    studentId: 'nour.saleh@uob.edu.iq',
    studentEmail: 'nour.saleh@uob.edu.iq',
    studentName: 'nour.saleh@uob.edu.iq',
    type: 'activation',
    plan: 'monthly',
    amount: 15000,
    referenceCodeNormalized: 'ACT-BBBBBB',
    createdAt: { toMillis: () => 2000 },
  },
];

const mockHistoryDb = {
  ...mockRosterDb,
  collection(name: string) {
    if (name === 'students') return mockRosterDb.collection('students');
    if (name === 'subscriptionRecords') {
      const createQuery = (filters: Array<[string, string, any]> = []) => ({
        where(f: string, op: string, val: any) {
          return createQuery([...filters, [f, op, val]]);
        },
        orderBy() { return this; },
        startAfter() { return this; },
        limit() { return this; },
        get: async () => {
          const matched = historyRecords.filter(item => {
            return filters.every(([f, op, val]) => {
              if (op === '==') return (item as any)[f] === val;
              return true;
            });
          });
          return {
            empty: matched.length === 0,
            docs: matched.map(d => ({ id: d.id, exists: true, data: () => d })),
          };
        },
      });
      return createQuery();
    }
    if (name === 'subscriptions') {
      return {
        where() { return this; },
        orderBy() { return this; },
        startAfter() { return this; },
        limit() { return this; },
        get: async () => ({ empty: true, docs: [] }),
      };
    }
    return mockRosterDb.collection(name);
  },
};

const mockAdminForHistory = {
  firestore: Object.assign(() => mockHistoryDb, {
    FieldPath: { documentId: () => '__name__' },
    Timestamp: {
      fromMillis: (ms: number) => ({ toMillis: () => ms, toDate: () => new Date(ms) }),
    },
  }),
};

const supportActor = {
  uid: 'support_1',
  email: 'support1@test.dev',
  name: 'Support One',
  role: 'support',
  isMasterAdmin: false,
  staffDisabled: false,
  permissions: { canViewHistory: true },
};

// 1. Support member querying without staff param is automatically scoped to their own UID
const ownHistory = await getHistory(mockAdminForHistory, supportActor as any, {});
check('Support query without staff param returns only their own activations',
  ownHistory.items.length === 1 && ownHistory.items[0].id === 'rec_1');
check('Support query automatically enriches studentName with roster originalName',
  ownHistory.items[0].studentName === 'علي أحمد الكرخي');

// 2. Support member attempting to view another staff activations is rejected with 403
let foreignStaffError = '';
try {
  await getHistory(mockAdminForHistory, supportActor as any, { staff: 'support_2' });
} catch (e: any) {
  foreignStaffError = e.code || '';
}
check('Support member querying another staff member is rejected with OWN_HISTORY_ONLY',
  foreignStaffError === 'OWN_HISTORY_ONLY');

// 3. Master admin can query any staff or all staff
const masterActor = {
  uid: 'master_1',
  email: 'master@test.dev',
  name: 'Master Admin',
  role: 'master_admin',
  isMasterAdmin: true,
  staffDisabled: false,
  permissions: {},
};
const masterAllHistory = await getHistory(mockAdminForHistory, masterActor as any, {});
check('Master admin can view all history records', masterAllHistory.items.length === 2);

console.log('\n--- stage resolution (resolveStudentStageId) ---');
const stageMockDb = {
  collection(name: string) {
    if (name === 'users') {
      const users: Record<string, any> = {
        'u_stage1': { stageId: 'stage_1', email: 'u1@test.dev' },
        'u_nostage': { email: 'unassigned@test.dev' },
      };
      return {
        doc(id: string) {
          return {
            get: async () => ({
              exists: Boolean(users[id]),
              data: () => users[id],
            }),
          };
        },
      };
    }
    if (name === 'students') {
      const students: Record<string, any> = {
        's2@uob.edu.iq': { stageId: 'stage_2' },
        's3,comma@uob,edu,iq': { stageId: 'stage_3' },
      };
      return {
        doc(id: string) {
          return {
            get: async () => ({
              exists: Boolean(students[id]),
              data: () => students[id],
            }),
          };
        },
        where(field: string, op: string, val: any) {
          return {
            limit() {
              return {
                get: async () => {
                  if (field === 'googleEmail' && val === 's4.google@uob.edu.iq') {
                    return {
                      empty: false,
                      docs: [{ id: 'std_4', data: () => ({ stageId: 'stage_4' }) }],
                    };
                  }
                  return { empty: true, docs: [] };
                },
              };
            },
          };
        },
      };
    }
    return {
      doc() { return { get: async () => ({ exists: false, data: () => undefined }) }; },
    };
  },
};

const testCache = new Map<string, string>();
const st1 = await resolveStudentStageId(stageMockDb, 'u_stage1', '', testCache);
check('resolveStudentStageId finds stageId from users doc', st1 === 'stage_1');
check('resolveStudentStageId caches the resolved stage', testCache.get('u_stage1') === 'stage_1');

const st2 = await resolveStudentStageId(stageMockDb, '', 's2@uob.edu.iq', testCache);
check('resolveStudentStageId finds stageId from students doc by email', st2 === 'stage_2');

const st3 = await resolveStudentStageId(stageMockDb, '', 's3.comma@uob.edu.iq', testCache);
check('resolveStudentStageId finds stageId from students doc by comma-encoded email', st3 === 'stage_3');

const st4 = await resolveStudentStageId(stageMockDb, '', 's4.google@uob.edu.iq', testCache);
check('resolveStudentStageId finds stageId via googleEmail query', st4 === 'stage_4');

const stUnassigned = await resolveStudentStageId(stageMockDb, 'u_nostage', 'unassigned@test.dev', testCache);
check('resolveStudentStageId falls back to unassigned when stageId missing', stUnassigned === 'unassigned');

console.log('\n--- getReports Stage Analysis & Dual-Metric Aggregation ---');
const reportNow = new Date();
const reportNowTimestamp = { toMillis: () => reportNow.getTime(), toDate: () => reportNow, getTime: () => reportNow.getTime() };
const futureTimestamp = { toMillis: () => reportNow.getTime() + 86400000 * 30, toDate: () => new Date(reportNow.getTime() + 86400000 * 30), getTime: () => reportNow.getTime() + 86400000 * 30 };
const pastTimestamp = { toMillis: () => reportNow.getTime() - 86400000 * 30, toDate: () => new Date(reportNow.getTime() - 86400000 * 30), getTime: () => reportNow.getTime() - 86400000 * 30 };

const reportUsersData: Record<string, any> = {
  'user_stg1': { stageId: 'stage_1', isSubscribed: true, subscriptionEnd: futureTimestamp, email: 'stg1@test.dev' },
  'user_stg2': { stageId: 'stage_2', isSubscribed: true, subscriptionEnd: futureTimestamp, email: 'stg2@test.dev' },
  'user_stg2_second': { stageId: 'stage_2', isSubscribed: true, subscriptionEnd: futureTimestamp, email: 'stg2_2@test.dev' },
  'user_expired': { stageId: 'stage_1', isSubscribed: true, subscriptionEnd: pastTimestamp, email: 'exp@test.dev' },
  'user_unassigned': { isSubscribed: true, subscriptionEnd: futureTimestamp, email: 'none@test.dev' },
};

const reportRecordsData = [
  {
    id: 'rec_stg1',
    type: 'activation',
    source: 'manual',
    plan: 'monthly',
    amount: 15000,
    studentId: 'user_stg1',
    studentEmail: 'stg1@test.dev',
    createdAt: reportNowTimestamp,
  },
  {
    id: 'rec_stg2',
    type: 'activation',
    source: 'manual',
    plan: 'seasonal',
    amount: 35000,
    studentId: 'user_stg2',
    studentEmail: 'stg2@test.dev',
    createdAt: reportNowTimestamp,
  },
];

const mockReportsDb: any = {
  collection(name: string) {
    if (name === 'users') {
      return {
        doc(id: string) {
          return {
            get: async () => ({
              exists: Boolean(reportUsersData[id]),
              data: () => reportUsersData[id],
            }),
          };
        },
        where(field: string, op: string, val: any) {
          return {
            get: async () => {
              const matched = Object.entries(reportUsersData)
                .filter(([_, u]) => u[field] === val)
                .map(([id, u]) => ({ id, exists: true, data: () => u }));
              return { empty: matched.length === 0, docs: matched };
            },
          };
        },
        get: async () => ({
          docs: Object.entries(reportUsersData).map(([id, u]) => ({ id, exists: true, data: () => u })),
        }),
      };
    }
    if (name === 'students') {
      return {
        doc() { return { get: async () => ({ exists: false, data: () => undefined }) }; },
        where() { return { limit() { return { get: async () => ({ empty: true, docs: [] }) }; } }; },
      };
    }
    if (name === 'subscriptionRecords') {
      const q: any = {
        where() { return q; },
        orderBy() { return q; },
        limit() { return q; },
        get: async () => ({
          docs: reportRecordsData.map(r => ({ id: r.id, exists: true, data: () => r })),
        }),
      };
      return q;
    }
    if (name === 'subscriptions') {
      const q: any = {
        where() { return q; },
        orderBy() { return q; },
        limit() { return q; },
        get: async () => ({ docs: [] }),
      };
      return q;
    }
    if (name === 'supportBalances') {
      return {
        get: async () => ({ docs: [] }),
        doc() { return { get: async () => ({ exists: false, data: () => undefined }) }; },
      };
    }
    if (name === 'supportLedger') {
      return {
        where() { return { orderBy() { return { limit() { return { get: async () => ({ docs: [] }) }; } }; } }; },
      };
    }
    return {
      doc() { return { get: async () => ({ exists: false, data: () => undefined }) }; },
    };
  },
};

const mockAdminForReports = {
  firestore: Object.assign(() => mockReportsDb, {
    FieldPath: { documentId: () => '__name__' },
    Timestamp: {
      fromDate: (d: Date) => ({ toMillis: () => d.getTime(), toDate: () => d, getTime: () => d.getTime() }),
      fromMillis: (ms: number) => ({ toMillis: () => ms, toDate: () => new Date(ms), getTime: () => ms }),
      now: () => reportNowTimestamp,
    },
  }),
};

const reportResult = await getReports(mockAdminForReports, masterActor as any, 'this_month');
check('getReports includes stageAnalysis object', Boolean(reportResult?.stageAnalysis));
check('totalActiveSubscribers counts only live subscriptions (excludes expired)',
  reportResult.stageAnalysis.totalActiveSubscribers === 4); // user_stg1, user_stg2, user_stg2_second, user_unassigned

check('totalPeriodRevenue matches revenue.total exactly',
  reportResult.stageAnalysis.totalPeriodRevenue === 50000 && reportResult.revenue.total === 50000);

const stg1Report = reportResult.stageAnalysis.stages.find((s: any) => s.stageId === 'stage_1');
check('Stage 1 active subscribers count is 1', stg1Report?.activeSubscribers === 1);
check('Stage 1 active percentage is 25%', stg1Report?.activePercentage === 25);
check('Stage 1 period revenue is 15000 IQD', stg1Report?.periodRevenue === 15000);
check('Stage 1 period revenue percentage is 30%', stg1Report?.periodRevenuePercentage === 30);
check('Stage 1 period activations is 1', stg1Report?.periodActivations === 1);

const stg2Report = reportResult.stageAnalysis.stages.find((s: any) => s.stageId === 'stage_2');
check('Stage 2 active subscribers count is 2', stg2Report?.activeSubscribers === 2);
check('Stage 2 active percentage is 50%', stg2Report?.activePercentage === 50);
check('Stage 2 period revenue is 35000 IQD', stg2Report?.periodRevenue === 35000);
check('Stage 2 period revenue percentage is 70%', stg2Report?.periodRevenuePercentage === 70);

const unassignedReport = reportResult.stageAnalysis.stages.find((s: any) => s.stageId === 'unassigned');
check('Unassigned stage is included when active subscribers > 0', Boolean(unassignedReport));
check('Unassigned stage has 1 subscriber and 0 revenue',
  unassignedReport?.activeSubscribers === 1 && unassignedReport?.periodRevenue === 0);

console.log('\n--- Excel export utility (buildSupportSubscriptionsWorkbook) ---');
const testExportRows = [
  {
    studentName: 'علي أحمد الكرخي',
    studentEmail: 'ali@uob.edu.iq',
    plan: 'monthly',
    amount: 15000,
    createdAt: '2026-10-12T10:30:00.000Z',
    paymentMethod: 'cash',
  },
  {
    studentName: 'نور صالح محمود',
    studentEmail: 'nour@uob.edu.iq',
    plan: 'annual',
    amount: 50000,
    createdAt: '2026-10-15T14:00:00.000Z',
    paymentMethod: 'zaincash',
  },
  {
    studentName: '',
    studentEmail: 'student3@test.dev',
    plan: 'ten_days',
    amount: 0,
    createdAt: '2026-10-16T18:00:00.000Z',
    paymentMethod: 'grant',
  },
];

const wb = buildSupportSubscriptionsWorkbook('أحمد الدعم', testExportRows);
check('buildSupportSubscriptionsWorkbook creates workbook with staff sheet name',
  Boolean(wb.Sheets['أحمد الدعم']));

const ws = wb.Sheets['أحمد الدعم'];
check('Excel sheet has RTL orientation enabled for Arabic',
  Array.isArray(ws['!views']) && ws['!views'][0]?.RTL === true);

check('Excel header columns are exact 6 Arabic columns',
  ws['A1']?.v === 'اسم المشترك'
  && ws['B1']?.v === 'نوع الاشتراك'
  && ws['C1']?.v === 'السعر'
  && ws['D1']?.v === 'تاريخ الاشتراك'
  && ws['E1']?.v === 'طريقة الدفع'
  && ws['F1']?.v === 'تم التدقيق'
);

check('Excel row 2 subscriber name uses official name', ws['A2']?.v === 'علي أحمد الكرخي');
check('Excel row 2 plan translated to Arabic', ws['B2']?.v === 'شهري');
check('Excel row 2 price numeric', ws['C2']?.v === 15000);
check('Excel row 2 payment method translated to Arabic', ws['E2']?.v === 'نقدي (كاش)');
check('Excel row 2 column F is visual checkbox box (☐) rather than literal FALSE', ws['F2']?.v === '☐');

check('Excel row 3 plan translated to Arabic (annual -> سنوي)', ws['B3']?.v === 'سنوي');
check('Excel row 3 payment method translated (zaincash -> زين كاش)', ws['E3']?.v === 'زين كاش');
check('Excel row 3 column F is visual checkbox box (☐) rather than literal FALSE', ws['F3']?.v === '☐');

check('Excel row 4 falls back to email when name missing', ws['A4']?.v === 'student3@test.dev');
check('Excel row 4 plan translated (ten_days -> 10 أيام)', ws['B4']?.v === '10 أيام');
check('Excel row 4 payment method translated (grant -> منحة)', ws['E4']?.v === 'منحة');
check('Excel row 4 column F is visual checkbox box (☐) rather than literal FALSE', ws['F4']?.v === '☐');

console.log('\n--- getHistory date range & unsettled filters ---');
const exportHistoryRecords = [
  {
    id: 'exp_1',
    actorUid: 'support_export',
    studentId: 's1@test.dev',
    studentEmail: 's1@test.dev',
    studentName: 'الطالب الأول',
    type: 'activation',
    plan: 'monthly',
    amount: 15000,
    paymentMethod: 'cash',
    referenceCodeNormalized: 'ACT-EXP111',
    createdAt: { toMillis: () => 1000, toDate: () => new Date(1000) },
  },
  {
    id: 'exp_2',
    actorUid: 'support_export',
    studentId: 's2@test.dev',
    studentEmail: 's2@test.dev',
    studentName: 'الطالب الثاني',
    type: 'activation',
    plan: 'annual',
    amount: 50000,
    paymentMethod: 'zaincash',
    referenceCodeNormalized: 'ACT-EXP222',
    createdAt: { toMillis: () => 2000, toDate: () => new Date(2000) },
  },
  {
    id: 'exp_3',
    actorUid: 'support_export',
    studentId: 's3@test.dev',
    studentEmail: 's3@test.dev',
    studentName: 'الطالب الثالث',
    type: 'activation',
    plan: 'monthly',
    amount: 15000,
    paymentMethod: 'cash',
    referenceCodeNormalized: 'ACT-EXP333',
    createdAt: { toMillis: () => 3000, toDate: () => new Date(3000) },
  },
];

const exportLedgerRecords = [
  {
    id: 'led_exp_1',
    supportUid: 'support_export',
    type: 'receive_full',
    createdAt: { toMillis: () => 1500, toDate: () => new Date(1500) },
  },
];

const exportMockDb = {
  ...mockRosterDb,
  collection(name: string) {
    if (name === 'students') return mockRosterDb.collection('students');
    if (name === 'subscriptionRecords') {
      const createExportQuery = (filters: Array<[string, string, any]> = []) => ({
        where(f: string, op: string, val: any) {
          return createExportQuery([...filters, [f, op, val]]);
        },
        orderBy() { return this; },
        startAfter() { return this; },
        limit() { return this; },
        get: async () => {
          const matched = exportHistoryRecords.filter(item => {
            return filters.every(([f, op, val]) => {
              if (op === '==') return (item as any)[f] === val;
              if (op === '>=') {
                const itemMs = (item as any)[f]?.toMillis ? (item as any)[f].toMillis() : new Date((item as any)[f]).getTime();
                const valMs = val?.toMillis ? val.toMillis() : new Date(val).getTime();
                return itemMs >= valMs;
              }
              if (op === '<=') {
                const itemMs = (item as any)[f]?.toMillis ? (item as any)[f].toMillis() : new Date((item as any)[f]).getTime();
                const valMs = val?.toMillis ? val.toMillis() : new Date(val).getTime();
                return itemMs <= valMs;
              }
              return true;
            });
          });
          return {
            empty: matched.length === 0,
            docs: matched.map(d => ({ id: d.id, exists: true, data: () => d })),
          };
        },
      });
      return createExportQuery();
    }
    if (name === 'supportLedger') {
      const createLedgerQuery = (filters: Array<[string, string, any]> = []) => ({
        where(f: string, op: string, val: any) {
          return createLedgerQuery([...filters, [f, op, val]]);
        },
        orderBy() { return this; },
        limit() { return this; },
        get: async () => {
          const matched = exportLedgerRecords.filter(item => {
            return filters.every(([f, op, val]) => {
              if (op === '==') return (item as any)[f] === val;
              if (op === 'in') return Array.isArray(val) && val.includes((item as any)[f]);
              return true;
            });
          });
          return {
            empty: matched.length === 0,
            docs: matched.map(d => ({ id: d.id, exists: true, data: () => d })),
          };
        },
      });
      return createLedgerQuery();
    }
    if (name === 'subscriptions') {
      return {
        where() { return this; },
        orderBy() { return this; },
        startAfter() { return this; },
        limit() { return this; },
        get: async () => ({ empty: true, docs: [] }),
      };
    }
    return mockRosterDb.collection(name);
  },
};

const mockAdminForExport = {
  firestore: Object.assign(() => exportMockDb, {
    FieldPath: { documentId: () => '__name__' },
    Timestamp: {
      fromDate: (d: Date) => ({ toMillis: () => d.getTime(), toDate: () => d }),
      fromMillis: (ms: number) => ({ toMillis: () => ms, toDate: () => new Date(ms) }),
    },
  }),
};

// Test fromDate/toDate range
const rangeHistory = await getHistory(mockAdminForExport, masterActor as any, {
  staff: 'support_export',
  fromDate: '1970-01-01T00:00:01.500Z',
  toDate: '1970-01-01T00:00:02.500Z',
});
check('getHistory with date range filters correctly',
  rangeHistory.items.length === 1 && rangeHistory.items[0].id === 'exp_2');

// Test unsettledOnly
const unsettledHistory = await getHistory(mockAdminForExport, masterActor as any, {
  staff: 'support_export',
  unsettledOnly: true,
});
check('getHistory with unsettledOnly filters activations after last full settlement (1500)',
  unsettledHistory.items.length === 2 && unsettledHistory.items.every((it: any) => it.id === 'exp_2' || it.id === 'exp_3'));

// Test master admin max limit is 1000
const limitHistory = await getHistory(mockAdminForExport, masterActor as any, {
  staff: 'support_export',
  limit: 500,
});
check('Master admin can query with limit up to 1000 (requested 500)', limitHistory.items.length === 3);

console.log(failed ? `\n${failed} check(s) failed.\n` : '\nAll subscription-management unit checks passed.\n');
process.exit(failed ? 1 : 0);
