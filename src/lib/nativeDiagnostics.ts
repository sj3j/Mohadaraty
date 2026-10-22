/**
 * Opt-in, local-only diagnostics for a test build on an affected device.
 * No identifier, token, title, URL, or server response is ever recorded.
 */
const ENABLED = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_NATIVE_DIAGNOSTICS) === 'true';
const STORAGE_KEY = 'native_diagnostics_v1';
const MAX_EVENTS = 50;

export type NativeDiagnosticEvent = {
  at: number;
  phase: 'login' | 'lecture-load';
  outcome: string;
  code?: string;
  authenticated?: boolean;
  fromCache?: boolean;
  count?: number;
};

export function recordNativeDiagnostic(event: Omit<NativeDiagnosticEvent, 'at'>): void {
  if (!ENABLED || typeof window === 'undefined') return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const previous: NativeDiagnosticEvent[] = raw ? JSON.parse(raw) : [];
    const next = [...previous, { ...event, at: Date.now() }].slice(-MAX_EVENTS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Diagnostics must never affect login or lecture access.
  }
}

export function clearNativeDiagnostics(): void {
  if (typeof window === 'undefined') return;
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}
