/**
 * Audited subscription management and Support accounting.
 *
 * This module is the single implementation mounted by both server.ts and
 * api/index.ts. The pre-existing subscriptions collection remains the public
 * entitlement/payment projection used by expiry jobs, gateway settlement and
 * Apple IAP. Private staff attribution and accounting live in separate
 * server-written collections.
 */
import crypto from 'crypto';
import { normalizeName, looksLikeLoginCode, loginCodeKeyFor } from './rosterIdentity.js';
import { isMasterAdminEmail } from './masterAdmins.js';
import { hasStaffCapability, type StaffCapability } from './staffCapabilities.js';
import {
  GRANT_PLANS,
  MANUAL_PAYMENT_METHODS,
  PAID_MANUAL_PLANS,
  type ManualPaymentMethod,
} from './subscriptionTypes.js';
import { PLAN_CONFIG } from './subscriptions.js';
import { serverCache } from './serverCache.js';

const REF_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const NOTE_LIMIT = 200;
const HISTORY_PAGE_SIZE = 25;
const EXPIRING_PAGE_SIZE = 25;
const USER_SUBSCRIPTION_FIELDS = ['isSubscribed', 'subscriptionEnd', 'subscriptionPlan'] as const;

type AnyMap = Record<string, any>;

export class SubscriptionManagementError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SubscriptionManagementError';
  }
}

export interface SubscriptionManagementDeps {
  admin: any;
}

export interface SubscriptionActor {
  uid: string;
  email: string;
  name: string;
  role: string;
  isMasterAdmin: boolean;
  staffDisabled: boolean;
  permissions: Record<string, boolean>;
}

function canonicalValue(value: any): any {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (typeof value.toMillis === 'function') return { $timestamp: value.toMillis() };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map(canonicalValue);
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
  );
}

export function canonicalJson(value: any): string {
  return JSON.stringify(canonicalValue(value));
}

export function requestPayloadHash(value: any): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function normalizeLimitedText(value: unknown, field = 'note'): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new SubscriptionManagementError(400, 'INVALID_TEXT', `${field} must be text`);
  }
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (Array.from(normalized).length > NOTE_LIMIT) {
    throw new SubscriptionManagementError(400, 'TEXT_TOO_LONG', `${field} must be at most ${NOTE_LIMIT} characters`);
  }
  return normalized;
}

export function normalizeStudentEmail(value: unknown): string {
  if (typeof value !== 'string') {
    throw new SubscriptionManagementError(400, 'INVALID_STUDENT_EMAIL', 'studentEmail is required');
  }
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new SubscriptionManagementError(400, 'INVALID_STUDENT_EMAIL', 'studentEmail is invalid');
  }
  return email;
}

export function validateRequestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(value)) {
    throw new SubscriptionManagementError(400, 'INVALID_REQUEST_ID', 'A client-generated requestId is required');
  }
  return value;
}

export function generateReferenceCode(prefix: 'ACT' | 'RCT' | 'RST' | 'VOID' | 'PAY' | 'MOD' | 'TRM'): string {
  let suffix = '';
  for (let i = 0; i < 6; i++) {
    suffix += REF_ALPHABET[crypto.randomInt(REF_ALPHABET.length)];
  }
  return `${prefix}-${suffix}`;
}

function asDate(value: any): Date | null {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function asMillis(value: any): number | null {
  const date = asDate(value);
  return date ? date.getTime() : null;
}

function isLaterEvent(candidate: any, candidateId: string, original: any, originalId: string): boolean {
  const candidateTime = asMillis(candidate) || 0;
  const originalTime = asMillis(original) || 0;
  return candidateTime > originalTime
    || (candidateTime === originalTime && candidateId.localeCompare(originalId) > 0);
}

export function computeSubscriptionExpiry(
  now: Date,
  currentExpiry: Date | null,
  isSubscribed: boolean,
  plan: string,
): { startsAt: Date; expiresAt: Date; extendedActive: boolean } {
  const config = PLAN_CONFIG[plan];
  if (!config) throw new SubscriptionManagementError(400, 'INVALID_PLAN', 'Invalid subscription plan');
  const extendedActive = isSubscribed && !!currentExpiry && currentExpiry.getTime() > now.getTime();
  const startsAt = now;
  const base = extendedActive ? currentExpiry! : now;
  return {
    startsAt,
    expiresAt: new Date(base.getTime() + config.days * 86_400_000),
    extendedActive,
  };
}

function stateShape(data: AnyMap): AnyMap {
  const shape: AnyMap = {};
  for (const field of USER_SUBSCRIPTION_FIELDS) {
    shape[field] = Object.prototype.hasOwnProperty.call(data, field)
      ? { present: true, value: field === 'subscriptionEnd' ? asMillis(data[field]) : data[field] }
      : { present: false };
  }
  return shape;
}

export function subscriptionStateToken(data: AnyMap): string {
  return requestPayloadHash(stateShape(data));
}

function previousFieldSnapshot(data: AnyMap): AnyMap {
  const snapshot: AnyMap = {};
  for (const field of USER_SUBSCRIPTION_FIELDS) {
    snapshot[field] = Object.prototype.hasOwnProperty.call(data, field)
      ? { present: true, value: data[field] }
      : { present: false };
  }
  return snapshot;
}

function serialize(value: any): any {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, serialize(item)]),
  );
}

function parsePositiveInteger(value: unknown, field = 'amount'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new SubscriptionManagementError(400, 'INVALID_AMOUNT', `${field} must be a positive integer`);
  }
  return value;
}

function parseExpectedOutstanding(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new SubscriptionManagementError(400, 'INVALID_EXPECTED_OUTSTANDING', 'expectedOutstanding must be an integer');
  }
  return value;
}

function decodeCursor(value: unknown): AnyMap {
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new SubscriptionManagementError(400, 'INVALID_CURSOR', 'Invalid cursor');
  }
}

function encodeCursor(value: AnyMap): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function baghdadParts(now: Date): { year: number; month: number; day: number } {
  const shifted = new Date(now.getTime() + 3 * 3_600_000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate() };
}

export function baghdadRange(
  period: 'today' | 'this_month' | 'last_month' | 'this_year',
  now = new Date(),
): { start: Date; end: Date } {
  const { year, month, day } = baghdadParts(now);
  const atBaghdadMidnight = (y: number, m: number, d: number) =>
    new Date(Date.UTC(y, m, d, -3, 0, 0, 0));
  if (period === 'today') {
    return { start: atBaghdadMidnight(year, month, day), end: atBaghdadMidnight(year, month, day + 1) };
  }
  if (period === 'this_month') {
    return { start: atBaghdadMidnight(year, month, 1), end: atBaghdadMidnight(year, month + 1, 1) };
  }
  if (period === 'last_month') {
    return { start: atBaghdadMidnight(year, month - 1, 1), end: atBaghdadMidnight(year, month, 1) };
  }
  return { start: atBaghdadMidnight(year, 0, 1), end: atBaghdadMidnight(year + 1, 0, 1) };
}

async function loadActor(admin: any, req: any): Promise<SubscriptionActor> {
  const token = req.user;
  if (!token) throw new SubscriptionManagementError(401, 'UNAUTHENTICATED', 'Authentication required');
  const email = String(token.email || '').trim().toLowerCase();
  const isMaster = isMasterAdminEmail(email) || token.role === 'master_admin';
  let snap = await admin.firestore().collection('users').doc(token.uid).get();
  if (!snap.exists && email) {
    snap = await admin.firestore().collection('users').doc(email).get();
  }
  const data = snap.data() || {};
  return {
    uid: token.uid,
    email,
    name: String(data.name || token.name || email || token.uid),
    role: isMaster ? 'master_admin' : String(data.role || ''),
    isMasterAdmin: isMaster,
    staffDisabled: data.staffDisabled === true,
    permissions: data.permissions || {},
  };
}

function requireCapability(actor: SubscriptionActor, capability: StaffCapability): void {
  if (!hasStaffCapability(actor, capability)) {
    if (actor.role === 'support' && actor.staffDisabled) {
      throw new SubscriptionManagementError(403, 'STAFF_DISABLED', 'Support account is disabled');
    }
    throw new SubscriptionManagementError(403, 'CAPABILITY_REQUIRED', 'Your account is not granted this capability');
  }
}

function requireMaster(actor: SubscriptionActor, capability: StaffCapability): void {
  if (!actor.isMasterAdmin || !hasStaffCapability(actor, capability)) {
    throw new SubscriptionManagementError(403, 'MASTER_ONLY', 'Master Admin only');
  }
}

function actorSnapshot(actor: SubscriptionActor): AnyMap {
  return { uid: actor.uid, email: actor.email, name: actor.name, role: actor.role };
}

function balanceDefaults(): AnyMap {
  return {
    outstanding: 0,
    totalCredited: 0,
    totalReceived: 0,
    totalReset: 0,
    totalReversed: 0,
    totalPaidOut: 0,
    commissionRate: 0,
  };
}

function withBalanceDefaults(data: AnyMap | undefined): AnyMap {
  const merged = { ...balanceDefaults(), ...(data || {}) };
  for (const field of ['outstanding', 'totalCredited', 'totalReceived', 'totalReset', 'totalReversed', 'totalPaidOut']) {
    if (!Number.isSafeInteger(merged[field])) merged[field] = 0;
  }
  if (!Number.isSafeInteger(merged.commissionRate)
      || merged.commissionRate < 0
      || merged.commissionRate > 100) merged.commissionRate = 0;
  return merged;
}

export async function withUniqueReference<T>(
  prefix: 'ACT' | 'RCT' | 'RST' | 'VOID' | 'PAY' | 'MOD' | 'TRM',
  work: (referenceCode: string) => Promise<T>,
  generate: (prefix: 'ACT' | 'RCT' | 'RST' | 'VOID' | 'PAY' | 'MOD' | 'TRM') => string = generateReferenceCode,
): Promise<T> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const referenceCode = generate(prefix);
    try {
      return await work(referenceCode);
    } catch (error: any) {
      if (error?.code !== 'REFERENCE_COLLISION') throw error;
    }
  }
  throw new SubscriptionManagementError(503, 'REFERENCE_EXHAUSTED', 'Could not allocate a reference code');
}

function collision(): never {
  const error: any = new Error('Reference collision');
  error.code = 'REFERENCE_COLLISION';
  throw error;
}

function idempotencyResult(existing: any, hash: string): AnyMap {
  const data = existing.data();
  if (data.payloadHash !== hash) {
    throw new SubscriptionManagementError(409, 'IDEMPOTENCY_CONFLICT', 'requestId was already used with different data');
  }
  return { ...(data.result || {}), replayed: true };
}

