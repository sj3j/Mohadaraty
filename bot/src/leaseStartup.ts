import type { LeaseAcquireResult } from './state.ts';

export interface LeaseWaitEvent {
  status: Exclude<LeaseAcquireResult['status'], 'LEASE_ACQUIRED'>;
  attempt: number;
  waitMs: number;
}

export interface LeaseWaitOptions {
  acquire: () => Promise<LeaseAcquireResult>;
  shouldContinue: () => boolean;
  onWait?: (event: LeaseWaitEvent) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export class LeaseWaitAbortedError extends Error {
  constructor() {
    super('shutdown while waiting for Firestore lease');
    this.name = 'LeaseWaitAbortedError';
  }
}

/** Base retry delay before the small jitter applied by waitForLease. */
export function leaseRetryDelayMs(result: LeaseAcquireResult, attempt: number): number {
  if (result.status === 'LEASE_HELD_BY_OTHER') {
    return Math.min(60_000, Math.max(2_000, result.remainingMs + 1_000));
  }
  if (result.status === 'LEASE_PERMISSION_DENIED') return 60_000;
  return Math.min(60_000, 2 ** Math.min(attempt, 6) * 1_000);
}

/**
 * Keeps a single process alive while an overlap, IAM repair, or transient
 * Firestore outage clears. Dependencies are injected so startup behavior can
 * be verified without touching Telegram or production Firestore.
 */
export async function waitForLease(options: LeaseWaitOptions): Promise<number> {
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  let attempt = 0;

  while (options.shouldContinue()) {
    const result = await options.acquire();
    if (result.status === 'LEASE_ACQUIRED') return result.generation;

    attempt += 1;
    const waitMs = leaseRetryDelayMs(result, attempt);
    options.onWait?.({ status: result.status, attempt, waitMs });
    await sleep(waitMs + random() * 0.2 * waitMs);
  }

  throw new LeaseWaitAbortedError();
}
