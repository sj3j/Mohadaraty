import type { TgUpdate } from './telegram/types.ts';

export function checkpointAfter(updates: TgUpdate[]): number | null {
  if (updates.length === 0) return null;
  return Math.max(...updates.map(update => update.update_id)) + 1;
}

export function safeBootstrapOffset(stored: unknown): number {
  return typeof stored === 'number' && Number.isFinite(stored) && stored >= 0 ? stored : 0;
}

/** The caller receives a new offset only after the durable write succeeds. */
export async function durablyReceiveBatch(
  updates: TgUpdate[],
  persist: (updates: TgUpdate[], checkpoint: number) => Promise<void>,
): Promise<number | null> {
  const checkpoint = checkpointAfter(updates);
  if (checkpoint === null) return null;
  await persist(updates, checkpoint);
  return checkpoint;
}

export function albumIsReady(
  firstReceivedMs: number,
  lastMemberMs: number,
  nowMs: number,
  inactivityMs: number,
  maximumAssemblyMs: number,
): boolean {
  return nowMs - lastMemberMs >= inactivityMs || nowMs - firstReceivedMs >= maximumAssemblyMs;
}

export function retryDelayMs(attempt: number, random = Math.random()): number {
  const base = Math.min(5 * 60_000, 2_000 * (2 ** Math.max(0, attempt - 1)));
  return Math.round(base + base * 0.25 * random);
}
