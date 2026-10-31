import { auth } from '../lib/firebase';
import { apiUrl } from '../lib/apiBase';
import { collectAccountSessionDevice, collectAccountSessionDeviceAsync } from '../lib/accountSessionDevice';

export interface AccountSession {
  id: string;
  current: boolean;
  authorized: boolean;
  device: {
    kind: 'mobile' | 'web' | 'desktop' | 'unknown';
    name: string;
    platform: string;
    operatingSystem: string;
    browser: string;
    appVersion: string;
  };
  location: { city: string; country: string };
  signedInAt: string | null;
  lastSeenAt: string | null;
}

export class AccountSessionError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

async function request(path: string, init: RequestInit = {}) {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new AccountSessionError('unauthorized', 401);
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new AccountSessionError(body?.error || 'session_request_failed', response.status);
  return body;
}

export async function listAccountSessions(): Promise<AccountSession[]> {
  return (await request('/api/me/sessions')).sessions || [];
}

export async function terminateAccountSession(sessionId: string): Promise<void> {
  await request(`/api/me/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
}

export async function terminateOtherAccountSessions(): Promise<number> {
  return (await request('/api/me/sessions/terminate-others', { method: 'POST' })).terminated || 0;
}

export function endCurrentAccountSessionBestEffort(user?: { getIdTokenResult: () => Promise<any> } | null): void {
  const currentUser = user || auth.currentUser;
  if (!currentUser) return;
  void currentUser.getIdTokenResult().then(async result => {
    const sessionId = result.claims?.app_session_id;
    if (typeof sessionId !== 'string' || !sessionId) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 2_000);
    try {
      await fetch(apiUrl(`/api/me/sessions/${encodeURIComponent(sessionId)}`), {
        method: 'DELETE',
        keepalive: true,
        signal: controller.signal,
        headers: { Authorization: `Bearer ${result.token}`, 'Content-Type': 'application/json' },
      });
    } catch { /* logout must always continue */ }
    finally { window.clearTimeout(timeout); }
  }).catch(() => undefined);
}

export async function registerAccountSession(options?: {
  sessionNonce?: string;
  device?: unknown;
}): Promise<{ token: string; sessionId: string }> {
  const sessionNonce = options?.sessionNonce || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : undefined);
  const device = options?.device || await collectAccountSessionDeviceAsync();

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await auth.currentUser?.getIdToken();
    if (!token) throw new AccountSessionError('unauthorized', 401);

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(apiUrl('/api/auth/register-session'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sessionNonce, device }),
        signal: controller.signal,
      });
      window.clearTimeout(timeout);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new AccountSessionError(data?.error || 'session_registration_failed', res.status);
      }
      return data;
    } catch (err: any) {
      window.clearTimeout(timeout);
      if (err instanceof AccountSessionError) throw err;
      if (attempt === 1) throw err;
      await new Promise(r => window.setTimeout(r, 1000));
    }
  }
  throw new AccountSessionError('session_registration_failed', 500);
}

export const isSessionRevokedError = (error: unknown): boolean =>
  error instanceof AccountSessionError && error.code === 'app_session_revoked';

export const isSessionRequiredError = (error: unknown): boolean =>
  error instanceof AccountSessionError && (error.code === 'app_session_required' || error.status === 428);
