import { db, FieldValue, Timestamp } from './firebase.ts';
import { env } from './env.ts';
import { log } from './log.ts';
import { telegram } from './telegram/api.ts';

/**
 * The getUpdates offset, and the lease that keeps two containers from both
 * holding it.
 *
 * Stored in Firestore rather than on a mounted volume. Firestore is already the
 * bot's only stateful dependency; a volume adds a second losable thing, and a
 * `docker compose down -v`, a host migration or a rebuild elsewhere would
 * silently reset the offset with no signal. The offset is also wanted by the
 * admin UI, so it is one document either way.
 */

const STATE = db.collection('admin_config').doc('telegram_state');

/** Renewed on this cadence; considered dead at three times it. */
const LEASE_RENEW_MS = 30_000;
const LEASE_TTL_MS = 90_000;

/**
 * Claims the right to be the only poller.
 *
 * Two containers on one bot token both get intermittent 409s from Telegram AND
 * both write to Firestore, which double-posts every inbound message. A
 * `restart: unless-stopped` policy plus one stray `docker run` is exactly how
 * that happens, so the lease is not optional.
 *
 * Timestamps come from the SERVER, never the container clock - two hosts with
 * drifting clocks would otherwise each believe the other's lease had expired.
 */
export async function acquireLease(): Promise<boolean> {
  try {
    return await db.runTransaction(async tx => {
      const snap = await tx.get(STATE);
      const lease = snap.exists ? (snap.data()?.lease as { instanceId?: string; expiresAt?: Timestamp }) : undefined;

      if (lease?.expiresAt && lease.instanceId !== env.instanceId) {
        const remainingMs = lease.expiresAt.toMillis() - Date.now();
        if (remainingMs > 0) {
          log.error('lease.held_by_other', { holder: lease.instanceId, remainingMs });
          return false;
        }
      }

      tx.set(STATE, {
        lease: {
          instanceId: env.instanceId,
          expiresAt: Timestamp.fromMillis(Date.now() + LEASE_TTL_MS),
          renewedAt: FieldValue.serverTimestamp(),
        },
        bootAt: FieldValue.serverTimestamp(),
        instanceId: env.instanceId,
      }, { merge: true });

      return true;
    });
  } catch (error) {
    log.error('lease.acquire_failed', { err: String(error) });
    return false;
  }
}

let renewTimer: NodeJS.Timeout | null = null;
let leaseHeld = false;

export const holdsLease = () => leaseHeld;

export function startLeaseRenewal(onLost: () => void): void {
  leaseHeld = true;
  renewTimer = setInterval(async () => {
    try {
      const ok = await db.runTransaction(async tx => {
        const snap = await tx.get(STATE);
        const lease = snap.data()?.lease as { instanceId?: string } | undefined;
        // Someone else took it while we were busy. Stand down rather than
        // fight - two pollers is strictly worse than none.
        if (lease?.instanceId && lease.instanceId !== env.instanceId) return false;

        tx.set(STATE, {
          lease: {
            instanceId: env.instanceId,
            expiresAt: Timestamp.fromMillis(Date.now() + LEASE_TTL_MS),
            renewedAt: FieldValue.serverTimestamp(),
          },
        }, { merge: true });
        return true;
      });

      if (!ok) {
        leaseHeld = false;
        log.error('lease.lost', {});
        onLost();
      }
    } catch (error) {
      log.warn('lease.renew_failed', { err: String(error) });
    }
  }, LEASE_RENEW_MS);
}

export function stopLeaseRenewal(): void {
  if (renewTimer) clearInterval(renewTimer);
  renewTimer = null;
  leaseHeld = false;
}

export async function releaseLease(): Promise<void> {
  try {
    await STATE.set({ lease: FieldValue.delete() }, { merge: true });
  } catch {
    // A lease we cannot release simply expires. Never block shutdown on it.
  }
}

/**
 * The offset to resume from.
 *
 * On a FIRST EVER run this deliberately discards the backlog. Telegram holds up
 * to 24h of pending updates, and importing a day of channel history would
 * create dozens of announcements at once - each one firing its own push
 * notification to an entire stage. A mirror starts mirroring from now.
 */
export async function loadOffset(): Promise<number> {
  const snap = await STATE.get();
  const stored = snap.exists ? (snap.data()?.offset as number | undefined) : undefined;

  if (typeof stored === 'number' && stored > 0) {
    log.info('state.offset_resumed', { offset: stored });
    return stored;
  }

  const pending = await telegram.getUpdates(-1, 0);
  const offset = pending.length ? pending[pending.length - 1].update_id + 1 : 0;
  await saveOffset(offset);
  log.info('state.cold_start', { backlogSkipped: pending.length, offset });
  return offset;
}

export async function saveOffset(offset: number): Promise<void> {
  await STATE.set({ offset, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}
