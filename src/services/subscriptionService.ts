import { db, auth } from '../lib/firebase';
import {
  collection, query, where, orderBy, onSnapshot, getDocs,
  doc, addDoc, updateDoc, serverTimestamp, Timestamp, getDoc
} from 'firebase/firestore';
import { Subscription, SubscriptionPlan, PaymentMethod, PLAN_CONFIG } from '../types';
import { apiUrl } from '../lib/apiBase';

const SUBSCRIPTIONS_COL = 'subscriptions';

// ─── User-facing ────────────────────────────────────────────────

/** Real-time listener for a user's subscriptions */
export function onUserSubscriptions(
  userId: string,
  callback: (subs: Subscription[]) => void
): () => void {
  const q = query(
    collection(db, SUBSCRIPTIONS_COL),
    where('userId', '==', userId),
    orderBy('createdAt', 'desc')
  );
  return onSnapshot(q, (snap) => {
    const subs: Subscription[] = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Subscription));
    callback(subs);
  });
}

/** Create a pending subscription (SuperKey manual flow) */
export async function createPendingSubscription(
  userId: string,
  userEmail: string,
  userName: string,
  plan: SubscriptionPlan,
  transactionId: string
): Promise<string> {
  const config = PLAN_CONFIG[plan];
  const docRef = await addDoc(collection(db, SUBSCRIPTIONS_COL), {
    userId,
    userEmail,
    userName,
    plan,
    status: 'pending',
    startDate: null, // set on approval
    endDate: null,   // set on approval
    paymentMethod: 'superkey' as PaymentMethod,
    transactionId,
    amount: config.price,
    createdAt: serverTimestamp(),
  });
  return docRef.id;
}

/** Initiate a ZainCash payment via the server */
export async function initiateZainCashPayment(
  plan: SubscriptionPlan,
  lang: 'ar' | 'en' = 'ar',
): Promise<string> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('Not authenticated');
  
  const res = await fetch(apiUrl('/api/zaincash/init'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ plan, lang }),
  });
  
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Payment initiation failed' }));
    throw new Error(err.error || 'Payment initiation failed');
  }
  
  const data = await res.json();
  return data.redirectUrl; // gateway-supplied; never construct this URL
}

// ─── Admin-facing ───────────────────────────────────────────────

/** Real-time listener for ALL subscriptions (admin) */
export function onAllSubscriptions(
  callback: (subs: Subscription[]) => void
): () => void {
  const q = query(
    collection(db, SUBSCRIPTIONS_COL),
    orderBy('createdAt', 'desc')
  );
  return onSnapshot(q, (snap) => {
    const subs: Subscription[] = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Subscription));
    callback(subs);
  });
}

/** Admin: approve a pending SuperKey subscription */
export async function approveSubscription(subId: string): Promise<void> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('Not authenticated');
  
  const res = await fetch(apiUrl(`/api/subscriptions/${subId}/approve`), {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Approval failed' }));
    throw new Error(err.error || 'Approval failed');
  }
}

/** Admin: reject a pending subscription */
export async function rejectSubscription(subId: string): Promise<void> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('Not authenticated');
  
  const res = await fetch(apiUrl(`/api/subscriptions/${subId}/reject`), {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Rejection failed' }));
    throw new Error(err.error || 'Rejection failed');
  }
}

/** Admin: extend a subscription by additional days */
export async function extendSubscription(subId: string, days: number): Promise<void> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('Not authenticated');
  
  const res = await fetch(apiUrl(`/api/subscriptions/${subId}/extend`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ days }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Extension failed' }));
    throw new Error(err.error || 'Extension failed');
  }
}

/** Admin: cancel an active subscription */
export async function cancelSubscription(subId: string): Promise<void> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('Not authenticated');
  
  const res = await fetch(apiUrl(`/api/subscriptions/${subId}/cancel`), {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Cancellation failed' }));
    throw new Error(err.error || 'Cancellation failed');
  }
}

/** Admin: grant a free subscription */
export async function grantSubscription(
  userId: string,
  plan: SubscriptionPlan,
  notes?: string
): Promise<void> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('Not authenticated');
  
  const res = await fetch(apiUrl('/api/subscriptions/grant'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ userId, plan, notes }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Grant failed' }));
    throw new Error(err.error || 'Grant failed');
  }
}

// ─── Helpers ────────────────────────────────────────────────────

/** Calculate remaining days from a Firestore Timestamp */
export function getRemainingDays(endDate: any): number {
  if (!endDate) return 0;
  const end = endDate.toDate ? endDate.toDate() : new Date(endDate);
  const now = new Date();
  const diff = end.getTime() - now.getTime();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

/** Format a Firestore Timestamp to a readable date string */
export function formatSubscriptionDate(date: any): string {
  if (!date) return '—';
  const d = date.toDate ? date.toDate() : new Date(date);
  return d.toLocaleDateString('ar-IQ', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
