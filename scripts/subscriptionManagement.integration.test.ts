import admin from 'firebase-admin';
import 'dotenv/config';
import {
  commitManagedActivation,
  createSubscriptionManagementHandlers,
  approveSubscriptionCancellation,
  getReports,
  listSubscriptionCancellationRequests,
  previewManagedSubscription,
  previewSubscriptionCancellation,
  rejectSubscriptionCancellation,
  requestSubscriptionCancellation,
  settleManagedBalance,
  voidManagedRecord,
  type SubscriptionActor,
} from '../shared/subscriptionManagement';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('Refusing to run: FIRESTORE_EMULATOR_HOST is not set.');
  process.exit(1);
}
// emulators:exec injects GCLOUD_PROJECT. Prefer it over the production project
// in .env or the Admin SDK silently talks to a second emulator namespace.
const projectId = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || 'mylectures-rules-test';
if (!admin.apps.length) admin.initializeApp({ projectId });
const db = admin.firestore();

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${!ok && detail ? ` -> ${detail}` : ''}`);
  if (!ok) failed++;
};
const rejects = async (fn: () => Promise<any>, code: string) => {
  try { await fn(); return false; } catch (error: any) { return error?.code === code; }
};
const invoke = async (handler: any, req: any) => {
  let status = 200;
  let body: any;
  const res = {
    status(value: number) { status = value; return this; },
    json(value: any) { body = value; return this; },
  };
  await handler({ body: {}, query: {}, params: {}, ...req }, res);
  return { status, body };
};
const clear = async (name: string) => {
  const snap = await db.collection(name).get();
  await Promise.all(snap.docs.map(doc => doc.ref.delete()));
};
for (const collection of ['users', 'subscriptions', 'subscriptionRecords', 'supportBalances', 'supportLedger', 'referenceCodes', 'subscriptionRequests', 'subscriptionCancellationRequests', 'fcm_tokens']) await clear(collection);

const master: SubscriptionActor = { uid: 'master@test.dev', email: 'master@test.dev', name: 'Master', role: 'master_admin', isMasterAdmin: true, staffDisabled: false, permissions: {} };
const support: SubscriptionActor = { uid: 'support@test.dev', email: 'support@test.dev', name: 'Support One', role: 'support', isMasterAdmin: false, staffDisabled: false, permissions: { canActivate: true } };
const cancellationSupport: SubscriptionActor = { ...support, permissions: { canActivate: true, canRequestCancellation: true } };
await db.collection('users').doc(support.uid).set({ email: support.email, name: support.name, role: 'support', permissions: support.permissions });
await db.collection('users').doc('student@test.dev').set({ email: 'student@test.dev', name: 'Stack Student', role: 'student', isSubscribed: false });

console.log('\n--- concurrent stacking and idempotency ---');
await Promise.all([
  commitManagedActivation(admin, master, { requestId: 'grant_req_001', studentEmail: 'student@test.dev', plan: 'monthly' }, 'grant'),
  commitManagedActivation(admin, master, { requestId: 'grant_req_002', studentEmail: 'student@test.dev', plan: 'seasonal' }, 'grant'),
]);
const stacked = (await db.collection('users').doc('student@test.dev').get()).data()!;
const days = Math.round((stacked.subscriptionEnd.toMillis() - Date.now()) / 86_400_000);
check('parallel grants serialize and stack 120 days', days >= 119 && days <= 120, String(days));
const replay = await commitManagedActivation(admin, master, { requestId: 'grant_req_001', studentEmail: 'student@test.dev', plan: 'monthly' }, 'grant');
check('same request and payload replays', replay.replayed === true);
check('same request with changed payload conflicts', await rejects(
  () => commitManagedActivation(admin, master, { requestId: 'grant_req_001', studentEmail: 'student@test.dev', plan: 'annual' }, 'grant'),
  'IDEMPOTENCY_CONFLICT',
));

console.log('\n--- Support accounting ---');
await db.collection('users').doc('paid@test.dev').set({ email: 'paid@test.dev', name: 'Paid Student', role: 'student', isSubscribed: false });
let preview = await previewManagedSubscription(admin, 'paid@test.dev', 'monthly');
check('unknown manual payment methods are rejected', await rejects(
  () => commitManagedActivation(admin, support, { requestId: 'activate_bad_method', studentEmail: 'paid@test.dev', plan: 'monthly', paymentMethod: 'card', previewStateToken: preview.stateToken }, 'manual'),
  'INVALID_PAYMENT_METHOD',
));
await commitManagedActivation(admin, support, { requestId: 'activate_001', studentEmail: 'paid@test.dev', plan: 'monthly', paymentMethod: 'cash', note: 'paid at desk', previewStateToken: preview.stateToken }, 'manual');
let balance = (await db.collection('supportBalances').doc(support.uid).get()).data()!;
check('activation credits full snapshotted price', balance.outstanding === 2000 && balance.totalCredited === 2000);
check('manual note is stored privately as the audit reason',
  (await db.collection('subscriptionRecords').doc('activate_001').get()).data()?.reason === 'paid at desk');
check('commission defaults to integer zero and is snapshotted without math', balance.commissionRate === 0
  && (await db.collection('supportLedger').doc('activate_001').get()).data()?.commissionRate === 0);
check('stale expected balance is rejected', await rejects(
  () => settleManagedBalance(admin, master, support.uid, { requestId: 'receive_stale', expectedOutstanding: 1999, amount: 500 }, 'receive'),
  'BALANCE_STALE',
));
await settleManagedBalance(admin, master, support.uid, { requestId: 'receive_001', expectedOutstanding: 2000, amount: 500 }, 'receive');
balance = (await db.collection('supportBalances').doc(support.uid).get()).data()!;
check('partial receipt reduces outstanding', balance.outstanding === 1500 && balance.totalReceived === 500);
const receiptReplay = await settleManagedBalance(admin, master, support.uid, { requestId: 'receive_001', expectedOutstanding: 2000, amount: 500 }, 'receive');
check('settlement replay returns its original result', receiptReplay.replayed === true && receiptReplay.balanceAfter === 1500);
check('settlement requestId conflicts on changed payload', await rejects(
  () => settleManagedBalance(admin, master, support.uid, { requestId: 'receive_001', expectedOutstanding: 2000, amount: 400 }, 'receive'),
  'IDEMPOTENCY_CONFLICT',
));
check('over-settlement rejected', await rejects(
  () => settleManagedBalance(admin, master, support.uid, { requestId: 'receive_over', expectedOutstanding: 1500, amount: 1501 }, 'receive'),
  'OVER_SETTLEMENT',
));
await settleManagedBalance(admin, master, support.uid, { requestId: 'receive_full', expectedOutstanding: 1500, full: true }, 'receive');
balance = (await db.collection('supportBalances').doc(support.uid).get()).data()!;
check('full receipt reaches exact zero', balance.outstanding === 0 && balance.totalReceived === 2000);

preview = await previewManagedSubscription(admin, 'paid@test.dev', 'seasonal');
await commitManagedActivation(admin, support, { requestId: 'activate_002', studentEmail: 'paid@test.dev', plan: 'seasonal', paymentMethod: 'superkey', previewStateToken: preview.stateToken }, 'manual');
await settleManagedBalance(admin, master, support.uid, { requestId: 'reset_001', expectedOutstanding: 5000 }, 'reset');
balance = (await db.collection('supportBalances').doc(support.uid).get()).data()!;
check('positive reset records reset, not received', balance.outstanding === 0 && balance.totalReset === 5000 && balance.totalReceived === 2000);
check('payout rejected at zero', await rejects(
  () => settleManagedBalance(admin, master, support.uid, { requestId: 'payout_zero', expectedOutstanding: 0 }, 'payout'),
  'PAYOUT_REQUIRES_NEGATIVE',
));

preview = await previewManagedSubscription(admin, 'paid@test.dev', 'monthly');
await commitManagedActivation(admin, support, { requestId: 'activate_003', studentEmail: 'paid@test.dev', plan: 'monthly', paymentMethod: 'other', previewStateToken: preview.stateToken }, 'manual');
check('payout rejects a positive balance', await rejects(
  () => settleManagedBalance(admin, master, support.uid, { requestId: 'payout_positive', expectedOutstanding: 2000 }, 'payout'),
  'PAYOUT_REQUIRES_NEGATIVE',
));
await settleManagedBalance(admin, master, support.uid, { requestId: 'receive_003', expectedOutstanding: 2000, full: true }, 'receive');
const beforeVoid = (await db.collection('users').doc('paid@test.dev').get()).data()!;
await voidManagedRecord(admin, master, 'activate_003', { requestId: 'void_req_003', reason: 'test reversal' });
balance = (await db.collection('supportBalances').doc(support.uid).get()).data()!;
const afterVoid = (await db.collection('users').doc('paid@test.dev').get()).data()!;
check('void reversal may create negative outstanding', balance.outstanding === -2000 && balance.totalReversed === 2000);
check('void restores the previous plan exactly', beforeVoid.subscriptionPlan === 'monthly' && afterVoid.subscriptionPlan === 'seasonal');
check('reset rejects the negative balance created by void', await rejects(
  () => settleManagedBalance(admin, master, support.uid, { requestId: 'reset_negative', expectedOutstanding: -2000 }, 'reset'),
  'RESET_REQUIRES_POSITIVE',
));
const payout = await settleManagedBalance(admin, master, support.uid, { requestId: 'payout_003', expectedOutstanding: -2000 }, 'payout');
balance = (await db.collection('supportBalances').doc(support.uid).get()).data()!;
check('full payout uses abs amount and reaches zero', payout.amount === 2000 && balance.outstanding === 0 && balance.totalPaidOut === 2000);

const finalBalance = (await db.collection('supportBalances').doc(support.uid).get()).data()!;
const ledger = await db.collection('supportLedger').where('supportUid', '==', support.uid).get();
const deltaSum = ledger.docs.reduce((sum, doc) => sum + doc.data().balanceDelta, 0);
check('balance equals sum of ledger deltas', finalBalance.outstanding === deltaSum, `${finalBalance.outstanding} != ${deltaSum}`);

console.log('\n--- Support cancellation review workflow ---');
await db.collection('users').doc('cancel-approve@test.dev').set({
  email: 'cancel-approve@test.dev', name: 'Cancel Approve', role: 'student', isSubscribed: false,
});
preview = await previewManagedSubscription(admin, 'cancel-approve@test.dev', 'monthly');
await commitManagedActivation(admin, cancellationSupport, {
  requestId: 'cancel_activation_approve', studentEmail: 'cancel-approve@test.dev', plan: 'monthly',
  paymentMethod: 'cash', previewStateToken: preview.stateToken,
}, 'manual');
const cancellationPreview = await previewSubscriptionCancellation(admin, cancellationSupport, 'cancel-approve@test.dev');
const balanceBeforeRequest = (await db.collection('supportBalances').doc(support.uid).get()).data()!;
const reportsBeforeRequest = await getReports(admin, master, 'today');
await requestSubscriptionCancellation(admin, cancellationSupport, {
  requestId: 'cancel_request_approve', studentEmail: 'cancel-approve@test.dev',
  previewStateToken: cancellationPreview.stateToken, reason: 'student asked',
});
const suspended = (await db.collection('users').doc('cancel-approve@test.dev').get()).data()!;
const balanceWhilePending = (await db.collection('supportBalances').doc(support.uid).get()).data()!;
const reportsWhilePending = await getReports(admin, master, 'today');
check('submission suspends access and stores the pending marker', suspended.isSubscribed === false
  && suspended.pendingCancellationRequestId === 'cancel_request_approve');
check('submission leaves Support balance and reports unchanged', balanceWhilePending.outstanding === balanceBeforeRequest.outstanding
  && reportsWhilePending.revenue.total === reportsBeforeRequest.revenue.total);
check('duplicate pending request is blocked', await rejects(
  () => requestSubscriptionCancellation(admin, cancellationSupport, {
    requestId: 'cancel_request_duplicate', studentEmail: 'cancel-approve@test.dev',
    previewStateToken: cancellationPreview.stateToken,
  }),
  'CANCELLATION_PENDING',
));
const ownRequests = await listSubscriptionCancellationRequests(admin, cancellationSupport, {});
check('Support list is scoped to its own request', ownRequests.requests.length === 1
  && ownRequests.requests[0].requesterUid === support.uid);
const approval = await approveSubscriptionCancellation(admin, master, 'cancel_request_approve', {
  decisionRequestId: 'cancel_decision_approve', note: 'verified',
});
const approvalReplay = await approveSubscriptionCancellation(admin, master, 'cancel_request_approve', {
  decisionRequestId: 'cancel_decision_approve', note: 'verified',
});
const approvedBalance = (await db.collection('supportBalances').doc(support.uid).get()).data()!;
const approvedReports = await getReports(admin, master, 'today');
const approvedActivation = (await db.collection('subscriptionRecords').doc('cancel_activation_approve').get()).data()!;
const approvedEntitlement = (await db.collection('subscriptions').doc('cancel_activation_approve').get()).data()!;
check('approval is idempotent', approval.status === 'approved' && approvalReplay.replayed === true);
check('approval reverses the full amount exactly once', approvedBalance.outstanding === balanceBeforeRequest.outstanding - 2000
  && (await db.collection('supportLedger').doc('cancel_decision_approve').get()).data()?.balanceDelta === -2000);
check('approval removes the sale from its original report period', approvedReports.revenue.total === reportsBeforeRequest.revenue.total - 2000);
check('approval removes the sale from yearly revenue too', approvedReports.yearlyRevenue === reportsBeforeRequest.yearlyRevenue - 2000);
check('approval cancels captured records and clears the marker', !!approvedActivation.cancelledBy
  && approvedEntitlement.status === 'cancelled'
  && !(await db.collection('users').doc('cancel-approve@test.dev').get()).data()?.pendingCancellationRequestId);

await db.collection('users').doc('cancel-reject@test.dev').set({
  email: 'cancel-reject@test.dev', name: 'Cancel Reject', role: 'student', isSubscribed: false,
});
preview = await previewManagedSubscription(admin, 'cancel-reject@test.dev', 'seasonal');
await commitManagedActivation(admin, cancellationSupport, {
  requestId: 'cancel_activation_reject', studentEmail: 'cancel-reject@test.dev', plan: 'seasonal',
  paymentMethod: 'cash', previewStateToken: preview.stateToken,
}, 'manual');
const rejectPreview = await previewSubscriptionCancellation(admin, cancellationSupport, 'cancel-reject@test.dev');
const originalRejectExpiry = rejectPreview.expiry;
const rejectBalanceBefore = (await db.collection('supportBalances').doc(support.uid).get()).data()!.outstanding;
await requestSubscriptionCancellation(admin, cancellationSupport, {
  requestId: 'cancel_request_reject', studentEmail: 'cancel-reject@test.dev', previewStateToken: rejectPreview.stateToken,
});
await rejectSubscriptionCancellation(admin, master, 'cancel_request_reject', {
  decisionRequestId: 'cancel_decision_reject', note: 'keep access',
});
const rejectedUser = (await db.collection('users').doc('cancel-reject@test.dev').get()).data()!;
check('rejection restores the exact original future expiry without review time', rejectedUser.isSubscribed === true
  && rejectedUser.subscriptionEnd.toDate().toISOString() === originalRejectExpiry);
check('rejection leaves finances unchanged', (await db.collection('supportBalances').doc(support.uid).get()).data()!.outstanding === rejectBalanceBefore
  && !(await db.collection('supportLedger').doc('cancel_decision_reject').get()).exists);

await db.collection('users').doc('cancel-expired@test.dev').set({
  email: 'cancel-expired@test.dev', name: 'Cancel Expired', role: 'student', isSubscribed: false,
});
preview = await previewManagedSubscription(admin, 'cancel-expired@test.dev', 'monthly');
await commitManagedActivation(admin, cancellationSupport, {
  requestId: 'cancel_activation_expired', studentEmail: 'cancel-expired@test.dev', plan: 'monthly',
  paymentMethod: 'cash', previewStateToken: preview.stateToken,
}, 'manual');
const expiredPreview = await previewSubscriptionCancellation(admin, cancellationSupport, 'cancel-expired@test.dev');
await requestSubscriptionCancellation(admin, cancellationSupport, {
  requestId: 'cancel_request_expired', studentEmail: 'cancel-expired@test.dev', previewStateToken: expiredPreview.stateToken,
});
const pastExpiry = admin.firestore.Timestamp.fromMillis(Date.now() - 1_000);
await db.collection('subscriptionCancellationRequests').doc('cancel_request_expired').update({
  originalExpiry: pastExpiry,
  'originalUserFields.subscriptionEnd.value': pastExpiry,
});
await rejectSubscriptionCancellation(admin, master, 'cancel_request_expired', {
  decisionRequestId: 'cancel_decision_expired',
});
check('rejection never reactivates an entitlement whose captured expiry has elapsed',
  (await db.collection('users').doc('cancel-expired@test.dev').get()).data()?.isSubscribed === false
  && (await db.collection('subscriptions').doc('cancel_activation_expired').get()).data()?.status === 'expired');

const otherSupport: SubscriptionActor = {
  uid: 'support-two-cancel@test.dev', email: 'support-two-cancel@test.dev', name: 'Support Two', role: 'support',
  isMasterAdmin: false, staffDisabled: false, permissions: { canRequestCancellation: true },
};
check('cross-Support cancellation preview is rejected', await rejects(
  () => previewSubscriptionCancellation(admin, otherSupport, 'cancel-reject@test.dev'),
  'NOT_OWN_ACTIVATION',
));
const futureExpiry = admin.firestore.Timestamp.fromMillis(Date.now() + 86_400_000);
await db.collection('users').doc('external-cancel@test.dev').set({
  email: 'external-cancel@test.dev', role: 'student', isSubscribed: true,
  subscriptionPlan: 'monthly', subscriptionEnd: futureExpiry,
});
await db.collection('subscriptions').doc('external_cancel_entitlement').set({
  userId: 'external-cancel@test.dev', status: 'active', plan: 'monthly', endDate: futureExpiry,
  paymentMethod: 'apple_iap', amount: 2000,
});
check('external-store entitlement cancellation is rejected', await rejects(
  () => previewSubscriptionCancellation(admin, cancellationSupport, 'external-cancel@test.dev'),
  'EXTERNAL_SUBSCRIPTION',
));
await db.collection('subscriptions').doc('cancel_reject_extra_entitlement').set({
  userId: 'cancel-reject@test.dev', status: 'active', plan: 'monthly', endDate: futureExpiry,
  paymentMethod: 'zaincash', amount: 2000,
});
check('multiple active entitlements require Master handling', await rejects(
  () => previewSubscriptionCancellation(admin, cancellationSupport, 'cancel-reject@test.dev'),
  'CANCELLATION_REQUIRES_MASTER',
));
await db.collection('subscriptions').doc('cancel_reject_extra_entitlement').delete();
const staleCancellationPreview = await previewSubscriptionCancellation(admin, cancellationSupport, 'cancel-reject@test.dev');
await db.collection('subscriptionRecords').doc('cancel_activation_reject').update({ amount: 5001 });
check('stale cancellation preview fails safely', await rejects(
  () => requestSubscriptionCancellation(admin, cancellationSupport, {
    requestId: 'cancel_request_stale', studentEmail: 'cancel-reject@test.dev',
    previewStateToken: staleCancellationPreview.stateToken,
  }),
  'PREVIEW_STALE',
));
await db.collection('subscriptionRecords').doc('cancel_activation_reject').update({ amount: 5000 });
check('optional reason is limited to 200 Unicode characters', await rejects(
  () => requestSubscriptionCancellation(admin, cancellationSupport, {
    requestId: 'cancel_reason_too_long', studentEmail: 'cancel-reject@test.dev',
    previewStateToken: rejectPreview.stateToken, reason: 'ع'.repeat(201),
  }),
  'TEXT_TOO_LONG',
));

console.log('\n--- stale preview, exact restoration, and void ordering ---');
await db.collection('users').doc('stale@test.dev').set({ email: 'stale@test.dev', name: 'Stale Preview', role: 'student', isSubscribed: false });
const stalePreview = await previewManagedSubscription(admin, 'stale@test.dev', 'monthly');
await db.collection('users').doc('stale@test.dev').update({ subscriptionPlan: 'seasonal' });
check('confirmation rejects a changed subscription state', await rejects(
  () => commitManagedActivation(admin, support, { requestId: 'activate_stale', studentEmail: 'stale@test.dev', plan: 'monthly', paymentMethod: 'cash', previewStateToken: stalePreview.stateToken }, 'manual'),
  'PREVIEW_STALE',
));

await db.collection('users').doc('absent@test.dev').set({ email: 'absent@test.dev', name: 'Absent Fields', role: 'student' });
await commitManagedActivation(admin, master, { requestId: 'grant_absent', studentEmail: 'absent@test.dev', plan: 'monthly' }, 'grant');
await voidManagedRecord(admin, master, 'grant_absent', { requestId: 'void_absent' });
const restoredAbsent = (await db.collection('users').doc('absent@test.dev').get()).data()!;
check('void deletes subscription fields that were previously absent',
  !Object.hasOwn(restoredAbsent, 'isSubscribed')
    && !Object.hasOwn(restoredAbsent, 'subscriptionEnd')
    && !Object.hasOwn(restoredAbsent, 'subscriptionPlan'));

await db.collection('users').doc('later-manual@test.dev').set({ email: 'later-manual@test.dev', name: 'Later Manual', role: 'student' });
await commitManagedActivation(admin, master, { requestId: 'grant_older', studentEmail: 'later-manual@test.dev', plan: 'monthly' }, 'grant');
await commitManagedActivation(admin, master, { requestId: 'grant_newer', studentEmail: 'later-manual@test.dev', plan: 'seasonal' }, 'grant');
check('an older audited event requires voiding later audited entries first', await rejects(
  () => voidManagedRecord(admin, master, 'grant_older', { requestId: 'void_older' }),
  'VOID_LATER_ENTRIES_FIRST',
));

await db.collection('users').doc('later-gateway@test.dev').set({ email: 'later-gateway@test.dev', name: 'Later Gateway', role: 'student' });
await commitManagedActivation(admin, master, { requestId: 'grant_before_gateway', studentEmail: 'later-gateway@test.dev', plan: 'monthly' }, 'grant');
const laterStamp = admin.firestore.Timestamp.fromMillis(Date.now() + 60_000);
await db.collection('subscriptions').doc('gateway_after_grant').set({
  userId: 'later-gateway@test.dev', userEmail: 'later-gateway@test.dev', userName: 'Later Gateway',
  plan: 'seasonal', status: 'active', startDate: laterStamp, endDate: laterStamp,
  paymentMethod: 'zaincash', amount: 5000, createdAt: laterStamp, updatedAt: laterStamp,
});
check('a later gateway/Apple event blocks void with a specific error', await rejects(
  () => voidManagedRecord(admin, master, 'grant_before_gateway', { requestId: 'void_before_gateway' }),
  'NON_VOIDABLE_LATER_EVENT',
));

console.log('\n--- notification failure isolation ---');
await db.collection('users').doc('notify@test.dev').set({ email: 'notify@test.dev', name: 'Notify Failure', role: 'student' });
await db.collection('fcm_tokens').doc('notify@test.dev').set({ token: 'failing-token' });
const messaging = admin.messaging() as any;
const originalSend = messaging.send;
messaging.send = async () => { throw new Error('injected messaging failure'); };
let notificationCommitSucceeded = false;
try {
  const notified = await commitManagedActivation(admin, master, { requestId: 'grant_notify_failure', studentEmail: 'notify@test.dev', plan: 'monthly' }, 'grant');
  notificationCommitSucceeded = notified.success === true;
} finally {
  messaging.send = originalSend;
}
check('FCM failure does not fail or roll back activation', notificationCommitSucceeded
  && (await db.collection('subscriptionRecords').doc('grant_notify_failure').get()).exists);

console.log('\n--- HTTP handler role matrix ---');
const handlers = createSubscriptionManagementHandlers({ admin });
const supportToken = { uid: support.uid, email: support.email, email_verified: true };
const setSupportPermissions = (permissions: Record<string, boolean>, staffDisabled = false) =>
  db.collection('users').doc(support.uid).update({ role: 'support', permissions, staffDisabled });

await setSupportPermissions({ canActivate: true });
check('canActivate independently permits preview',
  (await invoke(handlers.preview, { user: supportToken, query: { studentEmail: 'paid@test.dev', plan: 'monthly' } })).status === 200);
check('canActivate does not imply history',
  (await invoke(handlers.history, { user: supportToken })).status === 403);

await setSupportPermissions({ canViewHistory: true });
check('canViewHistory independently permits history',
  (await invoke(handlers.history, { user: supportToken })).status === 200);
check('canViewHistory does not imply activation',
  (await invoke(handlers.preview, { user: supportToken, query: { studentEmail: 'paid@test.dev', plan: 'monthly' } })).status === 403);

await setSupportPermissions({ canRequestCancellation: true });
check('canRequestCancellation independently permits own cancellation preview',
  (await invoke(handlers.previewCancellation, {
    user: supportToken, query: { studentEmail: 'cancel-reject@test.dev' },
  })).status === 200);
check('canRequestCancellation does not imply activation',
  (await invoke(handlers.preview, { user: supportToken, query: { studentEmail: 'cancel-reject@test.dev', plan: 'monthly' } })).status === 403);

await db.collection('users').doc('support-two@test.dev').set({ email: 'support-two@test.dev', role: 'support', permissions: {} });
await setSupportPermissions({ canViewOwnBalance: true });
check('canViewOwnBalance independently permits own balance',
  (await invoke(handlers.balances, { user: supportToken })).status === 200);
const otherBalance = await invoke(handlers.balances, { user: supportToken, query: { supportUid: 'support-two@test.dev' } });
check('Support cannot request another Support balance',
  otherBalance.status === 403 && otherBalance.body?.code === 'OWN_BALANCE_ONLY');

await setSupportPermissions({ canViewExpiring: true });
const tomorrow = admin.firestore.Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000);
await db.collection('users').doc('expiring@test.dev').set({
  email: 'expiring@test.dev', name: 'Expiring Student', role: 'student', isSubscribed: true,
  subscriptionPlan: 'monthly', subscriptionEnd: tomorrow,
});
const expiringResult = await invoke(handlers.expiring, { user: supportToken });
check('canViewExpiring independently returns days-left data', expiringResult.status === 200
  && expiringResult.body?.items?.some((item: any) => item.studentId === 'expiring@test.dev' && item.daysLeft === 1));

await setSupportPermissions({ manageSubscriptions: true });
check('legacy manageSubscriptions confers no new endpoint access',
  (await invoke(handlers.preview, { user: supportToken, query: { studentEmail: 'paid@test.dev', plan: 'monthly' } })).status === 403);

await setSupportPermissions({ canGrant: true, canSettle: true, canVoid: true, canViewAllBalances: true, canViewReports: true, canManageSupportStatus: true });
const masterOnlyAttempts = await Promise.all([
  invoke(handlers.grant, { user: supportToken, body: { requestId: 'support_grant_attempt', studentEmail: 'paid@test.dev', plan: 'monthly' } }),
  invoke(handlers.receive, { user: supportToken, params: { supportUid: support.uid }, body: { requestId: 'support_receive_attempt', expectedOutstanding: 0, full: true } }),
  invoke(handlers.void, { user: supportToken, params: { recordId: 'activate_001' }, body: { requestId: 'support_void_attempt' } }),
  invoke(handlers.balances, { user: supportToken }),
  invoke(handlers.reports, { user: supportToken, query: { period: 'today' } }),
  invoke(handlers.supportStatus, { user: supportToken, params: { uid: support.uid }, body: { requestId: 'support_status_attempt', disabled: true } }),
  invoke(handlers.removeSupport, { user: supportToken, params: { uid: support.uid }, body: { requestId: 'support_remove_attempt' } }),
]);
check('stored Master-only keys cannot authorize Support endpoints', masterOnlyAttempts.every(result => result.status === 403));

await setSupportPermissions({ canActivate: true, canRequestCancellation: true, canViewHistory: true, canViewOwnBalance: true, canViewExpiring: true }, true);
const disabledAttempt = await invoke(handlers.preview, { user: supportToken, query: { studentEmail: 'paid@test.dev', plan: 'monthly' } });
check('disabled Support is denied immediately despite stored grants',
  disabledAttempt.status === 403 && disabledAttempt.body?.code === 'STAFF_DISABLED');
const disabledCancellationAttempt = await invoke(handlers.previewCancellation, {
  user: supportToken, query: { studentEmail: 'cancel-reject@test.dev' },
});
check('disabled Support cannot request cancellation despite stored grant',
  disabledCancellationAttempt.status === 403 && disabledCancellationAttempt.body?.code === 'STAFF_DISABLED');

const masterToken = { uid: 'master-handler@test.dev', email: 'master-handler@test.dev', email_verified: true, role: 'master_admin' };
const disableInput = { requestId: 'master_status_001', disabled: true };
const disabled = await invoke(handlers.supportStatus, { user: masterToken, params: { uid: 'support-two@test.dev' }, body: disableInput });
const disabledReplay = await invoke(handlers.supportStatus, { user: masterToken, params: { uid: 'support-two@test.dev' }, body: disableInput });
check('Master disable is idempotent and keeps the Support role', disabled.status === 200
  && disabledReplay.body?.replayed === true
  && (await db.collection('users').doc('support-two@test.dev').get()).data()?.role === 'support');

await db.collection('supportBalances').doc('support-two@test.dev').set({ outstanding: -500 });
const nonZeroRemoval = await invoke(handlers.removeSupport, {
  user: masterToken, params: { uid: 'support-two@test.dev' }, body: { requestId: 'master_remove_nonzero' },
});
check('Support removal rejects a negative live balance',
  nonZeroRemoval.status === 409 && nonZeroRemoval.body?.code === 'NON_ZERO_SUPPORT_BALANCE');
const disabledPayout = await invoke(handlers.payout, {
  user: masterToken,
  params: { supportUid: 'support-two@test.dev' },
  body: { requestId: 'master_payout_disabled', expectedOutstanding: -500 },
});
check('disabled Support remains selectable for a full payout',
  disabledPayout.status === 200 && disabledPayout.body?.amount === 500 && disabledPayout.body?.balanceAfter === 0);
const removed = await invoke(handlers.removeSupport, {
  user: masterToken, params: { uid: 'support-two@test.dev' }, body: { requestId: 'master_remove_settled' },
});
check('settled Support can be removed through the checked endpoint', removed.status === 200
  && (await db.collection('users').doc('support-two@test.dev').get()).data()?.role === 'student');

console.log(failed ? `\n${failed} integration check(s) failed.\n` : '\nAll subscription-management integration checks passed.\n');
process.exit(failed ? 1 : 0);