async function sendActivationNotification(admin: any, userId: string, plan: string, newExpiry: string): Promise<void> {
  try {
    const tokenSnap = await admin.firestore().collection('fcm_tokens').doc(userId).get();
    const token = tokenSnap.data()?.token;
    if (!token) return;
    await admin.messaging().send({
      token,
      notification: {
        title: 'Subscription activated',
        body: `${plan} · ${newExpiry}`,
      },
      data: { plan, newExpiry },
    });
  } catch (error) {
    console.error('Subscription activation FCM failed:', error);
  }
}

export async function previewManagedSubscription(admin: any, email: string, plan: string): Promise<AnyMap> {
  if (!(PAID_MANUAL_PLANS as readonly string[]).includes(plan) && !(GRANT_PLANS as readonly string[]).includes(plan as any)) {
    throw new SubscriptionManagementError(400, 'INVALID_PLAN', 'Invalid subscription plan');
  }
  const target = await resolveStudent(admin, email);
  const snap = target.snap;
  const data = snap.data() || {};
  const now = new Date();
  const expiry = computeSubscriptionExpiry(now, asDate(data.subscriptionEnd), data.isSubscribed === true, plan);
  return {
    studentId: snap.id,
    studentEmail: data.email || snap.id,
    studentName: data.name || data.originalName || email,
    status: data.isSubscribed === true ? 'active' : 'inactive',
    isSubscribed: data.isSubscribed === true,
    currentPlan: data.subscriptionPlan || null,
    currentExpiry: asDate(data.subscriptionEnd)?.toISOString() || null,
    plan,
    price: PLAN_CONFIG[plan].price,
    newExpiry: expiry.expiresAt.toISOString(),
    activeWarning: expiry.extendedActive,
    stateToken: subscriptionStateToken(data),
  };
}

export async function commitManagedActivation(
  admin: any,
  actor: SubscriptionActor,
  input: AnyMap,
  mode: 'manual' | 'grant',
): Promise<AnyMap> {
  const db = admin.firestore();
  const requestId = validateRequestId(input.requestId);
  const studentEmail = normalizeStudentEmail(input.studentEmail || input.userId);
  const plan = String(input.plan || '');
  const reason = normalizeLimitedText(input.reason ?? input.note ?? input.notes, mode === 'grant' ? 'reason' : 'note');
  const paymentMethod = input.paymentMethod as ManualPaymentMethod | undefined;

  if (mode === 'manual') {
    requireCapability(actor, 'canActivate');
    if (!(PAID_MANUAL_PLANS as readonly string[]).includes(plan)) {
      throw new SubscriptionManagementError(400, 'INVALID_PLAN', 'Invalid paid activation plan');
    }
    if (!(MANUAL_PAYMENT_METHODS as readonly unknown[]).includes(paymentMethod)) {
      throw new SubscriptionManagementError(400, 'INVALID_PAYMENT_METHOD', 'A valid manual payment method is required');
    }
    if (typeof input.previewStateToken !== 'string' || !/^[a-f0-9]{64}$/.test(input.previewStateToken)) {
      throw new SubscriptionManagementError(400, 'PREVIEW_REQUIRED', 'A current preview is required');
    }
  } else {
    requireMaster(actor, 'canGrant');
    if (!(GRANT_PLANS as readonly string[]).includes(plan)) {
      throw new SubscriptionManagementError(400, 'INVALID_PLAN', 'Invalid grant plan');
    }
  }

  const normalizedPayload = {
    action: mode,
    studentEmail,
    plan,
    ...(mode === 'manual' ? { paymentMethod } : {}),
    ...(reason ? { reason } : {}),
    previewStateToken: String(input.previewStateToken || ''),
  };
  const payloadHash = requestPayloadHash(normalizedPayload);
  const prefix = 'ACT' as const;

  const target = await resolveStudent(admin, studentEmail);
  const targetUserRef = target.ref;
  const targetUserId = target.snap.id;

  const result = await withUniqueReference(prefix, async (referenceCode) => {
    return db.runTransaction(async (tx: any) => {
      const recordRef = db.collection('subscriptionRecords').doc(requestId);
      const entitlementRef = db.collection('subscriptions').doc(requestId);
      const userRef = targetUserRef;
      const referenceRef = db.collection('referenceCodes').doc(referenceCode);
      const balanceRef = db.collection('supportBalances').doc(actor.uid);
      const ledgerRef = db.collection('supportLedger').doc(requestId);
      const activeQuery = db.collection('subscriptions')
        .where('userId', '==', targetUserId)
        .where('status', '==', 'active');

      const existing = await tx.get(recordRef);
      if (existing.exists) return idempotencyResult(existing, payloadHash);
      const userSnap = await tx.get(userRef);
      const activeSnap = await tx.get(activeQuery);
      const balanceSnap = mode === 'manual' && !actor.isMasterAdmin ? await tx.get(balanceRef) : null;
      const referenceSnap = await tx.get(referenceRef);
      if (referenceSnap.exists) collision();
      if (!userSnap.exists) throw new SubscriptionManagementError(404, 'STUDENT_NOT_FOUND', 'Student not found');

      const userData = userSnap.data() || {};
      const resolvedStudentEmail = userData.email || studentEmail;
      const currentStateToken = subscriptionStateToken(userData);
      if (input.previewStateToken && input.previewStateToken !== currentStateToken) {
        throw new SubscriptionManagementError(409, 'PREVIEW_STALE', 'Subscription state changed; refresh the preview');
      }

      const nowDate = new Date();
      const expiry = computeSubscriptionExpiry(
        nowDate,
        asDate(userData.subscriptionEnd),
        userData.isSubscribed === true,
        plan,
      );
      const now = admin.firestore.Timestamp.fromDate(nowDate);
      const endDate = admin.firestore.Timestamp.fromDate(expiry.expiresAt);
      const amount = mode === 'grant' ? 0 : PLAN_CONFIG[plan].price;
      const resultValue = {
        success: true,
        recordId: requestId,
        subscriptionId: requestId,
        referenceCode,
        newExpiry: expiry.expiresAt.toISOString(),
      };

      for (const active of activeSnap.docs) {
        tx.update(active.ref, {
          status: 'inactive',
          updatedAt: now,
          notes: `Replaced by subscription ${requestId}`,
        });
      }

      const studentName = String(userData.name || userData.originalName || resolvedStudentEmail);
      tx.create(recordRef, {
        requestId,
        payloadHash,
        referenceCode,
        referenceCodeNormalized: referenceCode.toUpperCase(),
        studentId: targetUserId,
        studentEmail: resolvedStudentEmail,
        studentName,
        type: mode === 'grant' ? 'grant' : 'activation',
        source: mode === 'grant' ? 'grant' : 'manual',
        plan,
        priceSnapshot: PLAN_CONFIG[plan].price,
        amount,
        ...(mode === 'manual' ? { paymentMethod } : {}),
        ...(reason ? { reason } : {}),
        actorUid: actor.uid,
        actor: actorSnapshot(actor),
        startDate: now,
        endDate,
        createdAt: now,
        entitlementId: requestId,
        previousUserFields: previousFieldSnapshot(userData),
        result: resultValue,
      });
      tx.create(entitlementRef, {
        userId: targetUserId,
        userEmail: resolvedStudentEmail,
        userName: studentName,
        plan,
        status: 'active',
        startDate: now,
        endDate,
        paymentMethod: mode === 'grant' ? 'admin_grant' : paymentMethod,
        amount,
        createdAt: now,
        updatedAt: now,
        auditedRecordId: requestId,
      });
      tx.update(userRef, { isSubscribed: true, subscriptionEnd: endDate, subscriptionPlan: plan });
      tx.create(referenceRef, { referenceCode, targetCollection: 'subscriptionRecords', targetId: requestId, createdAt: now });

      if (mode === 'manual' && !actor.isMasterAdmin) {
        const balance = withBalanceDefaults(balanceSnap?.data());
        const nextOutstanding = balance.outstanding + amount;
        tx.set(balanceRef, {
          ...balance,
          supportUid: actor.uid,
          supportEmail: actor.email,
          supportName: actor.name,
          outstanding: nextOutstanding,
          totalCredited: balance.totalCredited + amount,
          createdAt: balance.createdAt || now,
          updatedAt: now,
        });
        tx.create(ledgerRef, {
          requestId,
          payloadHash,
          referenceCode,
          type: 'credit',
          amount,
          balanceDelta: amount,
          balanceAfter: nextOutstanding,
          supportUid: actor.uid,
          actor: actorSnapshot(actor),
          recordId: requestId,
          commissionRate: balance.commissionRate,
          createdAt: now,
          result: resultValue,
        });
      }
      return { ...resultValue, replayed: false };
    });
  });

  if (!result.replayed) {
    const resolvedStudentEmail = target.snap.data()?.email || studentEmail;
    await sendActivationNotification(admin, resolvedStudentEmail, plan, result.newExpiry);
  }
  return result;
}

export async function requestSupportGrant(
  admin: any,
  actor: SubscriptionActor,
  input: AnyMap,
): Promise<AnyMap> {
  requireCapability(actor, 'canActivate');
  const db = admin.firestore();
  const requestId = validateRequestId(input.requestId);
  const studentEmail = normalizeStudentEmail(input.studentEmail || input.userId);
  const plan = String(input.plan || '');
  const reason = normalizeLimitedText(input.reason ?? input.note ?? input.notes, 'note');

  if (!(GRANT_PLANS as readonly string[]).includes(plan as any)) {
    throw new SubscriptionManagementError(400, 'INVALID_PLAN', 'Invalid grant plan');
  }

  const target = await resolveStudent(admin, studentEmail);
  const userSnap = target.snap;
  const userData = userSnap.data() || {};
  const resolvedStudentEmail = userData.email || studentEmail;
  const resolvedStudentId = userSnap.id;
  const studentName = userData.name || userData.originalName || resolvedStudentEmail;

  const existingSub = await db.collection('subscriptions').doc(requestId).get();
  if (existingSub.exists) {
    return { success: true, id: requestId, replayed: true };
  }

  const now = admin.firestore.FieldValue?.serverTimestamp
    ? admin.firestore.FieldValue.serverTimestamp()
    : new Date();
  const subscriptionDoc = {
    userId: resolvedStudentId,
    userEmail: resolvedStudentEmail,
    userName: studentName,
    plan,
    amount: 0,
    status: 'pending',
    paymentMethod: 'grant',
    ...(reason ? { notes: reason } : {}),
    requestedBy: {
      uid: actor.uid,
      email: actor.email,
      name: actor.name,
      role: actor.role,
    },
    createdAt: now,
    updatedAt: now,
  };

  await db.collection('subscriptions').doc(requestId).set(subscriptionDoc);

  return { success: true, id: requestId, replayed: false };
}

