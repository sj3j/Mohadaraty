import { apiUrl } from '../lib/apiBase';
import { recordNativeDiagnostic } from '../lib/nativeDiagnostics';

export type StudentLoginFailureCode =
  | 'AMBIGUOUS_IDENTIFIER'
  | 'auth/invalid-credential'
  | 'auth/user-disabled'
  | 'auth/too-many-requests'
  | 'auth/network-request-failed'
  | 'auth/timeout'
  | 'auth/server-error'
  | 'auth/server-response-invalid'
  | 'auth/token-exchange-failed';

export class StudentLoginError extends Error {
  constructor(public readonly code: StudentLoginFailureCode, message: string) {
    super(message);
    this.name = 'StudentLoginError';
  }
}

export interface StudentLoginResult<TCredential> {
  credential: TCredential;
  studentId: string;
}

export interface StudentLoginOptions<TCredential> {
  identifier: string;
  password: string;
  signInWithToken: (token: string) => Promise<TCredential>;
  fetchImpl?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
  retryDelayMs?: number;
}

const IOS_TRANSPORT_MESSAGES = /failed to fetch|network-request-failed|\bload failed\b|internet connection.*offline|network connection.*lost/i;

function isTransportFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return IOS_TRANSPORT_MESSAGES.test(message) || (error as { code?: string } | null)?.code === 'auth/network-request-failed';
}

function asLoginError(error: unknown): StudentLoginError {
  if (error instanceof StudentLoginError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new StudentLoginError('auth/timeout', 'The login request timed out.');
  }
  if (isTransportFailure(error)) {
    return new StudentLoginError('auth/network-request-failed', 'The login service could not be reached.');
  }
  return new StudentLoginError('auth/server-error', 'The login service failed unexpectedly.');
}

function statusError(status: number, body: { error?: unknown; code?: unknown }): StudentLoginError {
  const message = typeof body.error === 'string' ? body.error : 'Login request failed.';
  if (body.code === 'AMBIGUOUS_IDENTIFIER') return new StudentLoginError('AMBIGUOUS_IDENTIFIER', message);
  if (status === 401 || status === 404) return new StudentLoginError('auth/invalid-credential', message);
  if (status === 403) return new StudentLoginError('auth/user-disabled', message);
  if (status === 429) return new StudentLoginError('auth/too-many-requests', message);
  return new StudentLoginError('auth/server-error', message);
}

async function delay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Opens a student session through the server-issued Firebase custom token.
 * The request is intentionally separate from the UI so native transport
 * failures retain a useful code instead of being rendered as `(unknown)`.
 */
export async function signInStudent<TCredential>(
  options: StudentLoginOptions<TCredential>,
): Promise<StudentLoginResult<TCredential>> {
  const fetchImpl = options.fetchImpl || fetch;
  const typed = options.identifier.trim();
  const timeoutMs = options.timeoutMs ?? 20_000;
  const retryDelayMs = options.retryDelayMs ?? 1_500;

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      recordNativeDiagnostic({ phase: 'login', outcome: 'request-start' });
      const response = await fetchImpl(options.endpoint || apiUrl('/api/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Identifiers are whitespace-insensitive, but passwords are not.
        // Trimming here made valid passwords containing a leading/trailing
        // space impossible to sign in with.
        body: JSON.stringify({ identifier: typed, email: typed, password: options.password }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      let body: { token?: unknown; studentId?: unknown; error?: unknown; code?: unknown };
      try {
        body = await response.json();
      } catch {
        throw new StudentLoginError('auth/server-response-invalid', 'The login service returned an invalid response.');
      }

      if (!response.ok) throw statusError(response.status, body);
      if (typeof body.token !== 'string' || !body.token) {
        throw new StudentLoginError('auth/server-response-invalid', 'The login service returned no session token.');
      }

      try {
        const credential = await options.signInWithToken(body.token);
        recordNativeDiagnostic({ phase: 'login', outcome: 'success' });
        return { credential, studentId: (typeof body.studentId === 'string' && body.studentId || typed).toLowerCase() };
      } catch (error) {
        const code = (error as { code?: string } | null)?.code;
        throw new StudentLoginError(
          code === 'auth/network-request-failed' ? 'auth/network-request-failed' : 'auth/token-exchange-failed',
          error instanceof Error ? error.message : 'Unable to establish the Firebase session.',
        );
      }
    } catch (error) {
      clearTimeout(timeout);
      const loginError = asLoginError(error);
      recordNativeDiagnostic({ phase: 'login', outcome: 'failure', code: loginError.code });
      if (attempt === 0 && loginError.code === 'auth/network-request-failed') {
        await delay(retryDelayMs);
        continue;
      }
      throw loginError;
    }
  }

  throw new StudentLoginError('auth/network-request-failed', 'The login service could not be reached.');
}
