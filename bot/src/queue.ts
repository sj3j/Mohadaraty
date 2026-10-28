import { log, errFields } from './log.ts';

/**
 * One serial queue per Telegram chat, shared by BOTH directions.
 *
 * This is a correctness component, not a throughput one. It closes the last
 * loop-prevention race structurally rather than probabilistically:
 *
 *   The bot sends a message to a channel. Telegram delivers that same message
 *   back through getUpdates as a channel_post. A channel post carries NO `from`
 *   field - it is attributed to the channel, not the bot - so the bot cannot
 *   recognise its own post that way. It has to have already recorded the
 *   message id before the inbound handler looks it up.
 *
 * Because the poll handler and the outbound worker share this queue, the
 * send-and-record completes before the next update for that chat is processed.
 * The window is not made small; it is removed.
 *
 * It also means a 429 on one channel blocks only that channel, and that two
 * edits to the same announcement can never interleave into Telegram out of order.
 */

interface Task<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  label: string;
  enqueuedAt: number;
}

/** Producers wait at this boundary. Accepted work is never evicted. */
const MAX_DEPTH = 200;

export class SerialQueue {
  private readonly tasks: Task<any>[] = [];
  private running = false;
  private stopped = false;
  private readonly capacityWaiters: (() => void)[] = [];
  private idleWaiters: (() => void)[] = [];

  constructor(private readonly name: string) {}

  get depth(): number {
    return this.tasks.length + (this.running ? 1 : 0);
  }

  get oldestPendingAgeMs(): number {
    return this.tasks.length ? Date.now() - this.tasks[0].enqueuedAt : 0;
  }

  async push<T>(label: string, run: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error(`queue ${this.name} is stopped`));

    while (this.tasks.length >= MAX_DEPTH && !this.stopped) {
      log.warn('queue.backpressure', { queue: this.name, label, depth: this.depth });
      await new Promise<void>(resolve => this.capacityWaiters.push(resolve));
    }
    if (this.stopped) throw new Error(`queue ${this.name} is stopped`);

    return new Promise<T>((resolve, reject) => {
      this.tasks.push({ run, resolve, reject, label, enqueuedAt: Date.now() });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;

    while (this.tasks.length > 0) {
      const task = this.tasks.shift()!;
      this.capacityWaiters.shift()?.();
      try {
        task.resolve(await task.run());
      } catch (error) {
        // Rejection is handed to the caller; the queue itself keeps going. One
        // failed post must not wedge the channel behind it.
        log.warn('queue.task_failed', { queue: this.name, label: task.label, ...errFields(error) });
        task.reject(error);
      }
    }

    this.running = false;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters = [];
  }

  /** Lets in-flight work finish; refuses anything new. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const resolve of this.capacityWaiters.splice(0)) resolve();
    if (this.running || this.tasks.length) {
      await new Promise<void>(resolve => this.idleWaiters.push(resolve));
    }
  }
}

const queues = new Map<number, SerialQueue>();

/** The queue for a chat, created on first use. */
export function queueFor(chatId: number): SerialQueue {
  let queue = queues.get(chatId);
  if (!queue) {
    queue = new SerialQueue(String(chatId));
    queues.set(chatId, queue);
  }
  return queue;
}

export const queueDepths = (): Record<string, number> =>
  Object.fromEntries([...queues.entries()].map(([chatId, q]) => [String(chatId), q.depth]));

export const queueOldestPendingAges = (): Record<string, number> =>
  Object.fromEntries([...queues.entries()].map(([chatId, q]) => [String(chatId), q.oldestPendingAgeMs]));

export async function stopAllQueues(reset = false): Promise<void> {
  const active = [...queues.entries()];
  await Promise.all(active.map(([, queue]) => queue.stop()));
  if (reset) {
    for (const [chatId, queue] of active) {
      if (queues.get(chatId) === queue) queues.delete(chatId);
    }
  }
}
