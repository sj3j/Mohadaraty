import { db } from '../src/firebase.ts';
import { acquireLease, releaseLease } from '../src/state.ts';
import { watchConfig, waitForConfigReady, getConfig } from '../src/config.ts';
import {
  ALBUM_COLLECTION,
  INBOX_COLLECTION,
  persistInboundBatch,
  processAvailableWork,
} from '../src/inbox.ts';
import { ingestMessages, applyEdit } from '../src/sync/inbound.ts';
import { telegramAnnouncementId } from '../../shared/telegramMirror.ts';
import type { TgMessage, TgUpdate } from '../src/telegram/types.ts';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('This integration test must run against the Firestore emulator.');
}

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { console.log(`  PASS  ${name}`); passed += 1; }
  else { console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`); failed += 1; }
}

const chatId = -1001234567890;
const channel = { chatId, displayName: 'Integration', enabled: true, mirrorIn: true, mirrorOut: false };
const message = (message_id: number, text?: string, media_group_id?: string): TgMessage => ({
  message_id,
  date: 1_700_000_000,
  chat: { id: chatId, type: 'channel', title: 'Integration' },
  ...(text ? { text } : {}),
  ...(media_group_id ? { media_group_id } : {}),
});
const update = (update_id: number, value: TgMessage): TgUpdate => ({ update_id, channel_post: value });

await db.collection('admin_config').doc('telegram').set({
  enabled: true,
  defaultMirrorOut: true,
  channels: { stage_1: channel },
});
const unwatch = watchConfig();
await waitForConfigReady();

const lease = await acquireLease();
check('lease is acquired in the isolated database', lease.status === 'LEASE_ACQUIRED', lease.status);
if (lease.status !== 'LEASE_ACQUIRED') process.exit(1);

console.log('\nAtomic receipt and independent processing');
const batch = [update(501, message(51, 'one')), update(502, message(52, 'two')), update(503, message(53, 'three'))];
await persistInboundBatch(batch, 504);
const state = await db.collection('admin_config').doc('telegram_state').get();
const stored = await Promise.all(batch.map(item => db.collection(INBOX_COLLECTION).doc(String(item.update_id)).get()));
check('receipt commits all inbox records', stored.every(snap => snap.exists));
check('checkpoint commits with the same atomic receipt', state.data()?.offset === 504, String(state.data()?.offset));
check('a crash after receipt leaves every record pending', stored.every(snap => snap.data()?.status === 'pending'));

let fail502 = true;
await processAvailableWork(25, async work => {
  if (work.claimedIds.includes(502) && fail502) {
    fail502 = false;
    throw new Error('injected processing failure');
  }
  return 'completed';
});
const afterFailure = await Promise.all(batch.map(item => db.collection(INBOX_COLLECTION).doc(String(item.update_id)).get()));
check('501 completes around a failed middle update', afterFailure[0].data()?.status === 'completed');
check('502 remains durable and retryable', afterFailure[1].data()?.status === 'retry');
check('503 completes instead of being lost behind 502', afterFailure[2].data()?.status === 'completed');

await db.collection(INBOX_COLLECTION).doc('502').update({ nextAttemptAtMs: Date.now() - 1 });
await processAvailableWork(25, async () => 'completed');
check('the failed middle update can later complete',
  (await db.collection(INBOX_COLLECTION).doc('502').get()).data()?.status === 'completed');

await persistInboundBatch(batch, 504);
check('replayed receipt does not regress a completed record',
  (await db.collection(INBOX_COLLECTION).doc('501').get()).data()?.status === 'completed');

console.log('\nIdempotent announcements and edit promotion');
const context = { stageId: 'stage_1', channel: getConfig().channels.stage_1! };
const normal = message(700, 'idempotent');
await ingestMessages([normal], context);
await ingestMessages([normal], context);
const normalId = telegramAnnouncementId(chatId, 700);
check('repeated delivery keeps one deterministic announcement',
  (await db.collection('announcements').doc(normalId).get()).exists);

const empty = message(701);
await ingestMessages([empty], context);
const emptyMapping = await db.collection('telegramMessages').doc(`n1001234567890_701`).get();
check('empty post is durably marked skipped', emptyMapping.data()?.announcementId === null);
await applyEdit({ ...empty, text: 'promoted by edit', edit_date: empty.date + 1 }, context);
check('an edited empty post is promoted to an announcement',
  (await db.collection('announcements').doc(telegramAnnouncementId(chatId, 701)).get()).exists);

console.log('\nAlbum persistence across receipt batches');
await persistInboundBatch([update(801, message(801, undefined, 'album-A'))], 802);
await persistInboundBatch([update(802, message(802, 'album caption', 'album-A'))], 803);
const albumSnap = await db.collection(ALBUM_COLLECTION).limit(1).get();
const albumRef = albumSnap.docs[0].ref;
await albumRef.update({ firstReceivedAtMs: Date.now() - 30_000, lastMemberAtMs: Date.now() - 3_000 });
await processAvailableWork();
const albumAnnouncement = await db.collection('announcements').doc(telegramAnnouncementId(chatId, 801)).get();
const albumMappings = await Promise.all([801, 802].map(id =>
  db.collection('telegramMessages').doc(`n1001234567890_${id}`).get()));
check('members split across polls create one album announcement', albumAnnouncement.exists);
check('every album member is mapped to the same announcement',
  albumMappings.every(snap => snap.data()?.announcementId === telegramAnnouncementId(chatId, 801)));
check('the mapping targets the member that actually carries the caption',
  albumMappings.every(snap => snap.data()?.captionMessageId === 802));

console.log('\nLease fencing');
await db.collection('admin_config').doc('telegram_state').set({
  lease: { instanceId: 'replacement', generation: 2 },
}, { merge: true });
let fenced = false;
try {
  await persistInboundBatch([update(900, message(900, 'must not persist'))], 901);
} catch {
  fenced = true;
}
check('an expired owner cannot persist with an old lease generation', fenced);
check('a fenced write creates no inbox record',
  !(await db.collection(INBOX_COLLECTION).doc('900').get()).exists);

unwatch();
await releaseLease();
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