export async function settleManagedBalance(
  admin: any,
  actor: SubscriptionActor,
  supportUid: string,
  input: AnyMap,
  action: 'receive' | 'reset' | 'payout',
): Promise<AnyMap> {
  requireMaster(actor, 'canSettle');
  const requestId = validateRequestId(input.requestId);
  const expectedOutstanding = parseExpectedOutstanding(input.expectedOutstanding);
  const note = normalizeLimitedText(input.note);
  const requestedAmount = action === 'receive' && input.full !== true
    ? parsePositiveInteger(input.amount)
    : undefined;
  const payload = { action, supportUid, expectedOutstanding, ...(requestedAmount ? { amount: requestedAmount } : {}), full: input.full === true, ...(note ? { note } : {}) };
  const payloadHash = requestPayloadHash(payload);
  const prefix = action === 'receive' ? 'RCT' : action === 'reset' ? 'RST' : 'PAY';
  const db = admin.firestore();

  return withUniqueReference(prefix, async (referenceCode) => db.runTransaction(async (tx: any) => {
    const balanceRef = db.collection('supportBalances').doc(supportUid);
    const ledgerRef = db.collection('supportLedger').doc(requestId);
    const supportRef = db.collection('users').doc(supportUid);
    const referenceRef = db.collection('referenceCodes').doc(referenceCode);
    const existing = await tx.get(ledgerRef);
    if (existing.exists) return idempotencyResult(existing, payloadHash);
    const balanceSnap = await tx.get(balanceRef);
    const supportSnap = await tx.get(supportRef);
    const referenceSnap = await tx.get(referenceRef);
    if (referenceSnap.exists) collision();
    if (!supportSnap.exists || supportSnap.data()?.role !== 'support') {
      throw new SubscriptionManagementError(404, 'SUPPORT_NOT_FOUND', 'Support account not found');
    }
    const balance = withBalanceDefaults(balanceSnap.data());
    if (balance.outstanding !== expectedOutstanding) {
      throw new SubscriptionManagementError(409, 'BALANCE_STALE', 'Balance changed; refresh and confirm again');
    }

    let amount: number;
    let balanceDelta: number;
    let type: string;
    const totals: AnyMap = {};
    if (action === 'receive') {
      if (balance.outstanding <= 0) throw new SubscriptionManagementError(409, 'NOTHING_TO_RECEIVE', 'Outstanding balance is not positive');
      amount = input.full === true ? balance.outstanding : requestedAmount!;
      if (amount > balance.outstanding) throw new SubscriptionManagementError(400, 'OVER_SETTLEMENT', 'Amount exceeds outstanding balance');
      balanceDelta = -amount;
      type = amount === balance.outstanding ? 'receive_full' : 'receive_partial';
      totals.totalReceived = balance.totalReceived + amount;
    } else if (action === 'reset') {
      if (balance.outstanding <= 0) throw new SubscriptionManagementError(409, 'RESET_REQUIRES_POSITIVE', 'Only a positive balance can be reset');
      amount = balance.outstanding;
      balanceDelta = -amount;
      type = 'reset';
      totals.totalReset = balance.totalReset + amount;
    } else {
      if (balance.outstanding >= 0) throw new SubscriptionManagementError(409, 'PAYOUT_REQUIRES_NEGATIVE', 'Payout requires a negative balance');
      amount = Math.abs(balance.outstanding);
      balanceDelta = amount;
      type = 'payout';
      totals.totalPaidOut = balance.totalPaidOut + amount;
    }
    const balanceAfter = balance.outstanding + balanceDelta;
    const now = admin.firestore.Timestamp.now();
    const result = { success: true, referenceCode, amount, balanceAfter };
    tx.set(balanceRef, {
      ...balance,
      ...totals,
      supportUid,
      outstanding: balanceAfter,
      createdAt: balance.createdAt || now,
      updatedAt: now,
    }, { merge: true });
    tx.create(ledgerRef, {
      requestId,
      payloadHash,
      referenceCode,
      type,
      amount,
      balanceDelta,
      balanceAfter,
      supportUid,
      actor: actorSnapshot(actor),
      ...(note ? { note } : {}),
      commissionRate: balance.commissionRate,
      createdAt: now,
      result,
    });
    tx.create(referenceRef, { referenceCode, targetCollection: 'supportLedger', targetId: requestId, createdAt: now });
    return { ...result, replayed: false };
  }));
}

function restorePatch(snapshot: AnyMap, FieldValue: any): AnyMap {
  const patch: AnyMap = {};
  for (const field of USER_SUBSCRIPTION_FIELDS) {
    const entry = snapshot?.[field];
    patch[field] = entry?.present === true ? entry.value : FieldValue.delete();
  }
  return patch;
}

export async function voidManagedRecord(admin: any, actor: SubscriptionActor, recordId: string, input: AnyMap): Promise<AnyMap> {
  requireMaster(actor, 'canVoid');
  const requestId = validateRequestId(input.requestId);
  const reason = normalizeLimitedText(input.reason, 'reason');
  const payloadHash = requestPayloadHash({ action: 'void', recordId, ...(reason ? { reason } : {}) });
  const db = admin.firestore();

  return withUniqueReference('VOID', async (referenceCode) => db.runTransaction(async (tx: any) => {
    const originalRef = db.collection('subscriptionRecords').doc(recordId);
    const voidRef = db.collection('subscriptionRecords').doc(requestId);
    const originalSnap = await tx.get(originalRef);
    const replaySnap = await tx.get(voidRef);
    if (replaySnap.exists) return idempotencyResult(replaySnap, payloadHash);
    if (!originalSnap.exists) throw new SubscriptionManagementError(404, 'RECORD_NOT_FOUND', 'Subscription record not found');
    const original = originalSnap.data();
    if (!['activation', 'grant'].includes(original.type)) throw new SubscriptionManagementError(400, 'NOT_VOIDABLE', 'Only activation or grant records can be voided');
    if (original.voidedBy) throw new SubscriptionManagementError(409, 'ALREADY_VOIDED', 'Record has already been voided');

    const userRef = db.collection('users').doc(original.studentId);
    const entitlementRef = db.collection('subscriptions').doc(original.entitlementId);
    const referenceRef = db.collection('referenceCodes').doc(referenceCode);
    const balanceRef = original.type === 'activation' && original.actor?.role === 'support'
      ? db.collection('supportBalances').doc(original.actorUid)
      : null;
    const ledgerRef = db.collection('supportLedger').doc(requestId);
    const latestOperationalQuery = db.collection('subscriptions')
      .where('userId', '==', original.studentId)
      .orderBy('createdAt', 'desc')
      .orderBy(admin.firestore.FieldPath.documentId(), 'desc');
    const latestPrivateQuery = db.collection('subscriptionRecords')
      .where('studentId', '==', original.studentId)
      .orderBy('createdAt', 'desc')
      .orderBy(admin.firestore.FieldPath.documentId(), 'desc');

    const userSnap = await tx.get(userRef);
    const entitlementSnap = await tx.get(entitlementRef);
    const latestOperational = await tx.get(latestOperationalQuery);
    const latestPrivate = await tx.get(latestPrivateQuery);
    const balanceSnap = balanceRef ? await tx.get(balanceRef) : null;
    const referenceSnap = await tx.get(referenceRef);
    if (referenceSnap.exists) collision();
    if (!userSnap.exists || !entitlementSnap.exists) throw new SubscriptionManagementError(409, 'ENTITLEMENT_MISSING', 'The entitlement can no longer be restored safely');

    const laterPrivate = latestPrivate.docs.find((doc: any) => {
      if (doc.id === recordId) return false;
      const data = doc.data();
      return ['activation', 'grant'].includes(data.type)
        && !data.voidedBy
        && isLaterEvent(data.createdAt, doc.id, original.createdAt, recordId);
    });
    if (laterPrivate) throw new SubscriptionManagementError(409, 'VOID_LATER_ENTRIES_FIRST', 'Void later manual entries first');

    const latestOp = latestOperational.docs.find((doc: any) => ['active', 'inactive'].includes(doc.data().status));
    if (latestOp && latestOp.id !== original.entitlementId
        && isLaterEvent(latestOp.data().createdAt, latestOp.id, original.createdAt, original.entitlementId)) {
      if (latestOp.data().auditedRecordId) {
        throw new SubscriptionManagementError(409, 'VOID_LATER_ENTRIES_FIRST', 'Void later manual entries first');
      }
      throw new SubscriptionManagementError(409, 'NON_VOIDABLE_LATER_EVENT', 'A later gateway or Apple entitlement prevents this void');
    }

    const now = admin.firestore.Timestamp.now();
    const result = { success: true, recordId: requestId, voidsRecordId: recordId, referenceCode };
    tx.update(userRef, restorePatch(original.previousUserFields, admin.firestore.FieldValue));
    tx.update(entitlementRef, { status: 'cancelled', updatedAt: now, voidedBy: requestId });
    tx.update(originalRef, { voidedBy: { recordId: requestId, referenceCode, actor: actorSnapshot(actor), createdAt: now } });
    tx.create(voidRef, {
      requestId,
      payloadHash,
      referenceCode,
      referenceCodeNormalized: referenceCode.toUpperCase(),
      studentId: original.studentId,
      studentEmail: original.studentEmail,
      studentName: original.studentName,
      type: 'void',
      source: original.source,
      plan: original.plan,
      ...(Number.isSafeInteger(original.priceSnapshot) ? { priceSnapshot: original.priceSnapshot } : {}),
      amount: original.amount,
      actorUid: actor.uid,
      actor: actorSnapshot(actor),
      voidsRecordId: recordId,
      ...(reason ? { reason } : {}),
      createdAt: now,
      result,
    });
    tx.create(referenceRef, { referenceCode, targetCollection: 'subscriptionRecords', targetId: requestId, createdAt: now });

    if (balanceRef) {
      const balance = withBalanceDefaults(balanceSnap?.data());
      const amount = original.amount;
      const balanceAfter = balance.outstanding - amount;
      tx.set(balanceRef, {
        ...balance,
        outstanding: balanceAfter,
        totalReversed: balance.totalReversed + amount,
        updatedAt: now,
      }, { merge: true });
      tx.create(ledgerRef, {
        requestId,
        payloadHash,
        referenceCode,
        type: 'void_reversal',
        amount,
        balanceDelta: -amount,
        balanceAfter,
        supportUid: original.actorUid,
        actor: actorSnapshot(actor),
        recordId,
        commissionRate: balance.commissionRate,
        createdAt: now,
        result,
      });
    }
    return { ...result, replayed: false };
  }));
}

