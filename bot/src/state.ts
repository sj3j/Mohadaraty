import { db, FieldValue, Timestamp } from './firebase.ts';
import { env } from './env.ts';
import { log, errFields } from './log.ts';
import { safeBootstrapOffset } from './reliabilityCore.ts';

/** Durable polling checkpoint and the fenced single-poller lease. */
export const STATE = db.collection('admin_config').doc('telegram_state');

const LEASE_RENEW_MS = 30_000;
export const LEASE_TTL_MS = 90_000;

export type LeaseFailureStatus =
  | 'LEASE_PERMISSION_DENIED'
  | 'LEASE_SERVICE_UNAVAILABLE'
  | 'LEASE_TRANSACTION_FAILED'
  | 'LEASE_UNEXPECTED_ERROR';

export type LeaseAcquireResult =
  | { status: 'LEASE_ACQUIRED'; generation: number }
  | { status: 'LEASE_HELD_BY_OTHER'; holder: string | null; remainingMs: number }
  | { status: LeaseFailureStatus; error: unknown };

function errorCode(error: unknown): string {
  const raw = (error as { code?: unknown } | null)?.code;
  return String(raw ?? '').toLowerCase();
}

/** Firebase may expose gRPC numeric codes or symbolic HTTP-style names. */
export function classifyLeaseError(error: unknown): LeaseFailureStatus {
  const code = errorCode(error);
  if (code === '7' || code.includes('permission-denied') || code.includes('permission_denied')) {
    return 'LEASE_PERMISSION_DENIED';
  }
  if (
    code === '4' || code === '8' || code === '10' || code === '13' || code === '14'
    || code.includes('deadline') || code.includes('resource-exhausted')
    || code.includes('aborted') || code.includes('internal') || code.includes('unavailable')
  ) {
    return 'LEASE_SERVICE_UNAVAILABLE';
  }
  if (code) return 'LEASE_TRANSACTION_FAILED';
  return 'LEASE_UNEXPECTED_ERROR';
}

let renewTimer: NodeJS.Timeout | null = null;
let leaseHeld = false;
let generation = 0;
let lastRenewedAt = 0;
let renewalError: string | null = null;
let lastAcquireStatus: LeaseAcquireResult['status'] | null = null;
let lastAcquireAt = 0;

export const holdsLease = (): boolean => leaseHeld;
export const leaseGeneration = (): number => generation;
export const leaseHealth = () => ({
  held: leaseHeld,
  generation,
  lastRenewedAt: lastRenewedAt || null,
  renewalError,
  lastAcquireStatus,
  lastAcquireAt: lastAcquireAt || null,
});

export function leaseUnavailableReason(
  status: LeaseAcquireResult['status'] | null,
): 'lease_permission_denied' | 'lease_held_by_other' | 'firestore_unavailable' | 'lease_acquisition_failed' | 'lease_not_held' {
  if (status === 'LEASE_PERMISSION_DENIED') return 'lease_permission_denied';
  if (status === 'LEASE_HELD_BY_OTHER') return 'lease_held_by_other';
  if (status === 'LEASE_SERVICE_UNAVAILABLE') return 'firestore_unavailable';
  if (status === 'LEASE_TRANSACTION_FAILED' || status === 'LEASE_UNEXPECTED_ERROR') {
    return 'lease_acquisition_failed';
  }
  return 'lease_not_held';
}

/** Transactionally acquires the lease and increments a fencing generation. */
export async function acquireLease(): Promise<LeaseAcquireResult> {
  try {
    const result = await db.runTransaction(async tx => {
      const snap = await tx.get(STATE);
      const data = snap.data() ?? {};
      const lease = data.lease as {
        instanceId?: string;
        expiresAt?: Timestamp;
        generation?: number;
      } | undefined;

      if (lease?.expiresAt && lease.instanceId !== env.instanceId) {
        const remainingMs = lease.expiresAt.toMillis() - Date.now();
        if (remainingMs > 0) {
          return {
            status: 'LEASE_HELD_BY_OTHER' as const,
            holder: lease.instanceId ?? null,
            remainingMs,
          };
        }
      }

      const nextGeneration = Math.max(Number(data.leaseGeneration ?? 0), Number(lease?.generation ?? 0)) + 1;
      tx.set(STATE, {
        leaseGeneration: nextGeneration,
        lease: {
          instanceId: env.instanceId,
          generation: nextGeneration,
          expiresAt: Timestamp.fromMillis(Date.now() + LEASE_TTL_MS),
          renewedAt: FieldValue.serverTimestamp(),
        },
        bootAt: FieldValue.serverTimestamp(),
        instanceId: env.instanceId,
      }, { merge: true });

      return { status: 'LEASE_ACQUIRED' as const, generation: nextGeneration };
    });

    if (result.status === 'LEASE_ACQUIRED') {
      lastAcquireStatus = result.status;
      lastAcquireAt = Date.now();
      generation = result.generation;
      leaseHeld = true;
      lastRenewedAt = Date.now();
      renewalError = null;
      log.info('lease.acquired', { generation });
    } else {
      lastAcquireStatus = result.status;
      lastAcquireAt = Date.now();
      log.warn('lease.held_by_other', {
        holder: result.holder,
        remainingMs: result.remainingMs,
      });
    }
    return result;
  } catch (error) {
    const status = classifyLeaseError(error);
    lastAcquireStatus = status;
    lastAcquireAt = Date.now();
    log.error('lease.acquire_failed', { status, ...errFields(error) });
    return { status, error };
  }
}

