import { db, auth, storage } from '../lib/firebase';
import {
  collection, query, where, orderBy, onSnapshot, getDocs,
  doc, addDoc, setDoc, updateDoc, serverTimestamp, Timestamp, getDoc
} from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import { Subscription, SubscriptionPlan, PaymentMethod, PLAN_CONFIG } from '../types';
import { apiUrl } from '../lib/apiBase';
import {
  EMPTY_PAYMENT_CONTACT,
  PAYMENT_CONTACT_COLLECTION,
  PAYMENT_CONTACT_DOC,
  PaymentContact,
  isProofSufficient,
  normalizePaymentContact,
  receiptStoragePath,
} from '../lib/paymentContact';

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

/** Get the currently active subscription for a user (if any) */
export async function getActiveSubscription(userId: string): Promise<Subscription | null> {
  const q = query(
    collection(db, SUBSCRIPTIONS_COL),
    where('userId', '==', userId),
    where('status', '==', 'active')
  );
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() } as Subscription;
}

/**
 * Upload a receipt screenshot for a manual transfer.
 *
 * The object name has to start with the uploader's uid - storage.rules admits
 * `payment_receipts/` writes with `fileName.matches(request.auth.uid + ".*")`,
 * so receiptStoragePath() owns that shape rather than this call site.
 *
 * Returns the download URL AND the object name: the URL carries an access
 * token and tells you nothing about where the file is, which is what an admin
 * needs when a receipt has to be found or deleted later.
 */
export async function uploadPaymentReceipt(
  userId: string,
  file: File,
): Promise<{ url: string; path: string }> {
  const path = receiptStoragePath(userId, file.name);
  const fileRef = storageRef(storage, path);
  await uploadBytes(fileRef, file, { contentType: file.type || 'image/jpeg' });
  return { url: await getDownloadURL(fileRef), path };
}

/** Evidence of a manual transfer. At least one member must be present. */
export interface PaymentProof {
  /** The reference Super Qi shows on its success screen. */
  transactionId?: string;
  receiptUrl?: string;
  receiptPath?: string;
}

/**
 * Create a pending subscription (manual Super Qi / Qi Card flow).
 *
 * A screenshot OR a transaction number settles it - see isProofSufficient().
 * Enforced here as well as in the form because this is the only writer of a
 * pending row, and a request carrying neither is one an admin cannot approve:
 * there is nothing to match against the wallet history.
 *
 * Undefined members are stripped rather than written: Firestore rejects an
 * explicit `undefined`, and a `transactionId: null` on a receipt-only request
 * would show up in the admin list as an empty Ref line.
 */
export async function createPendingSubscription(
  userId: string,
  userEmail: string,
  userName: string,
  plan: SubscriptionPlan,
  proof: PaymentProof
): Promise<string> {
  const transactionId = (proof.transactionId || '').trim();
  if (!isProofSufficient(transactionId, !!proof.receiptUrl)) {
    throw new Error('NO_PAYMENT_PROOF');
  }
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
    ...(transactionId ? { transactionId } : {}),
    ...(proof.receiptUrl ? { receiptUrl: proof.receiptUrl } : {}),
    ...(proof.receiptPath ? { receiptPath: proof.receiptPath } : {}),
    amount: config.price,
    createdAt: serverTimestamp(),
  });
  return docRef.id;
}

// ─── Manual payment details (settings/payment_contact) ──────────────

/**
 * Live listener for the seller's own contact details.
 *
 * onSnapshot on a single document reports an absent doc and an offline cache
 * miss identically (`exists() === false`, `fromCache` true), and both mean the
 * same thing here - show the "not configured yet" note - so unlike the boot
 * paths in App.tsx this one needs no fromCache discrimination.
 */
export function onPaymentContact(
  callback: (contact: PaymentContact) => void
): () => void {
  return onSnapshot(
    doc(db, PAYMENT_CONTACT_COLLECTION, PAYMENT_CONTACT_DOC),
    (snap) => callback(snap.exists() ? normalizePaymentContact(snap.data()) : EMPTY_PAYMENT_CONTACT),
    () => callback(EMPTY_PAYMENT_CONTACT),
  );
}

/**
 * Admin: save the contact details students see.
 *
 * Merged, and normalised first, so what the student screen renders is what was
 * validated here - a wa.me link built from a local 07xx number opens WhatsApp's
 * "phone number is invalid" page instead of a chat.
 */
export async function savePaymentContact(contact: PaymentContact): Promise<void> {
  await setDoc(
    doc(db, PAYMENT_CONTACT_COLLECTION, PAYMENT_CONTACT_DOC),
    { ...normalizePaymentContact(contact), updatedAt: serverTimestamp() },
    { merge: true },
  );
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

/** Admin: approve a pending manual (Super Qi / Qi Card) subscription */
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