function historyRow(doc: any, source: 'private' | 'legacy'): AnyMap {
  const data = doc.data();
  if (source === 'private') {
    return serialize({ id: doc.id, source, ...data });
  }
  return serialize({
    id: doc.id,
    source: 'legacy',
    studentId: data.userId,
    studentEmail: data.userEmail,
    studentName: data.userName,
    type: data.status === 'cancelled' ? 'cancelled' : 'legacy',
    plan: data.plan,
    amount: data.amount,
    paymentMethod: data.paymentMethod,
    startDate: data.startDate,
    endDate: data.endDate,
    createdAt: data.createdAt,
    status: data.status,
    referenceCode: '-',
    reason: '-',
    actor: { name: '-', email: '-', uid: '-' },
  });
}

function cursorPoint(doc: any): AnyMap {
  return { createdAt: asMillis(doc.data().createdAt) || 0, id: doc.id };
}

function applyCursor(query: any, cursor: AnyMap, Timestamp: any): any {
  return cursor?.createdAt && cursor?.id
    ? query.startAfter(Timestamp.fromMillis(cursor.createdAt), cursor.id)
    : query;
}

async function getHistory(admin: any, actor: SubscriptionActor, queryInput: AnyMap): Promise<AnyMap> {
  requireCapability(actor, 'canViewHistory');
  const db = admin.firestore();
  const limit = Math.min(50, Math.max(1, Number(queryInput.limit) || HISTORY_PAGE_SIZE));
  const cursor = decodeCursor(queryInput.cursor);
  const student = typeof queryInput.student === 'string' && queryInput.student.trim()
    ? queryInput.student.trim().toLowerCase() : '';
  const staff = typeof queryInput.staff === 'string' && queryInput.staff.trim()
    ? queryInput.staff.trim() : '';
  const reference = typeof queryInput.reference === 'string' && queryInput.reference.trim()
    ? queryInput.reference.trim().toUpperCase() : '';

  let privateQuery: any = db.collection('subscriptionRecords');
  if (student) privateQuery = privateQuery.where('studentId', '==', student);
  if (staff) privateQuery = privateQuery.where('actorUid', '==', staff);
  if (reference) privateQuery = privateQuery.where('referenceCodeNormalized', '==', reference);
  privateQuery = privateQuery.orderBy('createdAt', 'desc')
    .orderBy(admin.firestore.FieldPath.documentId(), 'desc');
  privateQuery = applyCursor(privateQuery, cursor.private, admin.firestore.Timestamp).limit(limit + 1);

  let legacyQuery: any = db.collection('subscriptions');
  if (student) legacyQuery = legacyQuery.where('userId', '==', student);
  legacyQuery = legacyQuery.orderBy('createdAt', 'desc')
    .orderBy(admin.firestore.FieldPath.documentId(), 'desc');
  legacyQuery = applyCursor(legacyQuery, cursor.legacy, admin.firestore.Timestamp).limit(limit + 1);

  const [privateSnap, legacySnap] = await Promise.all([
    privateQuery.get(),
    staff || reference ? Promise.resolve({ docs: [] }) : legacyQuery.get(),
  ]);
  const privateDocs = privateSnap.docs;
  const legacyDocs = legacySnap.docs.filter((doc: any) => !doc.data().auditedRecordId);
  const merged = [
    ...privateDocs.map((doc: any) => ({ doc, source: 'private' as const })),
    ...legacyDocs.map((doc: any) => ({ doc, source: 'legacy' as const })),
  ].sort((a, b) => {
    const time = (asMillis(b.doc.data().createdAt) || 0) - (asMillis(a.doc.data().createdAt) || 0);
    return time || b.doc.id.localeCompare(a.doc.id);
  }).slice(0, limit);

  const nextCursor: AnyMap = { ...cursor };
  for (const item of merged) nextCursor[item.source] = cursorPoint(item.doc);
  const hasMore = privateDocs.length > merged.filter(x => x.source === 'private').length
    || legacyDocs.length > merged.filter(x => x.source === 'legacy').length;
  return {
    items: merged.map(item => historyRow(item.doc, item.source)),
    nextCursor: hasMore ? encodeCursor(nextCursor) : null,
  };
}

async function getBalances(admin: any, actor: SubscriptionActor, queryInput: AnyMap): Promise<AnyMap> {
  const db = admin.firestore();
  let supportUid = typeof queryInput.supportUid === 'string' ? queryInput.supportUid : '';
  if (actor.isMasterAdmin) {
    requireMaster(actor, 'canViewAllBalances');
  } else {
    requireCapability(actor, 'canViewOwnBalance');
    if (supportUid && supportUid !== actor.uid) {
      throw new SubscriptionManagementError(403, 'OWN_BALANCE_ONLY', 'Support can only view its own balance');
    }
    supportUid = actor.uid;
  }

  if (supportUid) {
    const [balanceSnap, ledgerSnap, userSnap] = await Promise.all([
      db.collection('supportBalances').doc(supportUid).get(),
      db.collection('supportLedger').where('supportUid', '==', supportUid).orderBy('createdAt', 'desc').limit(50).get(),
      db.collection('users').doc(supportUid).get(),
    ]);
    return {
      balance: serialize({ supportUid, ...withBalanceDefaults(balanceSnap.data()), staffDisabled: userSnap.data()?.staffDisabled === true }),
      ledger: ledgerSnap.docs.map((doc: any) => serialize({ id: doc.id, ...doc.data() })),
    };
  }

  const [supports, balanceSnap] = await Promise.all([
    db.collection('users').where('role', '==', 'support').get(),
    db.collection('supportBalances').get(),
  ]);
  const userById = new Map(supports.docs.map((doc: any) => [doc.id, doc.data()]));
  const balanceById = new Map(balanceSnap.docs.map((doc: any) => [doc.id, doc.data()]));
  const supportIds = new Set([...userById.keys(), ...balanceById.keys()]);
  const rows = [...supportIds].map((supportUid) => {
    const user: AnyMap = userById.get(supportUid) || {};
    const stored: AnyMap = balanceById.get(supportUid) || {};
    return serialize({
      supportUid,
      supportEmail: user.email || stored.supportEmail || supportUid,
      supportName: user.name || stored.supportName || user.email || stored.supportEmail || supportUid,
      staffDisabled: user.staffDisabled === true,
      removed: !userById.has(supportUid),
      ...withBalanceDefaults(stored),
    });
  });
  return { balances: rows };
}

export async function getReports(admin: any, actor: SubscriptionActor, period: string): Promise<AnyMap> {
  requireMaster(actor, 'canViewReports');
  if (!['today', 'this_month', 'last_month', 'this_year'].includes(period)) {
    throw new SubscriptionManagementError(400, 'INVALID_PERIOD', 'Invalid report period');
  }
  const db = admin.firestore();
  const range = baghdadRange(period as any);
  const start = admin.firestore.Timestamp.fromDate(range.start);
  const end = admin.firestore.Timestamp.fromDate(range.end);

  const yearRange = baghdadRange('this_year');
  const yearStart = admin.firestore.Timestamp.fromDate(yearRange.start);
  const yearEnd = admin.firestore.Timestamp.fromDate(yearRange.end);

  const queries: Promise<any>[] = [
    db.collection('subscriptionRecords').where('createdAt', '>=', start).where('createdAt', '<', end).get(),
    db.collection('subscriptions').where('createdAt', '>=', start).where('createdAt', '<', end).get(),
    getBalances(admin, actor, {}),
  ];

  const needSeparateYearQuery = period !== 'this_year';
  if (needSeparateYearQuery) {
    queries.push(
      db.collection('subscriptionRecords').where('createdAt', '>=', yearStart).where('createdAt', '<', yearEnd).get(),
      db.collection('subscriptions').where('createdAt', '>=', yearStart).where('createdAt', '<', yearEnd).get(),
    );
  }

  const results = await Promise.all(queries);
  const privateSnap = results[0];
  const legacySnap = results[1];
  const balances = results[2];
  const yearPrivateSnap = needSeparateYearQuery ? results[3] : privateSnap;
  const yearLegacySnap = needSeparateYearQuery ? results[4] : legacySnap;

  const ALL_PLANS = ['monthly', 'seasonal', 'semi_annual', 'annual'] as const;
  const revenue: AnyMap = { total: 0, bySource: {}, byPlan: {} };
  const globalUniqueUsers = new Set<string>();
  const planStats: Record<string, { count: number; revenue: number; uniqueUsers: Set<string> }> = {
    monthly: { count: 0, revenue: 0, uniqueUsers: new Set() },
    seasonal: { count: 0, revenue: 0, uniqueUsers: new Set() },
    semi_annual: { count: 0, revenue: 0, uniqueUsers: new Set() },
    annual: { count: 0, revenue: 0, uniqueUsers: new Set() },
  };

  const add = (source: string, plan: string, amount: number, studentId: string) => {
    if (!Number.isSafeInteger(amount) || amount < 0) return;
    revenue.total += amount;
    revenue.bySource[source] = (revenue.bySource[source] || 0) + amount;
    revenue.byPlan[plan] = (revenue.byPlan[plan] || 0) + amount;

    const normalizedPlan = (plan || '').toLowerCase().trim();
    if (planStats[normalizedPlan]) {
      planStats[normalizedPlan].count += 1;
      planStats[normalizedPlan].revenue += amount;
      if (studentId) {
        const normalizedId = studentId.toLowerCase().trim();
        planStats[normalizedPlan].uniqueUsers.add(normalizedId);
        globalUniqueUsers.add(normalizedId);
      }
    }
  };

  const cancelledIds = new Set<string>();
  for (const doc of legacySnap.docs) {
    const d = doc.data();
    if (d.status === 'cancelled' || d.terminatedByRecord) {
      if (doc.id) cancelledIds.add(String(doc.id));
      if (d.auditedRecordId) cancelledIds.add(String(d.auditedRecordId));
    }
  }

  for (const doc of privateSnap.docs) {
    const data = doc.data();
    if (
      data.type !== 'activation' ||
      data.source === 'grant' ||
      data.voidedBy ||
      data.cancelledBy ||
      (doc.id && cancelledIds.has(String(doc.id))) ||
      (data.entitlementId && cancelledIds.has(String(data.entitlementId)))
    ) continue;
    add('manual', data.plan, data.amount || 0, data.studentEmail || data.studentId || '');
  }
  for (const doc of legacySnap.docs) {
    const data = doc.data();
    if (
      data.auditedRecordId ||
      !['active', 'inactive'].includes(data.status) ||
      data.paymentMethod === 'apple_iap' ||
      data.paymentMethod === 'admin_grant' ||
      (data.amount || 0) <= 0
    ) continue;
    const source = ['zaincash', 'superkey'].includes(data.paymentMethod) ? 'gateway' : 'legacy';
    add(source, data.plan, data.amount || 0, data.userEmail || data.userId || '');
  }

  let yearlyTotal = 0;
  if (period === 'this_year') {
    yearlyTotal = revenue.total;
  } else {
    const yearCancelledIds = new Set<string>();
    for (const doc of yearLegacySnap.docs) {
      const d = doc.data();
      if (d.status === 'cancelled' || d.terminatedByRecord) {
        if (doc.id) yearCancelledIds.add(String(doc.id));
        if (d.auditedRecordId) yearCancelledIds.add(String(d.auditedRecordId));
      }
    }
    for (const doc of yearPrivateSnap.docs) {
      const data = doc.data();
      if (
        data.type !== 'activation' ||
        data.source === 'grant' ||
        data.voidedBy ||
        data.cancelledBy ||
        (doc.id && yearCancelledIds.has(String(doc.id))) ||
        (data.entitlementId && yearCancelledIds.has(String(data.entitlementId)))
      ) continue;
      const amt = data.amount || 0;
      if (Number.isSafeInteger(amt) && amt > 0) yearlyTotal += amt;
    }
    for (const doc of yearLegacySnap.docs) {
      const data = doc.data();
      if (
        data.auditedRecordId ||
        !['active', 'inactive'].includes(data.status) ||
        data.paymentMethod === 'apple_iap' ||
        data.paymentMethod === 'admin_grant'
      ) continue;
      const amt = data.amount || 0;
      if (Number.isSafeInteger(amt) && amt > 0) yearlyTotal += amt;
    }
  }

  const planBreakdown: Record<string, { count: number; revenue: number; uniqueSubscribers: number }> = {};
  for (const p of ALL_PLANS) {
    planBreakdown[p] = {
      count: planStats[p]?.count || 0,
      revenue: planStats[p]?.revenue || 0,
      uniqueSubscribers: planStats[p]?.uniqueUsers?.size || 0,
    };
  }

  return {
    period,
    range: { start: range.start.toISOString(), end: range.end.toISOString() },
    revenue: {
      ...revenue,
      planBreakdown,
      totalUniqueSubscribers: globalUniqueUsers.size,
    },
    yearlyRevenue: yearlyTotal,
    balances: balances.balances,
  };
}