/** Throws when a stale process attempts a fenced state mutation. */
export function assertLeaseOwner(data: Record<string, unknown>): void {
  const lease = data.lease as { instanceId?: string; generation?: number } | undefined;
  if (
    !leaseHeld
    || lease?.instanceId !== env.instanceId
    || Number(lease?.generation ?? 0) !== generation
  ) {
    throw new LeaseFencedError();
  }
}

export class LeaseFencedError extends Error {
  constructor() {
    super('lease ownership or generation changed');
    this.name = 'LeaseFencedError';
  }
}

export function startLeaseRenewal(onLost: () => void): void {
  if (!leaseHeld || generation <= 0) throw new Error('cannot renew a lease that was not acquired');

  renewTimer = setInterval(async () => {
    try {
      const ok = await db.runTransaction(async tx => {
        const snap = await tx.get(STATE);
        const lease = snap.data()?.lease as { instanceId?: string; generation?: number } | undefined;
        if (lease?.instanceId !== env.instanceId || Number(lease?.generation ?? 0) !== generation) {
          return false;
        }

        tx.set(STATE, {
          lease: {
            instanceId: env.instanceId,
            generation,
            expiresAt: Timestamp.fromMillis(Date.now() + LEASE_TTL_MS),
            renewedAt: FieldValue.serverTimestamp(),
          },
        }, { merge: true });
        return true;
      });

      if (!ok) return loseLease('ownership_changed', onLost);
      lastRenewedAt = Date.now();
      renewalError = null;
    } catch (error) {
      renewalError = error instanceof Error ? error.message : String(error);
      log.warn('lease.renew_failed', { status: classifyLeaseError(error), ...errFields(error) });
      if (Date.now() - lastRenewedAt >= LEASE_TTL_MS - LEASE_RENEW_MS) {
        loseLease('renewal_ttl_exhausted', onLost);
      }
    }
  }, LEASE_RENEW_MS);
  renewTimer.unref();
}

function loseLease(reason: string, onLost: () => void): void {
  if (!leaseHeld) return;
  leaseHeld = false;
  log.error('lease.lost', { reason, generation });
  onLost();
}

export function stopLeaseRenewal(): void {
  if (renewTimer) clearInterval(renewTimer);
  renewTimer = null;
  leaseHeld = false;
}

/** Releases only the exact lease generation this process acquired. */
export async function releaseLease(): Promise<void> {
  if (generation <= 0) return;
  const ownedGeneration = generation;
  try {
    await db.runTransaction(async tx => {
      const snap = await tx.get(STATE);
      const lease = snap.data()?.lease as { instanceId?: string; generation?: number } | undefined;
      if (lease?.instanceId !== env.instanceId || Number(lease?.generation ?? 0) !== ownedGeneration) return;
      tx.set(STATE, { lease: FieldValue.delete() }, { merge: true });
    });
  } catch (error) {
    log.warn('lease.release_failed', { ...errFields(error) });
  }
}

/** Missing state replays Telegram's earliest still-available update; it never discards backlog. */
export async function loadOffset(): Promise<number> {
  const snap = await STATE.get();
  const stored = snap.exists ? (snap.data()?.offset as number | undefined) : undefined;

  if (typeof stored === 'number' && stored >= 0) {
    const offset = safeBootstrapOffset(stored);
    log.info('state.offset_resumed', { offset });
    return offset;
  }

  log.warn('state.offset_missing_replay', {
    offset: 0,
    policy: 'earliest_available',
    limitation: 'Telegram may already have expired older unconfirmed updates',
  });
  return 0;
}
