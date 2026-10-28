import { queueFor, SerialQueue, stopAllQueues } from '../src/queue.ts';
import {
  albumIsReady, checkpointAfter, durablyReceiveBatch, retryDelayMs, safeBootstrapOffset,
} from '../src/reliabilityCore.ts';
import { classifyLeaseError } from '../src/state.ts';
import { isGrowingAlbum, isPromotableSkip } from '../src/sync/inboundPolicy.ts';
import { FileIngestError, ingestTelegramFile } from '../src/sync/media.ts';
import { resolveChannelForStage, resolveStageForChat, type TelegramConfig } from '../../shared/telegramMirror.ts';
import type { TgUpdate } from '../src/telegram/types.ts';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  PASS  ${name}`);
    passed += 1;
  } else {
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
    failed += 1;
  }
}

console.log('\nSerialQueue never discards accepted work');

const queue = new SerialQueue('reliability-test');
let releaseFirst!: () => void;
const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
const ran: number[] = [];

const jobs: Promise<number>[] = [
  queue.push('0', async () => {
    await firstGate;
    ran.push(0);
    return 0;
  }),
];

for (let i = 1; i <= 201; i += 1) {
  jobs.push(queue.push(String(i), async () => {
    ran.push(i);
    return i;
  }));
}

releaseFirst();
const outcomes = await Promise.allSettled(jobs);
const rejected = outcomes.filter(result => result.status === 'rejected');

check('a burst beyond the former 200-task limit rejects nothing', rejected.length === 0,
  `${rejected.length} rejected`);
check('every accepted task runs exactly once', ran.length === 202 && new Set(ran).size === 202,
  `${ran.length} ran, ${new Set(ran).size} unique`);

console.log('\nDurable receipt controls acknowledgment');

const updates = [501, 502, 503].map(update_id => ({ update_id } as TgUpdate));
check('checkpoint follows the highest durably received update', checkpointAfter(updates) === 504);

let visibleOffset = 501;
let durableIds = new Set<number>();
let receiptFailed = false;
try {
  await durablyReceiveBatch(updates, async (batch, checkpoint) => {
    const transactionIds = new Set(durableIds);
    for (const update of batch) {
      if (update.update_id === 502) throw new Error('injected Firestore failure');
      transactionIds.add(update.update_id);
    }
    durableIds = transactionIds;
    visibleOffset = checkpoint;
  });
} catch {
  receiptFailed = true;
}
check('receipt failure is observable', receiptFailed);
check('a failed durable transaction cannot advance the checkpoint', visibleOffset === 501, String(visibleOffset));
check('the simulated atomic receipt exposed no partial inbox records', durableIds.size === 0, String(durableIds.size));

const next = await durablyReceiveBatch(updates, async (batch, checkpoint) => {
  durableIds = new Set(batch.map(update => update.update_id));
  visibleOffset = checkpoint;
});
check('a successful durable receipt advances through all three updates', next === 504 && visibleOffset === 504);
check('the failed middle update remains represented durably', durableIds.has(502));

console.log('\nSafe cold start and album assembly');

check('missing checkpoint replays earliest available update', safeBootstrapOffset(undefined) === 0);
check('saved checkpoint resumes exactly', safeBootstrapOffset(331042222) === 331042222);
check('an album is not finalized at an arbitrary polling boundary',
  !albumIsReady(1_000, 1_400, 1_500, 2_500, 20_000));
check('a late member resets the inactivity window',
  !albumIsReady(1_000, 3_000, 4_000, 2_500, 20_000));
check('the inactivity window eventually finalizes the album',
  albumIsReady(1_000, 3_000, 5_500, 2_500, 20_000));
check('the maximum assembly window prevents a permanent wedge',
  albumIsReady(1_000, 20_500, 21_000, 2_500, 20_000));
check('late album growth is recognized from any previously mapped member',
  isGrowingAlbum({ announcementId: 'a', mediaGroupId: 'g', messageIds: [11, 12] }, [10, 11, 12]));

console.log('\nEdits, leases, retries, and stage isolation');

check('an empty skip can be promoted by a meaningful edit',
  isPromotableSkip({ announcementId: null, skipped: 'empty', messageIds: [9] }));
check('a poll-only skip remains intentionally unsupported',
  !isPromotableSkip({ announcementId: null, skipped: 'poll_only', messageIds: [9] }));
check('an explicit Firestore denial is classified as IAM permission',
  classifyLeaseError(Object.assign(new Error('Missing or insufficient permissions.'), { code: 7 }))
    === 'LEASE_PERMISSION_DENIED');
check('the generic Wisp HTTP 403 is classified as a transport denial',
  classifyLeaseError(Object.assign(new Error('7 PERMISSION_DENIED: Received HTTP status code 403'), { code: 7 }))
    === 'LEASE_TRANSPORT_DENIED');
check('Firestore unavailable is classified as transient service failure',
  classifyLeaseError(Object.assign(new Error('down'), { code: 14 })) === 'LEASE_SERVICE_UNAVAILABLE');
check('retry delay grows but remains bounded',
  retryDelayMs(1, 0) === 2_000 && retryDelayMs(20, 1) <= 375_000);
const oversized = await ingestTelegramFile({
  fileId: 'unused', fileUniqueId: 'too-large', kind: 'file', name: 'large.pdf',
  size: 21 * 1024 * 1024, mime: 'application/pdf',
}, 'stage_1');
check('a genuinely oversized file is explicitly classified without a download attempt',
  oversized.oversize?.name === 'large.pdf');
check('a transient attachment failure remains retryable rather than becoming oversize',
  new FileIngestError('DOWNLOAD_TIMEOUT', 'timeout', true).retryable);

const stageConfig: TelegramConfig = {
  enabled: true,
  defaultMirrorOut: true,
  channels: {
    stage_1: { chatId: -1001, enabled: true, mirrorIn: true, mirrorOut: false },
    stage_2: { chatId: -1002, enabled: true, mirrorIn: true, mirrorOut: true },
    stage_3: { chatId: -1003, enabled: true, mirrorIn: true, mirrorOut: true },
    stage_4: { chatId: -1004, enabled: true, mirrorIn: true, mirrorOut: true },
    stage_5: { chatId: -1005, enabled: true, mirrorIn: true, mirrorOut: true },
  },
};
check('five inbound chats resolve to five distinct stages',
  [-1001, -1002, -1003, -1004, -1005].every((chatId, index) =>
    resolveStageForChat(stageConfig, chatId) === `stage_${index + 1}`));
check('an inbound-only stage does not require an outbound watcher',
  resolveStageForChat(stageConfig, -1001) === 'stage_1'
    && resolveChannelForStage(stageConfig, 'stage_1') === null);

console.log('\nGraceful queue shutdown');
const shutdownQueue = new SerialQueue('shutdown-test');
let releaseShutdown!: () => void;
const shutdownGate = new Promise<void>(resolve => { releaseShutdown = resolve; });
let shutdownRan = false;
const shutdownJob = shutdownQueue.push('in-flight', async () => {
  await shutdownGate;
  shutdownRan = true;
});
const stopping = shutdownQueue.stop();
releaseShutdown();
await Promise.all([shutdownJob, stopping]);
check('shutdown drains work that was already accepted', shutdownRan);

const recoverableQueue = queueFor(-100999);
await recoverableQueue.push('before-recovery', async () => undefined);
await stopAllQueues(true);
let freshQueueRan = false;
await queueFor(-100999).push('after-recovery', async () => { freshQueueRan = true; });
check('a recovered generation receives a fresh queue', freshQueueRan);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