async function getExpiring(admin: any, actor: SubscriptionActor, cursorValue: unknown): Promise<AnyMap> {
  requireCapability(actor, 'canViewExpiring');
  const db = admin.firestore();
  const cursor = decodeCursor(cursorValue);
  const now = new Date();
  const end = new Date(now.getTime() + 7 * 86_400_000);
  let query: any = db.collection('users')
    .where('isSubscribed', '==', true)
    .where('subscriptionEnd', '>=', admin.firestore.Timestamp.fromDate(now))
    .where('subscriptionEnd', '<', admin.firestore.Timestamp.fromDate(end))
    .orderBy('subscriptionEnd', 'asc')
    .orderBy(admin.firestore.FieldPath.documentId(), 'asc');
  if (cursor.subscriptionEnd && cursor.id) {
    query = query.startAfter(admin.firestore.Timestamp.fromMillis(cursor.subscriptionEnd), cursor.id);
  }
  const snap = await query.limit(EXPIRING_PAGE_SIZE + 1).get();
  const docs = snap.docs.slice(0, EXPIRING_PAGE_SIZE);
  const items = await Promise.all(docs.map(async (doc: any) => {
    const data = doc.data();
    const recordSnap = await db.collection('subscriptionRecords')
      .where('studentId', '==', doc.id)
      .orderBy('createdAt', 'desc')
      .limit(10)
      .get();
    const expiryMillis = asMillis(data.subscriptionEnd);
    const record = recordSnap.docs.find((item: any) => !item.data().voidedBy && asMillis(item.data().endDate) === expiryMillis);
    return serialize({
      studentId: doc.id,
      studentEmail: data.email || doc.id,
      studentName: data.name || data.originalName || data.email || doc.id,
      plan: data.subscriptionPlan || null,
      expiry: data.subscriptionEnd,
      daysLeft: expiryMillis === null ? null : Math.max(0, Math.ceil((expiryMillis - now.getTime()) / 86_400_000)),
      staffTag: record ? record.data().actor?.name || record.data().actor?.email || '-' : '-',
    });
  }));
  const last = docs[docs.length - 1];
  return {
    items,
    nextCursor: snap.docs.length > EXPIRING_PAGE_SIZE && last
      ? encodeCursor({ subscriptionEnd: asMillis(last.data().subscriptionEnd), id: last.id })
      : null,
  };
}

async function resolveSupport(admin: any, value: string): Promise<{ ref: any; snap: any }> {
  const db = admin.firestore();
  const directRef = db.collection('users').doc(value);
  const direct = await directRef.get();
  if (direct.exists) return { ref: directRef, snap: direct };
  const byEmail = await db.collection('users').where('email', '==', value.toLowerCase()).limit(1).get();
  if (byEmail.empty) throw new SubscriptionManagementError(404, 'SUPPORT_NOT_FOUND', 'Support account not found');
  return { ref: byEmail.docs[0].ref, snap: byEmail.docs[0] };
}

async function setSupportStatus(admin: any, actor: SubscriptionActor, uid: string, input: AnyMap): Promise<AnyMap> {
  requireMaster(actor, 'canManageSupportStatus');
  const requestId = validateRequestId(input.requestId);
  if (typeof input.disabled !== 'boolean') throw new SubscriptionManagementError(400, 'INVALID_STATUS', 'disabled must be boolean');
  const payloadHash = requestPayloadHash({ action: 'support_status', uid, disabled: input.disabled });
  const db = admin.firestore();
  const requestRef = db.collection('subscriptionRequests').doc(requestId);
  const replay = await requestRef.get();
  if (replay.exists) return idempotencyResult(replay, payloadHash);
  const target = await resolveSupport(admin, uid);
  const data = target.snap.data();
  if (data.role !== 'support') throw new SubscriptionManagementError(409, 'NOT_SUPPORT', 'Target is not a Support account');
  const allowedRef = db.collection('allowed_admins').doc(String(data.email || target.snap.id).toLowerCase());
  return db.runTransaction(async (tx: any) => {
    const existing = await tx.get(requestRef);
    if (existing.exists) return idempotencyResult(existing, payloadHash);
    const liveTarget = await tx.get(target.ref);
    if (!liveTarget.exists || liveTarget.data()?.role !== 'support') {
      throw new SubscriptionManagementError(409, 'NOT_SUPPORT', 'Target is not a Support account');
    }
    const now = admin.firestore.Timestamp.now();
    const result = { success: true, supportUid: target.snap.id, disabled: input.disabled };
    tx.set(target.ref, { staffDisabled: input.disabled, staffDisabledAt: now, staffDisabledBy: actor.uid }, { merge: true });
    tx.set(allowedRef, { staffDisabled: input.disabled }, { merge: true });
    tx.create(requestRef, { requestId, payloadHash, action: 'support_status', actor: actorSnapshot(actor), targetUid: target.snap.id, createdAt: now, result });
    return { ...result, replayed: false };
  });
}

async function removeSupport(admin: any, actor: SubscriptionActor, uid: string, input: AnyMap): Promise<AnyMap> {
  requireMaster(actor, 'canManageSupportStatus');
  const requestId = validateRequestId(input.requestId);
  const payloadHash = requestPayloadHash({ action: 'remove_support', uid });
  const db = admin.firestore();
  const requestRef = db.collection('subscriptionRequests').doc(requestId);
  const replay = await requestRef.get();
  if (replay.exists) return idempotencyResult(replay, payloadHash);
  const target = await resolveSupport(admin, uid);
  const targetData = target.snap.data();
  if (targetData.role !== 'support') throw new SubscriptionManagementError(409, 'NOT_SUPPORT', 'Target is not a Support account');
  const balanceRef = db.collection('supportBalances').doc(target.snap.id);
  const allowedRef = db.collection('allowed_admins').doc(String(targetData.email || target.snap.id).toLowerCase());
  return db.runTransaction(async (tx: any) => {
    const existing = await tx.get(requestRef);
    if (existing.exists) return idempotencyResult(existing, payloadHash);
    const liveTarget = await tx.get(target.ref);
    if (!liveTarget.exists || liveTarget.data()?.role !== 'support') {
      throw new SubscriptionManagementError(409, 'NOT_SUPPORT', 'Target is not a Support account');
    }
    const balance = withBalanceDefaults((await tx.get(balanceRef)).data());
    if (balance.outstanding !== 0) {
      throw new SubscriptionManagementError(409, 'NON_ZERO_SUPPORT_BALANCE', 'Settle the Support balance before removal');
    }
    const now = admin.firestore.Timestamp.now();
    const result = { success: true, supportUid: target.snap.id };
    tx.set(target.ref, {
      role: 'student',
      permissions: admin.firestore.FieldValue.delete(),
      managedStageId: admin.firestore.FieldValue.delete(),
      staffDisabled: admin.firestore.FieldValue.delete(),
    }, { merge: true });
    tx.delete(allowedRef);
    tx.create(requestRef, { requestId, payloadHash, action: 'remove_support', actor: actorSnapshot(actor), targetUid: target.snap.id, createdAt: now, result });
    return { ...result, replayed: false };
  });
}

export async function resolveStudent(admin: any, value: string): Promise<{ ref: any; snap: any }> {
  const db = admin.firestore();
  const directRef = db.collection('users').doc(value);
  const direct = await directRef.get();
  if (direct.exists) return { ref: directRef, snap: direct };

  try {
    const usersColl = db.collection('users');
    if (typeof usersColl.where === 'function') {
      const byEmail = await usersColl.where('email', '==', value.toLowerCase()).limit(1).get();
      if (byEmail && !byEmail.empty && byEmail.docs && byEmail.docs.length > 0) {
        return { ref: byEmail.docs[0].ref || db.collection('users').doc(byEmail.docs[0].id), snap: byEmail.docs[0] };
      }
    }
  } catch {}

  // Check students collection (for roster students who haven't logged in yet)
  try {
    const studentsColl = db.collection('students');
    if (studentsColl && typeof studentsColl.doc === 'function') {
      const studentDoc = await studentsColl.doc(value.toLowerCase()).get();
      if (studentDoc && studentDoc.exists) {
        const sData = studentDoc.data() || {};
        if (sData.googleEmail) {
          try {
            const usersColl = db.collection('users');
            if (typeof usersColl.where === 'function') {
              const byGoogle = await usersColl.where('email', '==', sData.googleEmail.toLowerCase()).limit(1).get();
              if (byGoogle && !byGoogle.empty && byGoogle.docs && byGoogle.docs.length > 0) {
                return { ref: byGoogle.docs[0].ref || db.collection('users').doc(byGoogle.docs[0].id), snap: byGoogle.docs[0] };
              }
            }
          } catch {}
        }
        const initialName = sData.name || sData.originalName || value;
        const nowTimestamp = admin.firestore.FieldValue?.serverTimestamp
          ? admin.firestore.FieldValue.serverTimestamp()
          : new Date();
        const userSeed = {
          name: initialName,
          originalName: initialName,
          email: value.toLowerCase(),
          role: 'student',
          ...(sData.stageId ? { stageId: sData.stageId } : {}),
          ...(sData.subgroup ? { group: sData.subgroup } : {}),
          isSubscribed: false,
          createdAt: nowTimestamp,
        };
        if (typeof directRef.set === 'function') {
          await directRef.set(userSeed, { merge: true });
          const freshUserSnap = await directRef.get();
          return { ref: directRef, snap: freshUserSnap };
        }
        return {
          ref: directRef,
          snap: {
            exists: true,
            id: value.toLowerCase(),
            data: () => userSeed,
          },
        };
      }
    }

    if (studentsColl && typeof studentsColl.where === 'function') {
      const studentByGoogle = await studentsColl.where('googleEmail', '==', value.toLowerCase()).limit(1).get();
      if (studentByGoogle && !studentByGoogle.empty && studentByGoogle.docs && studentByGoogle.docs.length > 0) {
        return resolveStudent(admin, studentByGoogle.docs[0].id);
      }
    }
  } catch {}

  throw new SubscriptionManagementError(404, 'STUDENT_NOT_FOUND', 'Student not found');
}

