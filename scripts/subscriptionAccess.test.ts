/**
 * The subscription access gate, and the thing that actually broke it.
 *
 * A paying student was shown "لا يوجد اشتراك فعال" on their profile and the
 * paywall on the question bank, while Simosan - the one paid feature gated on
 * the server - worked. The predicate was never wrong. src/App.tsx builds its
 * UserProfile as an explicit field-by-field projection of `users/{uid}` and
 * omitted isSubscribed / subscriptionEnd / subscriptionPlan, so the client's
 * copy of the rule was evaluating undefined for every account in the app.
 *
 * So this checks two separate things, and the second is the one that matters:
 * deduplicating the predicate would NOT have caught the bug, because the bug
 * was in what feeds it.
 *
 *   npx tsx scripts/subscriptionAccess.test.ts     (no emulator, no network)
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  SUBSCRIPTION_PROFILE_FIELDS,
  hasLiveSubscription,
  hasSubscriptionAccess,
} from '../shared/subscriptionAccess';

let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); failed++; }
};

const root = join(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

/**
 * Is `field` declared as a property in this block - at the start of a line,
 * so a mention of the name in a comment does not count as hydrating it.
 */
const declaresField = (block: string, field: string) =>
  block.split(/\r?\n/).some(line => line.trim().startsWith(field + ':'));

const past = new Date('2020-01-01');
const future = new Date('2099-01-01');
/** What the Firestore SDKs actually hand back. */
const stamp = (d: Date) => ({ toDate: () => d });

console.log('\nhasLiveSubscription - is there a live paid subscription');
check('no user', !hasLiveSubscription(null) && !hasLiveSubscription(undefined));
check('plain student', !hasLiveSubscription({ role: 'student' }));
check('subscribed, end in the future',
  hasLiveSubscription({ isSubscribed: true, subscriptionEnd: stamp(future) }));
check('subscribed, end in the past',
  !hasLiveSubscription({ isSubscribed: true, subscriptionEnd: stamp(past) }));
check('subscribed, open-ended', hasLiveSubscription({ isSubscribed: true }));
check('a Date works as well as a Timestamp',
  hasLiveSubscription({ isSubscribed: true, subscriptionEnd: future }));
check('an ISO string works as well as a Timestamp',
  hasLiveSubscription({ isSubscribed: true, subscriptionEnd: future.toISOString() }));
check('isSubscribed false beats a future end date',
  !hasLiveSubscription({ isSubscribed: false, subscriptionEnd: stamp(future) }));
// Staff have access; they have not bought anything. A SUBSCRIBED crown on a
// representative's profile would be a false claim about their account.
check('an admin is NOT a subscriber', !hasLiveSubscription({ role: 'admin' }));
check('a master admin is NOT a subscriber', !hasLiveSubscription({ isMasterAdmin: true }));

console.log('\nhasSubscriptionAccess - may this account use paid features');
check('no user', !hasSubscriptionAccess(null));
check('plain student', !hasSubscriptionAccess({ role: 'student' }));
check('admin', hasSubscriptionAccess({ role: 'admin' }));
check('master admin', hasSubscriptionAccess({ isMasterAdmin: true }));
check('subscribed, end in the future',
  hasSubscriptionAccess({ isSubscribed: true, subscriptionEnd: stamp(future) }));
check('subscribed, end in the past',
  !hasSubscriptionAccess({ isSubscribed: true, subscriptionEnd: stamp(past) }));
check('subscribed, open-ended', hasSubscriptionAccess({ isSubscribed: true }));
check('the injected clock is honoured',
  hasSubscriptionAccess({ isSubscribed: true, subscriptionEnd: stamp(past) },
    new Date('2019-01-01')));

/* ------------------------------------------------------------------ *
 * The regression guard
 * ------------------------------------------------------------------ */

console.log('\nsrc/App.tsx hydrates what the gate reads');

const appSrc = read('src/App.tsx');

/**
 * The users/{uid} listener's setUser({...}) - the first one after the
 * onSnapshot, which is the `userDoc.exists()` branch. Isolated by brace
 * matching rather than a line range so it survives edits above it.
 */
const listenerAt = appSrc.indexOf("onSnapshot(doc(db, 'users'");
const openAt = appSrc.indexOf('setUser({', listenerAt);
let projection = '';
if (listenerAt !== -1 && openAt !== -1) {
  const start = appSrc.indexOf('{', openAt);
  let depth = 0;
  for (let i = start; i < appSrc.length; i++) {
    if (appSrc[i] === '{') depth++;
    else if (appSrc[i] === '}' && --depth === 0) { projection = appSrc.slice(start, i + 1); break; }
  }
}

check('the users/{uid} listener and its setUser projection were found',
  listenerAt !== -1 && projection.length > 0);

// A later refactor to `...userDoc.data()` would fix the bug a different way,
// so accept that too rather than failing on a correct rewrite.
const spreads = /\.\.\.\s*userDoc\.data\(\)/.test(projection);
for (const field of SUBSCRIPTION_PROFILE_FIELDS) {
  check(`the profile carries ${field}`,
    spreads || declaresField(projection, field),
    'the client gate reads it and would evaluate undefined without it');
}

console.log('\nOne predicate, not three copies');

check('src/App.tsx imports the shared predicate',
  /from ['"][^'"]*shared\/subscriptionAccess['"]/.test(appSrc));
check('src/App.tsx no longer re-implements the expiry comparison',
  !/subscriptionEnd\.toDate \? /.test(appSrc.slice(appSrc.indexOf('hasMCQAccess'))));
check('shared/simosan.ts delegates to it',
  /from ['"]\.\/subscriptionAccess\.js['"]/.test(read('shared/simosan.ts')));
check('ProfileScreen uses it rather than bare isSubscribed',
  !/user\.isSubscribed/.test(read('src/components/ProfileScreen.tsx')));
check('the store-build access row uses it too',
  !/user\?\.isSubscribed/.test(read('src/native-stubs/SubscriptionScreen.tsx')));

console.log('\nThe writer agrees with the readers');

// activateSubscription is the single grant path; every field the gate reads has
// to be one it actually sets, or the gate is reading something nothing writes.
const grant = read('shared/subscriptions.ts');
const grantBlock = grant.slice(grant.indexOf("db.collection('users')"));
for (const field of SUBSCRIPTION_PROFILE_FIELDS) {
  check(`activateSubscription writes ${field}`,
    declaresField(grantBlock.slice(0, 400), field));
}

// Extending a subscription the nightly sweep already cleared has to restore the
// flag, not just push the date out.
for (const surface of ['server.ts', 'api/index.ts']) {
  const src = read(surface);
  const extendAt = src.indexOf("app.post('/api/subscriptions/:id/extend'");
  const body = extendAt === -1 ? '' : src.slice(extendAt, extendAt + 1800);
  check(`${surface}'s extend route restores isSubscribed`,
    /isSubscribed:\s*true/.test(body));
}

console.log(failed === 0 ? '\nAll subscription-access checks passed.\n' : `\n${failed} check(s) FAILED.\n`);
process.exit(failed === 0 ? 0 : 1);
