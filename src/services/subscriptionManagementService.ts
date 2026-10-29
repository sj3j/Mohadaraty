import { auth } from '../lib/firebase';
import { apiUrl } from '../lib/apiBase';
import { secureRequestId } from '../lib/secureRandom';
import type { ManualPaymentMethod } from '../../shared/subscriptionTypes';
import type { SubscriptionPlan } from '../types';

export const newRequestId = (): string => secureRequestId();

const retryRequestIds = new Map<string, string>();
const retryRequestId = (key: string) => {
  const existing = retryRequestIds.get(key);
  if (existing) return existing;
  const created = newRequestId();
  retryRequestIds.set(key, created);
  return created;
};

async function api<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('Not authenticated');
  const response = await fetch(apiUrl(path), {
    ...init,
    signal,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error('Server returned an unexpected non-JSON response. Please ensure backend server is running and restarted.');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || 'Request failed') as Error & { code?: string; status?: number };
    error.code = body.code;
    error.status = response.status;
    throw error;
  }
  return body as T;
}

export interface SubscriptionPreview {
  studentId: string;
  studentEmail: string;
  studentName: string;
  status: 'active' | 'inactive';
  isSubscribed: boolean;
  currentPlan: string | null;
  currentExpiry: string | null;
  plan: SubscriptionPlan;
  price: number;
  newExpiry: string;
  activeWarning: boolean;
  stateToken: string;
}

export interface HistoryItem {
  id: string;
  source: string;
  studentId: string;
  studentEmail?: string;
  studentName?: string;
  type: string;
  plan?: string;
  amount?: number;
  paymentMethod?: string;
  referenceCode?: string;
  reason?: string;
  actor?: { uid?: string; email?: string; name?: string };
  createdAt?: string;
  startDate?: string;
  endDate?: string;
  status?: string;
  voidedBy?: unknown;
  voidsRecordId?: string;
  cancelledBy?: unknown;
}

export interface SupportBalance {
  supportUid: string;
  supportEmail?: string;
  supportName?: string;
  staffDisabled?: boolean;
  removed?: boolean;
  outstanding: number;
  totalCredited: number;
  totalReceived: number;
  totalReset: number;
  totalReversed: number;
  totalPaidOut: number;
  commissionRate: number;
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

export const searchSubscriptionStudents = (
  query: string,
  signal?: AbortSignal,
) => api<{ students: SubscriptionStudentSearchResult[] }>(
  `/api/subscriptions/search-students?q=${encodeURIComponent(query)}`,
  {},
  signal,
);

export const getSubscriptionPreview = (
  studentEmail: string,
  plan: SubscriptionPlan,
  signal?: AbortSignal,
) => api<SubscriptionPreview>(
  `/api/subscriptions/preview?studentEmail=${encodeURIComponent(studentEmail)}&plan=${encodeURIComponent(plan)}`,
  {},
  signal,
);

export const manualActivateSubscription = (input: {
  requestId: string;
  studentEmail: string;
  plan: SubscriptionPlan;
  paymentMethod: ManualPaymentMethod;
  note?: string;
  previewStateToken: string;
}) => api<any>('/api/subscriptions/manual-activate', { method: 'POST', body: JSON.stringify(input) });

export const grantAuditedSubscription = (input: {
  requestId: string;
  studentEmail: string;
  plan: SubscriptionPlan;
  reason?: string;
}) => api<any>('/api/subscriptions/grant', { method: 'POST', body: JSON.stringify(input) });

export const requestSupportGrant = (input: {
  requestId: string;
  studentEmail: string;
  plan: SubscriptionPlan;
  reason?: string;
}) => api<any>('/api/subscriptions/request-grant', { method: 'POST', body: JSON.stringify(input) });

export const getSubscriptionHistory = (filters: {
  student?: string;
  staff?: string;
  reference?: string;
  cursor?: string | null;
} = {}) => {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, value); });
  return api<{ items: HistoryItem[]; nextCursor: string | null }>(`/api/subscriptions/history?${params}`);
};

export const getSupportBalances = (supportUid?: string) => api<{
  balances?: SupportBalance[];
  balance?: SupportBalance;
  ledger?: any[];
}>(`/api/subscriptions/balances${supportUid ? `?supportUid=${encodeURIComponent(supportUid)}` : ''}`);

export const settleSupportBalance = (
  supportUid: string,
  action: 'receive' | 'reset' | 'payout',
  input: { requestId: string; expectedOutstanding: number; amount?: number; full?: boolean; note?: string },
) => api<any>(`/api/subscriptions/supports/${encodeURIComponent(supportUid)}/${action}`, {
  method: 'POST', body: JSON.stringify(input),
});

export const voidSubscriptionRecord = (recordId: string, requestId: string, reason?: string) =>
  api<any>(`/api/subscriptions/records/${encodeURIComponent(recordId)}/void`, {
    method: 'POST', body: JSON.stringify({ requestId, reason }),
  });

export interface ActiveSubscriptionItem {
  studentId: string;
  studentEmail: string;
  studentName: string;
  plan: SubscriptionPlan | null;
  expiry: string | null;
  isSubscribed: boolean;
  daysLeft: number | null;
}

export const getSubscriptionReports = (period: 'today' | 'this_month' | 'last_month' | 'this_year') =>
  api<any>(`/api/subscriptions/reports?period=${period}`);

export const getExpiringSubscriptions = (cursor?: string | null) =>
  api<{ items: any[]; nextCursor: string | null }>(
    `/api/subscriptions/expiring${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
  );

export const getActiveSubscriptions = (filters: {
  search?: string;
  cursor?: string | null;
} = {}) => {
  const params = new URLSearchParams();
  if (filters.search) params.set('search', filters.search);
  if (filters.cursor) params.set('cursor', filters.cursor);
  return api<{ items: ActiveSubscriptionItem[]; nextCursor: string | null }>(
    `/api/subscriptions/active?${params}`,
  );
};

export const modifySubscriptionEndDate = (input: {
  requestId?: string;
  studentEmail: string;
  newEndDate: string;
  reason?: string;
}) => api<any>('/api/subscriptions/admin/modify-end-date', {
  method: 'POST',
  body: JSON.stringify({
    requestId: input.requestId || newRequestId(),
    studentEmail: input.studentEmail,
    newEndDate: input.newEndDate,
    reason: input.reason,
  }),
});

export const terminateSubscription = (input: {
  requestId?: string;
  studentEmail: string;
  immediate: boolean;
  endDate?: string;
  reason?: string;
}) => api<any>('/api/subscriptions/admin/terminate', {
  method: 'POST',
  body: JSON.stringify({
    requestId: input.requestId || newRequestId(),
    studentEmail: input.studentEmail,
    immediate: input.immediate,
    endDate: input.endDate,
    reason: input.reason,
  }),
});

export async function setSupportDisabled(uid: string, disabled: boolean) {
  const key = `support-status:${uid}:${disabled}`;
  const result = await api<any>(
    `/api/admin/supports/${encodeURIComponent(uid)}/status`,
    { method: 'POST', body: JSON.stringify({ requestId: retryRequestId(key), disabled }) },
  );
  retryRequestIds.delete(key);
  return result;
}

export async function removeSupport(uid: string) {
  const key = `support-remove:${uid}`;
  const result = await api<any>(
    `/api/admin/supports/${encodeURIComponent(uid)}`,
    { method: 'DELETE', body: JSON.stringify({ requestId: retryRequestId(key) }) },
  );
  retryRequestIds.delete(key);
  return result;
}