export async function modifySubscriptionEnd(
  admin: any,
  actor: SubscriptionActor,
  input: AnyMap,
): Promise<AnyMap> {
  requireMaster(actor, 'canGrant');
  const requestId = validateRequestId(input.requestId);
  const studentIdentifier = String(input.studentEmail || input.studentId || input.userId || '').trim();
  if (!studentIdentifier) {
    throw new SubscriptionManagementError(400, 'INVALID_STUDENT_ID', 'studentEmail or studentId is required');
  }
  const newEndDate = asDate(input.newEndDate);
  if (!newEndDate) {
    throw new SubscriptionManagementError(400, 'INVALID_END_DATE', 'A valid newEndDate is required');
  }
  const reason = normalizeLimitedText(input.reason ?? input.note ?? input.notes, 'reason');
  const payloadHash = requestPayloadHash({
    action: 'modify_expiry',
    student: studentIdentifier.toLowerCase(),
    newEndDate: newEndDate.toISOString(),
    ...(reason ? { reason } : {}),
  });

  const db = admin.firestore();
  const target = await resolveStudent(admin, studentIdentifier);
  const targetUserRef = target.ref;
  const targetUserId = target.snap.id;

  return withUniqueReference('MOD', async (referenceCode) => {
    return db.runTransaction(async (tx: any) => {
      const recordRef = db.collection('subscriptionRecords').doc(requestId);
      const referenceRef = db.collection('referenceCodes').doc(referenceCode);

      const existing = await tx.get(recordRef);
      if (existing.exists) return idempotencyResult(existing, payloadHash);
      const referenceSnap = await tx.get(referenceRef);
      if (referenceSnap.exists) collision();

      const userSnap = await tx.get(targetUserRef);
      if (!userSnap.exists) throw new SubscriptionManagementError(404, 'STUDENT_NOT_FOUND', 'Student not found');

      const userData = userSnap.data() || {};
      const nowDate = new Date();
      const now = admin.firestore.Timestamp.fromDate(nowDate);
      const newExpiryTimestamp = admin.firestore.Timestamp.fromDate(newEndDate);
      const isSubscribed = newEndDate.getTime() > nowDate.getTime();

      const studentName = String(userData.name || userData.originalName || userData.email || targetUserId);
      const studentEmail = String(userData.email || targetUserId);

      // Find active subscriptions in subscriptions collection if any
      const activeSubsSnap = await tx.get(
        db.collection('subscriptions')
          .where('userId', '==', targetUserId)
          .where('status', '==', 'active')
      );

      for (const doc of activeSubsSnap.docs) {
        tx.update(doc.ref, {
          endDate: newExpiryTimestamp,
          status: isSubscribed ? 'active' : 'expired',
          updatedAt: now,
          modifiedByRecord: requestId,
        });
      }

      const resultValue = {
        success: true,
        recordId: requestId,
        referenceCode,
        studentId: targetUserId,
        studentEmail,
        newExpiry: newEndDate.toISOString(),
        isSubscribed,
      };

      tx.update(targetUserRef, {
        subscriptionEnd: newExpiryTimestamp,
        isSubscribed,
      });

      tx.create(recordRef, {
        requestId,
        payloadHash,
        referenceCode,
        referenceCodeNormalized: referenceCode.toUpperCase(),
        studentId: targetUserId,
        studentEmail,
        studentName,
        type: 'modify_expiry',
        source: 'master_admin',
        actorUid: actor.uid,
        actor: actorSnapshot(actor),
        previousExpiry: userData.subscriptionEnd || null,
        newExpiry: newExpiryTimestamp,
        previousIsSubscribed: userData.isSubscribed === true,
        newIsSubscribed: isSubscribed,
        previousUserFields: previousFieldSnapshot(userData),
        ...(reason ? { reason } : {}),
        createdAt: now,
        result: resultValue,
      });

      tx.create(referenceRef, {
        referenceCode,
        targetCollection: 'subscriptionRecords',
        targetId: requestId,
        createdAt: now,
      });

      return { ...resultValue, replayed: false };
    });
  });
}

export async function terminateSubscription(
  admin: any,
  actor: SubscriptionActor,
  input: AnyMap,
): Promise<AnyMap> {
  requireMaster(actor, 'canGrant');
  const requestId = validateRequestId(input.requestId);
  const studentIdentifier = String(input.studentEmail || input.studentId || input.userId || '').trim();
  if (!studentIdentifier) {
    throw new SubscriptionManagementError(400, 'INVALID_STUDENT_ID', 'studentEmail or studentId is required');
  }
  const immediate = input.immediate !== false;
  let effectiveEndDate: Date;
  if (immediate) {
    effectiveEndDate = new Date();
  } else {
    const parsed = asDate(input.endDate);
    if (!parsed) {
      throw new SubscriptionManagementError(400, 'INVALID_END_DATE', 'A valid endDate is required when not immediate');
    }
    effectiveEndDate = parsed;
  }

  const reason = normalizeLimitedText(input.reason ?? input.note ?? input.notes, 'reason');
  const payloadHash = requestPayloadHash({
    action: 'terminate',
    student: studentIdentifier.toLowerCase(),
    immediate,
    endDate: effectiveEndDate.toISOString(),
    ...(reason ? { reason } : {}),
  });

  const db = admin.firestore();
  const target = await resolveStudent(admin, studentIdentifier);
  const targetUserRef = target.ref;
  const targetUserId = target.snap.id;

  return withUniqueReference('TRM', async (referenceCode) => {
    return db.runTransaction(async (tx: any) => {
      const recordRef = db.collection('subscriptionRecords').doc(requestId);
      const referenceRef = db.collection('referenceCodes').doc(referenceCode);

      const existing = await tx.get(recordRef);
      if (existing.exists) return idempotencyResult(existing, payloadHash);
      const referenceSnap = await tx.get(referenceRef);
      if (referenceSnap.exists) collision();

      const userSnap = await tx.get(targetUserRef);
      if (!userSnap.exists) throw new SubscriptionManagementError(404, 'STUDENT_NOT_FOUND', 'Student not found');

      const userData = userSnap.data() || {};
      const nowDate = new Date();
      const now = admin.firestore.Timestamp.fromDate(nowDate);
      const effectiveTimestamp = admin.firestore.Timestamp.fromDate(effectiveEndDate);
      const isSubscribed = immediate ? false : effectiveEndDate.getTime() > nowDate.getTime();

      const studentName = String(userData.name || userData.originalName || userData.email || targetUserId);
      const studentEmail = String(userData.email || targetUserId);

      // Find active subscriptions in subscriptions collection if any
      const activeSubsSnap = await tx.get(
        db.collection('subscriptions')
          .where('userId', '==', targetUserId)
          .where('status', '==', 'active')
      );

      // Read audited activation records and support balances before performing any writes
      const auditedUpdates: Array<{
        ref: any;
        id: string;
        data: AnyMap;
        balanceRef?: any;
        balanceSnap?: any;
      }> = [];

      if (immediate) {
        for (const doc of activeSubsSnap.docs) {
          const auditedId = doc.data()?.auditedRecordId;
          if (auditedId && typeof auditedId === 'string') {
            const origRecordRef = db.collection('subscriptionRecords').doc(auditedId);
            const origRecordSnap = await tx.get(origRecordRef);
            if (origRecordSnap.exists) {
              const origData = origRecordSnap.data() || {};
              let balanceRef: any;
              let balanceSnap: any;
              if (origData.amount > 0 && origData.source === 'manual' && origData.actorUid) {
                balanceRef = db.collection('supportBalances').doc(origData.actorUid);
                balanceSnap = await tx.get(balanceRef);
              }
              auditedUpdates.push({
                ref: origRecordRef,
                id: auditedId,
                data: origData,
                balanceRef,
                balanceSnap,
              });
            }
          }
        }
      }

      for (const doc of activeSubsSnap.docs) {
        tx.update(doc.ref, {
          endDate: effectiveTimestamp,
          status: immediate ? 'cancelled' : (isSubscribed ? 'active' : 'expired'),
          updatedAt: now,
          terminatedByRecord: requestId,
        });
      }

      const resultValue = {
        success: true,
        recordId: requestId,
        referenceCode,
        studentId: targetUserId,
        studentEmail,
        immediate,
        terminationDate: effectiveEndDate.toISOString(),
        isSubscribed,
      };

      for (let idx = 0; idx < auditedUpdates.length; idx++) {
        const item = auditedUpdates[idx];
        tx.update(item.ref, {
          cancelledBy: {
            recordId: requestId,
            referenceCode,
            actor: actorSnapshot(actor),
            createdAt: now,
          },
          updatedAt: now,
        });

        if (item.balanceRef && item.balanceSnap && item.balanceSnap.exists) {
          const balance = withBalanceDefaults(item.balanceSnap.data());
          const amount = item.data.amount || 0;
          if (amount > 0) {
            const balanceAfter = balance.outstanding - amount;
            tx.set(item.balanceRef, {
              ...balance,
              outstanding: balanceAfter,
              totalReversed: (balance.totalReversed || 0) + amount,
              updatedAt: now,
            }, { merge: true });

            const ledgerId = auditedUpdates.length === 1 ? requestId : `${requestId}_${idx}`;
            const ledgerRef = db.collection('supportLedger').doc(ledgerId);
            tx.create(ledgerRef, {
              requestId: ledgerId,
              payloadHash,
              referenceCode,
              type: 'void_reversal',
              amount,
              balanceDelta: -amount,
              balanceAfter,
              supportUid: item.data.actorUid,
              actor: actorSnapshot(actor),
              recordId: item.id,
              commissionRate: balance.commissionRate,
              createdAt: now,
              result: resultValue,
            });
          }
        }
      }

      tx.update(targetUserRef, {
        subscriptionEnd: effectiveTimestamp,
        isSubscribed,
      });

      tx.create(recordRef, {
        requestId,
        payloadHash,
        referenceCode,
        referenceCodeNormalized: referenceCode.toUpperCase(),
        studentId: targetUserId,
        studentEmail,
        studentName,
        type: 'termination',
        source: 'master_admin',
        immediate,
        actorUid: actor.uid,
        actor: actorSnapshot(actor),
        previousExpiry: userData.subscriptionEnd || null,
        terminationDate: effectiveTimestamp,
        previousIsSubscribed: userData.isSubscribed === true,
        newIsSubscribed: isSubscribed,
        previousUserFields: previousFieldSnapshot(userData),
        ...(reason ? { reason } : {}),
        createdAt: now,
        result: resultValue,
      });

      tx.create(referenceRef, {
        referenceCode,
        targetCollection: 'subscriptionRecords',
        targetId: requestId,
        createdAt: now,
      });

      return { ...resultValue, replayed: false };
    });
  });
}

