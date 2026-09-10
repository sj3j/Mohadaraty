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
}

/** Beyond this, the oldest task is dropped. A queue that has grown this long
 *  means Telegram has been unreachable for a long time, and the Firestore
 *  watcher will re-deliver the current state on reconnect anyway - so old
 *  queued edits are stale, not precious. */
const MAX_DEPTH = 200;

export class SerialQueue {
  private readonly tasks: Task<any>[] = [];
  private running = false;
  private stopped = false;

  constructor(private readonly name: string) {}

  get depth(): number {
    return this.tasks.length + (this.running ? 1 : 0);
  }

  push<T>(label: string, run: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error(`queue ${this.name} is stopped`));

    return new Promise<T>((resolve, reject) => {
      if (this.tasks.length >= MAX_DEPTH) {
        const dropped = this.tasks.shift();
        log.warn('queue.dropped_oldest', { queue: this.name, dropped: dropped?.label, depth: this.tasks.length });
        dropped?.reject(new Error('dropped: queue full'));
      }
      this.tasks.push({ run, resolve, reject, label });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;

    while (this.tasks.length > 0 && !this.stopped) {
      const task = this.tasks.shift()!;
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
  }

  /** Lets in-flight work finish; refuses anything new. */
  async stop(): Promise<void> {
    this.stopped = true;
    while (this.running) await new Promise(resolve => setTimeout(resolve, 25));
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

export async function stopAllQueues(): Promise<void> {
  await Promise.all([...queues.values()].map(q => q.stop()));
}