const ACTIVE_PAGE_SIZE = 25;

export async function getActiveSubscriptions(
  admin: any,
  actor: SubscriptionActor,
  queryInput: AnyMap = {},
): Promise<AnyMap> {
  requireCapability(actor, 'canViewExpiring');
  const db = admin.firestore();
  const search = typeof queryInput.search === 'string' ? queryInput.search.trim().toLowerCase() : '';
  const now = new Date();

  if (search) {
    const items: AnyMap[] = [];
    const seenIds = new Set<string>();

    const directSnap = await db.collection('users').doc(search).get();
    if (directSnap.exists) {
      const data = directSnap.data() || {};
      seenIds.add(directSnap.id);
      const expiryMillis = asMillis(data.subscriptionEnd);
      items.push(serialize({
        studentId: directSnap.id,
        studentEmail: data.email || directSnap.id,
        studentName: data.name || data.originalName || data.email || directSnap.id,
        plan: data.subscriptionPlan || null,
        expiry: data.subscriptionEnd || null,
        isSubscribed: data.isSubscribed === true,
        daysLeft: expiryMillis === null ? null : Math.max(0, Math.ceil((expiryMillis - now.getTime()) / 86_400_000)),
      }));
    }

    if (!seenIds.has(search)) {
      const emailSnap = await db.collection('users').where('email', '==', search).limit(5).get();
      for (const doc of emailSnap.docs) {
        if (!seenIds.has(doc.id)) {
          seenIds.add(doc.id);
          const data = doc.data() || {};
          const expiryMillis = asMillis(data.subscriptionEnd);
          items.push(serialize({
            studentId: doc.id,
            studentEmail: data.email || doc.id,
            studentName: data.name || data.originalName || data.email || doc.id,
            plan: data.subscriptionPlan || null,
            expiry: data.subscriptionEnd || null,
            isSubscribed: data.isSubscribed === true,
            daysLeft: expiryMillis === null ? null : Math.max(0, Math.ceil((expiryMillis - now.getTime()) / 86_400_000)),
          }));
        }
      }
    }

    const sampleSnap = await db.collection('users')
      .where('isSubscribed', '==', true)
      .orderBy('subscriptionEnd', 'desc')
      .limit(100)
      .get();

    for (const doc of sampleSnap.docs) {
      if (seenIds.has(doc.id)) continue;
      const data = doc.data() || {};
      const name = String(data.name || data.originalName || '').toLowerCase();
      const email = String(data.email || doc.id).toLowerCase();
      if (name.includes(search) || email.includes(search)) {
        seenIds.add(doc.id);
        const expiryMillis = asMillis(data.subscriptionEnd);
        items.push(serialize({
          studentId: doc.id,
          studentEmail: data.email || doc.id,
          studentName: data.name || data.originalName || data.email || doc.id,
          plan: data.subscriptionPlan || null,
          expiry: data.subscriptionEnd || null,
          isSubscribed: data.isSubscribed === true,
          daysLeft: expiryMillis === null ? null : Math.max(0, Math.ceil((expiryMillis - now.getTime()) / 86_400_000)),
        }));
      }
    }

    return { items, nextCursor: null };
  }

  const cursor = decodeCursor(queryInput.cursor);
  let query: any = db.collection('users')
    .where('isSubscribed', '==', true)
    .orderBy('subscriptionEnd', 'asc')
    .orderBy(admin.firestore.FieldPath.documentId(), 'asc');

  if (cursor.subscriptionEnd && cursor.id) {
    query = query.startAfter(admin.firestore.Timestamp.fromMillis(cursor.subscriptionEnd), cursor.id);
  }

  const snap = await query.limit(ACTIVE_PAGE_SIZE + 1).get();
  const docs = snap.docs.slice(0, ACTIVE_PAGE_SIZE);
  const items = docs.map((doc: any) => {
    const data = doc.data() || {};
    const expiryMillis = asMillis(data.subscriptionEnd);
    return serialize({
      studentId: doc.id,
      studentEmail: data.email || doc.id,
      studentName: data.name || data.originalName || data.email || doc.id,
      plan: data.subscriptionPlan || null,
      expiry: data.subscriptionEnd || null,
      isSubscribed: data.isSubscribed === true,
      daysLeft: expiryMillis === null ? null : Math.max(0, Math.ceil((expiryMillis - now.getTime()) / 86_400_000)),
    });
  });

  const last = docs[docs.length - 1];
  return {
    items,
    nextCursor: snap.docs.length > ACTIVE_PAGE_SIZE && last
      ? encodeCursor({ subscriptionEnd: asMillis(last.data().subscriptionEnd), id: last.id })
      : null,
  };
}

export interface SubscriptionStudentSearchResult {
  id: string;
  email: string;
  name: string;
  isSubscribed: boolean;
  currentPlan?: string | null;
  currentExpiry?: string | null;
  stageId?: string | null;
}

export async function searchStudentsForSubscription(
  admin: any,
  actor: SubscriptionActor,
  rawQuery: string,
): Promise<{ students: SubscriptionStudentSearchResult[] }> {
  const query = (rawQuery || '').trim();
  if (!query || query.length < 2) {
    return { students: [] };
  }

  const db = admin.firestore();
  const lowerQuery = query.toLowerCase();
  const normalizedQuery = normalizeName(query);
  const queryWords = normalizedQuery.split(/\s+/).filter(w => w.length > 0);
  const resultsMap = new Map<string, SubscriptionStudentSearchResult>();

  // 1. Direct user / student lookup if query contains @ or looks like an email/id
  if (lowerQuery.includes('@')) {
    try {
      const directUserSnap = await db.collection('users').doc(lowerQuery).get();
      if (directUserSnap.exists) {
        const data = directUserSnap.data() || {};
        const email = (data.email || directUserSnap.id).toLowerCase();
        resultsMap.set(email, {
          id: directUserSnap.id,
          email: data.email || directUserSnap.id,
          name: data.name || data.originalName || email,
          isSubscribed: data.isSubscribed === true,
          currentPlan: data.subscriptionPlan || null,
          currentExpiry: asDate(data.subscriptionEnd)?.toISOString() || null,
          stageId: data.stageId || null,
        });
      }
    } catch {}

    try {
      const directStudentSnap = await db.collection('students').doc(lowerQuery).get();
      if (directStudentSnap.exists) {
        const data = directStudentSnap.data() || {};
        const email = (data.email || directStudentSnap.id).toLowerCase();
        if (!resultsMap.has(email)) {
          resultsMap.set(email, {
            id: directStudentSnap.id,
            email: data.email || directStudentSnap.id,
            name: data.name || email,
            isSubscribed: false,
            currentPlan: null,
            currentExpiry: null,
            stageId: data.stageId || null,
          });
        }
      }
    } catch {}

    try {
      const googleStudentSnap = await db.collection('students')
        .where('googleEmail', '==', lowerQuery)
        .limit(5)
        .get();
      for (const doc of googleStudentSnap.docs) {
        const data = doc.data() || {};
        const email = (data.email || doc.id).toLowerCase();
        if (!resultsMap.has(email)) {
          resultsMap.set(email, {
            id: doc.id,
            email: data.email || doc.id,
            name: data.name || email,
            isSubscribed: false,
            currentPlan: null,
            currentExpiry: null,
            stageId: data.stageId || null,
          });
        }
      }
    } catch {}
  }

  // 2. Login Code search if query matches code format
  if (looksLikeLoginCode(query)) {
    const codeKey = loginCodeKeyFor(query);
    try {
      const byCode = await db.collection('students')
        .where('loginCodeKey', '==', codeKey)
        .limit(5)
        .get();
      for (const doc of byCode.docs) {
        const data = doc.data() || {};
        const email = (data.email || doc.id).toLowerCase();
        if (!resultsMap.has(email)) {
          resultsMap.set(email, {
            id: doc.id,
            email: data.email || doc.id,
            name: data.name || email,
            isSubscribed: false,
            currentPlan: null,
            currentExpiry: null,
            stageId: data.stageId || null,
          });
        }
      }
    } catch {}
  }

  // 3. Cached Roster in-memory multi-word / substring search:
  // Caches lightweight roster index for 3 minutes via serverCache.
  // Supports matching any part of student names (father name, surname, multi-word).
  try {
    let roster: any[] | null = null;
    try {
      roster = serverCache.get<any[]>('roster:search_index');
    } catch {}
    if (!roster) {
      const rosterSnap = await db.collection('students').get();
      roster = rosterSnap.docs.map((doc: any) => {
        const d = doc.data() || {};
        const name = d.name || d.originalName || doc.id;
        const norm = normalizeName(name);
        return {
          id: doc.id,
          email: (d.email || doc.id).toLowerCase(),
          name,
          normalizedName: norm,
          nameKey: d.nameKey || norm,
          loginCodeKey: d.loginCodeKey || (d.loginCode ? loginCodeKeyFor(d.loginCode) : ''),
          googleEmail: (d.googleEmail || '').toLowerCase(),
          stageId: d.stageId || null,
        };
      });
      try {
        serverCache.set('roster:search_index', roster, 3 * 60 * 1000);
      } catch {}
    }

    if (roster && roster.length > 0) {
      const matchedRoster = roster.filter((item: any) => {
        if (item.email.includes(lowerQuery) || (item.googleEmail && item.googleEmail.includes(lowerQuery))) {
          return true;
        }
        if (item.loginCodeKey && item.loginCodeKey.includes(lowerQuery)) {
          return true;
        }
        if (normalizedQuery && item.normalizedName.includes(normalizedQuery)) {
          return true;
        }
        if (queryWords.length > 1 && queryWords.every((w: string) => item.normalizedName.includes(w))) {
          return true;
        }
        return false;
      });

      for (const item of matchedRoster.slice(0, 20)) {
        if (!resultsMap.has(item.email)) {
          resultsMap.set(item.email, {
            id: item.id,
            email: item.email,
            name: item.name,
            isSubscribed: false,
            currentPlan: null,
            currentExpiry: null,
            stageId: item.stageId,
          });
        }
      }
    }
  } catch {}

  // 4. Query students collection by nameKey and name prefix (Firestore fallback)
  if (normalizedQuery) {
    try {
      const studentNameSnap = await db.collection('students')
        .where('nameKey', '>=', normalizedQuery)
        .where('nameKey', '<=', normalizedQuery + '\uf8ff')
        .limit(15)
        .get();

      for (const doc of studentNameSnap.docs) {
        const data = doc.data() || {};
        const email = (data.email || doc.id).toLowerCase();
        if (!resultsMap.has(email)) {
          resultsMap.set(email, {
            id: doc.id,
            email: data.email || doc.id,
            name: data.name || email,
            isSubscribed: false,
            currentPlan: null,
            currentExpiry: null,
            stageId: data.stageId || null,
          });
        }
      }
    } catch {}
  }

  // Also query students collection by raw name prefix
  try {
    const studentRawNameSnap = await db.collection('students')
      .where('name', '>=', query)
      .where('name', '<=', query + '\uf8ff')
      .limit(15)
      .get();

    for (const doc of studentRawNameSnap.docs) {
      const data = doc.data() || {};
      const email = (data.email || doc.id).toLowerCase();
      if (!resultsMap.has(email)) {
        resultsMap.set(email, {
          id: doc.id,
          email: data.email || doc.id,
          name: data.name || email,
          isSubscribed: false,
          currentPlan: null,
          currentExpiry: null,
          stageId: data.stageId || null,
        });
      }
    }
  } catch {}

  // 5. Query users collection by email, name, displayName, and originalName prefixes
  try {
    const userEmailSnap = await db.collection('users')
      .where('email', '>=', lowerQuery)
      .where('email', '<=', lowerQuery + '\uf8ff')
      .limit(10)
      .get();

    for (const doc of userEmailSnap.docs) {
      const data = doc.data() || {};
      const email = (data.email || doc.id).toLowerCase();
      if (!resultsMap.has(email)) {
        resultsMap.set(email, {
          id: doc.id,
          email: data.email || doc.id,
          name: data.name || data.originalName || data.email || doc.id,
          isSubscribed: data.isSubscribed === true,
          currentPlan: data.subscriptionPlan || null,
          currentExpiry: asDate(data.subscriptionEnd)?.toISOString() || null,
          stageId: data.stageId || null,
        });
      }
    }
  } catch {}

  const userQueryFields = ['name', 'displayName', 'originalName'];
  for (const field of userQueryFields) {
    try {
      const userSnap = await db.collection('users')
        .where(field, '>=', query)
        .where(field, '<=', query + '\uf8ff')
        .limit(15)
        .get();

      for (const doc of userSnap.docs) {
        const data = doc.data() || {};
        const email = (data.email || doc.id).toLowerCase();
        if (!resultsMap.has(email)) {
          resultsMap.set(email, {
            id: doc.id,
            email: data.email || doc.id,
            name: data.name || data.displayName || data.originalName || data.email || doc.id,
            isSubscribed: data.isSubscribed === true,
            currentPlan: data.subscriptionPlan || null,
            currentExpiry: asDate(data.subscriptionEnd)?.toISOString() || null,
            stageId: data.stageId || null,
          });
        }
      }
    } catch {}
  }

  // 6. Enrich any student records without subscription info from users collection
  const needsEnrichment = Array.from(resultsMap.values()).filter(r => !r.isSubscribed);
  if (needsEnrichment.length > 0) {
    await Promise.all(needsEnrichment.slice(0, 15).map(async (item) => {
      try {
        const uSnap = await db.collection('users').doc(item.email).get();
        if (uSnap.exists) {
          const uData = uSnap.data() || {};
          item.isSubscribed = uData.isSubscribed === true;
          item.currentPlan = uData.subscriptionPlan || null;
          item.currentExpiry = asDate(uData.subscriptionEnd)?.toISOString() || null;
          if (uData.name) item.name = uData.name;
        } else {
          const uByEmail = await db.collection('users').where('email', '==', item.email).limit(1).get();
          if (!uByEmail.empty) {
            const uData = uByEmail.docs[0].data() || {};
            item.isSubscribed = uData.isSubscribed === true;
            item.currentPlan = uData.subscriptionPlan || null;
            item.currentExpiry = asDate(uData.subscriptionEnd)?.toISOString() || null;
            if (uData.name) item.name = uData.name;
          }
        }
      } catch {}
    }));
  }

  // 7. Sort by relevance:
  // 1) Exact match on normalizedName, loginCodeKey, or email
  // 2) Starts with normalizedQuery
  // 3) Active subscribers first
  // 4) Name alphabetical
  const list = Array.from(resultsMap.values());
  list.sort((a, b) => {
    const aNorm = normalizeName(a.name);
    const bNorm = normalizeName(b.name);
    const aExact = aNorm === normalizedQuery || a.email.toLowerCase() === lowerQuery;
    const bExact = bNorm === normalizedQuery || b.email.toLowerCase() === lowerQuery;
    if (aExact && !bExact) return -1;
    if (!aExact && bExact) return 1;

    const aStarts = aNorm.startsWith(normalizedQuery);
    const bStarts = bNorm.startsWith(normalizedQuery);
    if (aStarts && !bStarts) return -1;
    if (!aStarts && bStarts) return 1;

    if (a.isSubscribed && !b.isSubscribed) return -1;
    if (!a.isSubscribed && b.isSubscribed) return 1;

    return a.name.localeCompare(b.name);
  });

  return { students: list.slice(0, 15) };
}

function asyncHandler(fn: (req: any, res: any) => Promise<any>) {
  return async (req: any, res: any) => {
    try {
      await fn(req, res);
    } catch (error: any) {
      if (error instanceof SubscriptionManagementError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      console.error('Subscription management error:', error);
      return res.status(500).json({ error: 'Subscription management failed', code: 'INTERNAL_ERROR' });
    }
  };
}

export function createSubscriptionManagementHandlers({ admin }: SubscriptionManagementDeps) {
  return {
    mine: asyncHandler(async (req, res) => {
      const snap = await admin.firestore().collection('subscriptions')
        .where('userId', '==', req.user.uid)
        .orderBy('createdAt', 'desc')
        .limit(50)
        .get();
      res.json({ subscriptions: snap.docs.map((doc: any) => {
        const data = doc.data();
        return serialize({ plan: data.plan, status: data.status, amount: data.amount, startDate: data.startDate, endDate: data.endDate, createdAt: data.createdAt });
      }) });
    }),
    searchStudents: asyncHandler(async (req, res) => {
      const actor = await loadActor(admin, req);
      if (!actor.isMasterAdmin && !hasStaffCapability(actor, 'canActivate') && !hasStaffCapability(actor, 'canGrant')) {
        throw new SubscriptionManagementError(403, 'PERMISSION_DENIED', 'Missing subscription search permission');
      }
      res.json(await searchStudentsForSubscription(admin, actor, String(req.query.q || '')));
    }),
    preview: asyncHandler(async (req, res) => {
      const actor = await loadActor(admin, req);
      requireCapability(actor, 'canActivate');
      res.json(await previewManagedSubscription(admin, normalizeStudentEmail(req.query.studentEmail), String(req.query.plan || '')));
    }),
    manualActivate: asyncHandler(async (req, res) => {
      const actor = await loadActor(admin, req);
      res.json(await commitManagedActivation(admin, actor, req.body || {}, 'manual'));
    }),
    grant: asyncHandler(async (req, res) => {
      const actor = await loadActor(admin, req);
      res.json(await commitManagedActivation(admin, actor, req.body || {}, 'grant'));
    }),
    requestGrant: asyncHandler(async (req, res) => {
      const actor = await loadActor(admin, req);
      res.json(await requestSupportGrant(admin, actor, req.body || {}));
    }),
    receive: asyncHandler(async (req, res) => {
      const actor = await loadActor(admin, req);
      res.json(await settleManagedBalance(admin, actor, req.params.supportUid, req.body || {}, 'receive'));
    }),
    reset: asyncHandler(async (req, res) => {
      const actor = await loadActor(admin, req);
      res.json(await settleManagedBalance(admin, actor, req.params.supportUid, req.body || {}, 'reset'));
    }),
    payout: asyncHandler(async (req, res) => {
      const actor = await loadActor(admin, req);
      res.json(await settleManagedBalance(admin, actor, req.params.supportUid, req.body || {}, 'payout'));
    }),
    void: asyncHandler(async (req, res) => {
      const actor = await loadActor(admin, req);
      res.json(await voidManagedRecord(admin, actor, req.params.recordId, req.body || {}));
    }),
    history: asyncHandler(async (req, res) => {
      const actor = await loadActor(admin, req);
      res.json(await getHistory(admin, actor, req.query || {}));
    }),
    balances: asyncHandler(async (req, res) => {
      const actor = await loadActor(admin, req);
      res.json(await getBalances(admin, actor, req.query || {}));
    }),
    reports: asyncHandler(async (req, res) => {
      const actor = await loadActor(admin, req);
      res.json(await getReports(admin, actor, String(req.query.period || 'today')));
    }),
    expiring: asyncHandler(async (req, res) => {
      const actor = await loadActor(admin, req);
      res.json(await getExpiring(admin, actor, req.query.cursor));
    }),
    active: asyncHandler(async (req, res) => {
      const actor = await loadActor(admin, req);
      res.json(await getActiveSubscriptions(admin, actor, req.query || {}));
    }),
    modifyEndDate: asyncHandler(async (req, res) => {
      const actor = await loadActor(admin, req);
      res.json(await modifySubscriptionEnd(admin, actor, req.body || {}));
    }),
    terminate: asyncHandler(async (req, res) => {
      const actor = await loadActor(admin, req);
      res.json(await terminateSubscription(admin, actor, req.body || {}));
    }),
    supportStatus: asyncHandler(async (req, res) => {
      const actor = await loadActor(admin, req);
      res.json(await setSupportStatus(admin, actor, req.params.uid, req.body || {}));
    }),
    removeSupport: asyncHandler(async (req, res) => {
      const actor = await loadActor(admin, req);
      res.json(await removeSupport(admin, actor, req.params.uid, req.body || {}));
    }),
  };
}
