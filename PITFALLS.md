# Pitfalls

Terse log of bugs already fixed once. One line per entry: **what broke → the
rule that prevents it happening again**. Full "why" stays in CLAUDE.md where
a section is named; this file does not repeat it.

**Rules:**
1. After fixing any bug, append one entry here under the matching category
   (add a category if none fits) — before considering the fix done.
2. Before planning a feature, scan the categories it touches here. It's
   cheaper than re-reading CLAUDE.md end to end, and this is where the
   mistakes actually got made before.

Keep entries to one line. No prose, no rationale beyond the rule itself — if
it needs more than a line, it belongs in CLAUDE.md and this just points there.

## Auth & identity
- Master admin whitelist has 4 copies that can't share an import (rules have
  none, functions/ ships standalone, .mjs scripts) → any new source of truth
  must be checked by `test:masters`, never hand-added. [Master admins]
- `functions/index.js`'s `syncRole` rewrites the admin claim on *every*
  `users/{uid}` write → an address missing from any one of the 4 copies gets
  its claim silently stripped on the next profile save, not just denied once.
- Roster students use email-as-uid; Google sign-in uses opaque uid → the same
  human can hold two `users/` docs with separate state. Never assume one
  uid per person. [Two identity spaces]
- A new admin's `role` is decided by whichever screen creates their first
  `users/` doc (e.g. LoginScreen) → check every doc-creation path agrees with
  the whitelist, not just the read side.
- Native Google sign-in is keyed on **package + signing certificate**, not
  package alone → a debug install of `com.mohadaraty.app` fails with
  `No credentials available` while the release APK works, because only the
  upload key was registered. Register every keystore you install from, against
  the *current* package; a rename leaves the old SHA behind on the old app.
- Credential Manager reports the same `NoCredentialException` for "no Google
  account on this phone" and "this build isn't registered" → only the legacy
  `GoogleSignIn` retry distinguishes them (status 10 = DEVELOPER_ERROR), which
  is why `signInWithGoogleNative()` classifies from both attempts' messages.
- There is NO Firebase email/password account in this project: a staff-created
  account is `students/{id}` + a hashed password, and its Auth record is made by
  `signInWithCustomToken` with uid = that id and **no `email` property**. So
  Firebase cannot see that it and a Google identity are one person and
  `auth/account-exists-with-different-credential` never fires - the join is ours
  to make, in `students.googleEmail`. [Duplicate accounts]
- `NO_ACCOUNT` must offer to LINK an existing account before it offers signup.
  Routing straight to the signup form is not a dead end, it is a funnel: the
  student fills it in, a rep approves, and the duplicate is created by the app's
  own happy path.
- `examCode` is reissued every year → never match, merge or authenticate on it.
  It identifies a year's enrolment, not a person: matching misses a duplicate
  whose code rolled over AND fuses two students sharing a stale one. Use the
  folded `nameKey` (report only, a shared name is legitimate) or a structural
  join. Pinned by a negative test in `scripts/signup.test.ts`.
- A merge that folds only `users` is undone by the next sign-in - the losing
  `students` row is still live at the address it is keyed by. Retire it in place
  (`isActive:false` + `mergedInto`) and every lookup must FOLLOW that pointer
  BEFORE reading `isActive`, or the retired row is found first and reported as a
  disabled account. [Duplicate accounts]
- Deleting a secondary Firebase app does not delete the Auth USER its popup
  created - the record is project-wide. Discard it server-side, guarded on
  "owns no users doc AND is not the uid being signed in", because a master
  admin's Google uid IS their real account.

## Security rules
- A Firestore rule that branches `create` vs `update` on a ternary (e.g. by
  doc id) needs a test where the target doc does **not exist yet** — a test
  that always seeds the doc only ever exercises the update arm.
- A collection allowing student-write on create must never accept a client
  write with no ownership/scope field set — that's the bypass, not the field
  itself. Test the "create with the field omitted" case explicitly.
- Ownership on a field-keyed doc (e.g. `{uid}_{date}`) must be checked against
  a stored `uid` field, never parsed out of the doc id — an id containing the
  delimiter breaks a naive split.
- A collection meant to be Admin-SDK-only must be `write: if false` in rules,
  not `isAdmin()` — an authenticated admin *client* can still write through
  the second form.
- **Rules in the repo are not rules in production.** `npm run test:rules` runs
  against the local file and proves nothing about the deployed ruleset. Deploy
  (`firebase deploy --only firestore:rules,storage`) as part of shipping the
  feature, not as a later step.
- A collection with NO matching rule is denied by default, and the Admin SDK
  ignores rules — so a server-written collection looks perfectly healthy in the
  Firestore console while every client read fails. The symptom is an empty UI
  that survives a refresh, and it reads as a client bug. Check the DEPLOYED
  rules for the collection before debugging the client.
- A server-written AUDIT trail needs a rule too. `streakLog/{uid}/days/{date}`
  had no match block, so the Admin SDK filled it every day and the very screens
  meant to settle a dispute could not read a line of it.
- Anything a deletion request is meant to erase must be hunted for in
  SUBCOLLECTIONS: deleting `users/{uid}` leaves `users/{uid}/...` and any
  `other/{uid}/...` fully intact.
- A permission-denied `onSnapshot` is not inert: the backend rejects the target
  and the client re-adds it, which is its own source of watch-stream target
  churn. Rule out a missing rule before blaming the SDK.

## Data model & consistency
- A DENORMALISED field (e.g. `userMCQStats.stageId`, a copy of `users.stageId`
  so a board can be filtered without reading every user) must be rewritten by
  EVERY path that changes the source. `stagePromotion` re-filed it, the
  self-service `progressionSubmit` did not → promoted students vanished from
  their new stage's MCQ board while the streak board, which reads `users/`
  directly, still showed them. Every document involved looks healthy alone.
- `batch.update()` on a document that may not exist fails the WHOLE batch -
  guard with an existence check (or use `set(..., {merge:true})`), or an
  unrelated missing row takes the primary write down with it.
- A re-key that recovers a field by splitting a doc id (`{uid}_{date}`) is
  wrong wherever the uid can be an email: put the delete INSIDE the guard that
  checks the split worked, or a row that fails to split is destroyed without
  ever being copied. Prefer the stored field over the id.
- A multi-collection operation that cannot be transactional (account merge)
  needs an audit row written BEFORE it starts and closed after, or a crash
  halfway is indistinguishable from one that never ran - and it must be
  idempotent, because the retry is the whole point of noticing.
- Two payment rails on one account means no expiry path may CLEAR the access
  cache — it must recompute `max(endDate)` over the rows that remain, or
  expiring one revokes access the other was paid for.
- An external subscription's expiry belongs to the store that sells it: apply
  it, never stack a local duration onto it, or the row drifts a little further
  from the truth at every renewal.
- An auto-renewing subscription is ONE row updated in place, not a row per
  period — a row per renewal makes a per-person breakdown count the same
  person once a month.
- Revenue in a second currency does not belong in a single-currency total;
  store 0 and show the count alone rather than a converted figure nobody can
  reconcile against the provider's own report.
- A denormalized counter/aggregate written by two different code paths
  (season-end archives, streak resets, etc.) will diverge unless *both*
  writes come from one in-memory pass — if they can't, add an audit script,
  don't trust "they should agree".
- A field meant to be permanent (e.g. an all-time record) must be excluded
  by name from any bulk "reset" patch, and every path that raises the
  season field must also raise the permanent one — grep all writers when
  adding either.
- Combined/joined entities transcribed from a source doc (a timetable, a
  schedule) are not automatically deletable/splittable data — build a
  reviewed split flow, not a one-shot bulk script, and hide (don't delete)
  the original so nothing is left pointing at a missing id.
- A board/leaderboard scoped by "the stage played in" must never fall back to
  the *viewer's current* stage on a missing field — that silently collapses
  a whole cohort to one row.
- A parser heuristic that disambiguates a SHORTHAND value must not also fire
  on the explicit one — reading a bare "2" on a timetable as 14:00 is right,
  rewriting a written "07:00" to 19:00 is not; key the rule on the written
  form (zero-padding, separators), not on the parsed number alone.
- "Applies to everyone" must be stored as its own value (an empty audience),
  never as an expanded list of every current member — the list is a snapshot
  that silently stops covering anyone added later, and the symptom is an empty
  screen that reads as "nothing scheduled" rather than as a bug.
- A "paused period doesn't break the streak" rule must be scoped to pauses
  INSIDE a season. Before the first term of a calendar every day is paused, so
  the same helper reported a gap of one from *last June* into opening day and
  incremented a stale counter — one student opened the season on 2 while
  everyone else was on 1. Test the boundary with a date months before it, not
  just yesterday.
- Every "close the season" path needs a matching "open the season" path. A
  close keyed on "a term whose end has passed" can never fire for the FIRST
  term of a calendar, so nothing zeroed what accounts carried into the new
  year. Give the open its own idempotency marker alongside the close's.
- A bulk reset that ships mid-season must key on evidence of staleness (a last
  activity date older than the term) and not just "has a non-zero counter" —
  the blanket version wipes the day every student legitimately earned.
- When AI output needs human review before it goes live, give the draft and
  the published copy SEPARATE documents — one document plus a status field
  makes "a failed re-run must not disturb what is live" a rule every write
  path has to remember, instead of something the schema guarantees.
- A repair keyed on STALENESS cannot see the rows the bug already freshened.
  The same write that inflated the counter moved `lastActiveDate` onto the new
  term, so the "this belongs to the current season" test skips exactly the
  accounts that were damaged. Ship the second selector with the first, keyed on
  the year's opening day — the one date on which the counter is provably capped.
- A repair that clears `lastActiveDate` must not touch a row that already holds
  today's credit marker: record-activity returns early on that marker, so
  nothing recomputes until tomorrow and the row reads 0 for the rest of the day
  it earned. Clamp to 1 and keep the date. This is also the fix for the race
  between a bulk scan and a student visiting mid-run.
- A "reset to a fresh season" rule scoped to a TERM boundary wipes the streak a
  break is supposed to preserve. Scope it to `terms[0].startDate` — the year's
  opening — and pin the term-2 case, or the second term silently becomes a
  second reset.
- Lowering a per-season peak (`longestStreak`) is not optional when you lower
  the counter: the board prints `max(longestStreak, streakCount)`, so a clamped
  row still advertises the wrong number.

## Offline & Firestore sync
- `getDoc` rejects offline-not-cached; `getDocs` resolves empty; `onSnapshot`
  fires `exists()===false` — these are three different signals, never treat
  a catch or an empty/missing read as "record deleted" without checking
  `snapshot.metadata.fromCache`.
- Never call `signOut` from a catch block on a Firestore read error — offline
  reconnect can't recover from it and login refuses to submit offline. Use
  `isTransientNetworkError()` instead.
- A write that seeds defaults on "collection is empty" must be guarded on
  `!snapshot.metadata.fromCache`, or an offline empty-cache read wipes real
  data on reconnect.
- Don't `await` a `setDoc`/write in a boot-critical path — it doesn't settle
  until the server acks, so it hangs forever offline.
- A cache keyed by a mutable field (e.g. `pdfUrl` that changes on re-upload)
  serves stale data forever after that field changes — key by a stable id, or
  plan the migration up front, don't patch around it later.
- `snapshot.exists()` is a TYPE PREDICATE: reading any field after
  `!snap.exists()` narrows the snapshot to `never` and fails the build. Put the
  `metadata.fromCache` check FIRST in that guard, not second.
- TWO `onSnapshot` listeners on the SAME document (e.g. a parent screen and a
  modal it opens) crash the SDK with `INTERNAL ASSERTION FAILED: Unexpected
  state (ID: ca9/b815)`, `ve: -1` — overlapping targets on one key drive the
  watch stream's pendingResponses negative, and StrictMode doubles every
  subscribe/unsubscribe cycle. One listener per document; pass the data down as
  a prop. The stack points into the SDK, never at the duplicate.
- A `getDoc` on a document that already has a live `onSnapshot` opens a second
  one-shot target on the same key and trips the same assertion — read the value
  from the listener's state instead (pass it in as an argument).
- `INTERNAL ASSERTION FAILED: Unexpected state (ca9/b815)` with `ve: -1` is a
  KNOWN SDK bug (firebase-js-sdk #9267), fixed by PR #9985 in
  `@firebase/firestore` 4.15.0 / `firebase` 12.14.0. Before blaming app code,
  check the installed version against the fix: `grep -c ensureTargetState
  node_modules/@firebase/firestore/dist/*` returns >0 on a pre-fix build and 0
  on a fixed one. No app-level change can work around a negative counter inside
  the SDK's own watch bookkeeping.
- After upgrading any dep that Vite pre-bundles, delete `node_modules/.vite`.
  The dev server keeps serving the old optimized copy (`?v=<hash>` in the stack
  trace), so a real fix looks like it changed nothing.
- When a dead listener leaves the UI empty, the screen lies by omission: it
  showed "59 parsed" above an empty list. If a server call reports storing N
  rows and the listener has delivered none seconds later, say so and offer a
  reload — "nothing happened" is the least actionable failure there is.

## Billing & metering (any metered AI feature)
- Any refund/credit path triggered by output the model produces (e.g. an
  off-topic refusal) must be capped per-day — the model already saw the full
  billed input before declining, so an uncapped refund is a free-spend hole.
- Prompt-cache eligibility depends on a byte-identical prefix — never inject
  per-user data (name, variable content) into the cached system prompt; put
  it in the final turn instead, or every user gets a different prefix.
- A model swap must update its price/weight constants in the same commit —
  a stale weight silently desyncs the budget meter from the real invoice.
- Concurrent requests against one budget need a transactional
  reserve→stream→reconcile, not a read-then-write balance check — otherwise
  N parallel requests each read the same starting balance.
- Don't trust a vendor's documented per-unit cost over a measured one on real
  traffic — pin the measured constant with a test and a comment citing the
  measurement, not the doc.

## Gemini / external LLM API quirks
- `minItems`/`maxItems` in a nested JSON response schema can make the API
  reject *every* call with 400 before reading any input — cut the bounds from
  the schema and enforce them in application code instead.
- A generic/catch-all error classifier must not swallow a structural error
  (e.g. `INVALID_ARGUMENT`) into the same bucket as a user-caused one — it
  needs its own alerting path, because nothing the caller did can cause it.
- A citation/marker regex that matches `[[p:N]]` must also accept a
  comma-separated list (`[[p:7, 8]]`) if the model can emit one — test both
  shapes, not just the single-value case.
- A retry cap must NOT count transient provider failures. Gemini answers a
  demand spike with `503 UNAVAILABLE` ("please try again later"); three of
  those burned a whole 3-strike budget and then told the user their image was
  unreadable. Classify transient (503/UNAVAILABLE/overloaded/500/socket) apart
  from `error`, retry it with backoff inside the request, and charge only
  input-caused failures against the cap.
- Any counter that BLOCKS an action needs a reset path the user can actually
  reach, and the error message must name a remedy that really resets it —
  "upload a clearer image" was a dead end because only a successful parse
  cleared the count, which was the one thing that could not happen.

## Dual API surfaces
- `server.ts` and `api/index.ts` drift in handler BODIES long after their route
  LISTS agree — a path-set diff reports parity while production quietly carries
  a feature dev has never run (and vice versa). Extract the handlers into a
  `createXHandlers(deps)` factory in `shared/` and mount them from both; leave
  only `verifyAuth`/`verifyAdmin` per-surface.
- A config flag that is READ by one surface and WRITTEN by nothing in the repo
  is not dead code, it is an unguarded back-door — anyone who can write the
  settings document can flip behaviour the codebase never exercises. Delete it
  or wire it up; do not leave it readable.
- A cron route guarded by `header !== SECRET && SECRET` fails OPEN when the
  secret is unset. Fail closed on a missing secret, the way the destructive
  routes already do.
- A webhook needing the RAW body takes the `verify` hook on the existing
  global `express.json()`, never a path-mounted `express.raw()` — the latter's
  ordering has to be reproduced identically in both route files, which is the
  drift this section exists about.
- A webhook sender is not a Firebase user and holds no ID token; authenticate
  it with a shared header (+ HMAC) verified inside the handler, and never
  reach for `verifyAuth` on that route.

## Env, secrets & config
- A PEM/secret pasted into a single-line hosting-panel field arrives
  double-escaped, quoted, or whitespace-collapsed more often than clean —
  normalize defensively (strip quotes, collapse escape runs, rebuild line
  wrapping from structure) with a named error, don't trust one `.replace()`.
- Prefer accepting a whole secrets blob (e.g. the full service-account JSON)
  over N separate single-line variables when the platform allows it — one
  parse point beats one mangling point per field.
- A `process.env.X` fallback in client code is dead: `process` doesn't exist
  in a browser bundle, so the branch silently never runs — don't add a
  "works either way" fallback across a client/server boundary without
  verifying the client branch is even reachable.
- A stale deployed client can keep failing with an old error message long
  after the server-side fix ships — give server writes a marker (a new field,
  a version stamp) so "still failing" can be told apart from "old client".
- `JSON.parse` reports the SAME `position 1` for an escaped blob, single
  quotes, unquoted keys, a literal \n, typographic quotes and a value cut off
  after `{` - so surfacing the parse error as the diagnosis names nothing and
  sends the operator to re-paste a value that may already be correct. Name the
  shape yourself (length, does it close, first character, which quote) and
  print a key-redacted sketch of what arrived.
- Stripping the quotes off a JSON *string literal* is not the same as parsing
  it: `unquote()`-then-parse turns a recoverable double-encoded blob into
  `{\"project_id...`, which can never parse. Try `JSON.parse` on the raw value
  FIRST, and if it yields a string, parse that string again.
- Prefer base64 for a secret that must cross a single-line panel field. Quote,
  backslash, newline and typographic quote are the only characters these
  fields damage, and base64 contains none of them - repair logic handles the
  damage, base64 removes the opportunity.
- An ignore rule keyed to an extension (`*serviceAccount*.json`) does not cover
  the same secret written under a new one (`.b64.txt`) - widen the pattern in
  the commit that adds the file, and check the widened glob does not also
  swallow a source file of that name.
- `fetch` rejects with `TypeError: fetch failed` and puts the real failure in
  `.cause` (sometimes inside an `AggregateError` one level further) - an error
  logger that reads only `.message` records that something network-shaped
  happened and nothing about what, so DNS, a blocked host and a transient blip
  all look identical. Walk the cause chain and log `code`/`syscall`/`hostname`.
- Retry predicates keyed to an application error class silently exclude
  transport failures: a `TypeError: fetch failed` is not a `TelegramApiError`,
  so it fell through a catch that retried 429s and 5xx and got no retry at all.
  Classify network failures separately from request failures - and never retry
  a 401, which fails identically forever.
- `fetch` has no default timeout. A connection that is accepted and then
  ignored hangs the caller forever, which at boot is worse than a crash because
  nothing restarts it. Pass an `AbortSignal.timeout`, and derive it from the
  request for a long poll rather than using one global value.
- A panel host that aborts automatic restarts for a crash inside the first
  minute turns any fast boot failure into a permanently dead container. Make
  transient failures wait rather than exit, and keep exiting fast for permanent
  ones - a container restarting every 70s forever hides the message that says
  what is actually wrong.
- Two HTTP statuses from one API can mean opposite things about the same
  variable: Telegram answers a MALFORMED bot token with 404 and a REVOKED one
  with 401, and neither status says so. Validate the credential's shape locally
  so the "damaged in the panel" case never reaches the wire, and translate the
  remaining status into the actual remedy.
- Log a fingerprint of every credential, not just the one that already has one
  - the bot id plus four characters is enough to answer "is the panel even
  holding the token I think it is", which no error from the far end can.
- A redaction list keyed to field NAMES will silently swallow a value that was
  designed to be safe to log: `botToken: <fingerprint>` became
  `botTokenRedacted: true`. Name deliberately-safe fields differently
  (`botTokenFingerprint`), rather than loosening the list.

## Layout, RTL & safe area
- A screen must not add its own bottom padding (`pb-*`) if the app root
  already reserves clearance for chrome (nav bar, safe area) — it stacks and
  leaves a dead gap, it doesn't correct for anything.
- `sticky top-0` inside a screen is measured from the viewport, not from a
  padded ancestor — if the root absorbs a safe-area inset, the sticky offset
  must repeat it explicitly.
- Inheriting the app's RTL direction into a canvas/text-overlay pair (PDF
  viewers, anything using `getClientRects()`) shifts bidi run splitting and
  desyncs the overlay from the canvas — pin `dir="ltr"` on that subtree.
- An overlay/drawer that must support pinch-zoom or transform-based gestures
  on a sibling element must stay a DOM sibling, not a child — a child's
  transform becomes the sibling's containing block.

- A cross-platform push plugin returns a DIFFERENT KIND of token per platform:
  `@capacitor/push-notifications` yields an FCM token on Android and a raw APNs
  token on iOS. Publishing the iOS one to a per-user `fcm_tokens/{uid}` doc
  overwrites the working Android token, and the sender's prune-on-failure then
  DELETES it - so adding a platform silently removes notifications from a device
  that had them. Gate the publish on `Capacitor.getPlatform()`.
- `ITSAppUsesNonExemptEncryption` absent from Info.plist stalls EVERY TestFlight
  upload on a manual export-compliance prompt, which defeats an automated
  pipeline without failing it.

## Store compliance (Play / App Store)
- A build-time UI exclusion (aliasing a screen to a stub) is necessary but
  not sufficient for "no purchase surface in this build" — a scanner that
  only checks gateway names/currency codes won't catch a purchase-shaped
  screen with access-only wording; review the copy too.
- Hidden/dead UI still ships inside the compiled artifact — verify by
  scanning the built output, not just by confirming the runtime guard exists.
- One boolean cannot mean both "inside an app binary" and "may not sell" —
  Play forbids selling, Apple requires it, so a second store target splits
  every runtime `IS_STORE_BUILD` check into those two meanings. Getting it
  wrong hides the paywall from the build that is obliged to have one.
- A `manualChunks` entry that names a dependency creates that chunk even
  where the dependency is tree-shaken away, and Rollup then fills the empty
  chunk with shared runtime — so a scanner exemption keyed to the chunk NAME
  silently starts excusing unrelated code. Gate the chunk on the same build
  condition as the dependency.
- A scanner exemption must be per-RULE, not per-file: exempting the legal
  pages because a privacy policy may name a processor also exempted them from
  every other rule.
- A pattern that catches the seller's contact link catches the SUPPORT team's
  too — same `t.me/` / `wa.me/` literals, opposite legitimacy. Pin the
  legitimate one into its own chunk rather than weakening the rule.
- The privacy policy's processor list is per-platform once the platforms
  differ; a policy still saying "the app contains no payment flow" after one
  of them gained one is both false and an App Store rejection.

## Tooling & test coverage
- `tsc --noEmit` on a large codebase can hit the default V8 heap and exit
  134 (OOM) — that looks like a hang/crash, not a type error; give it a
  larger `--max-old-space-size` rather than debugging the "failure".
- A test that reads wall-clock "today" and asserts a phase silently expires on
  the date it was written around — this suite's "the holiday keeps the app
  paused" started failing the morning term 1 opened, which is the one day the
  season actually starts. Pin the fixture to explicit dates.
- When a shared predicate function is added to replace N duplicated copies,
  the bug that made the copies inconsistent is usually in what *feeds* the
  predicate, not the predicate itself — test the input-hydration site
  (e.g. does the listener projection actually copy every field the
  predicate reads?) as its own check, not just the predicate's logic.
- A test suite for a mirrored/duplicated script (`bot/` importing shared
  logic) needs its own `npm test` wiring checked — a new test file sitting
  next to old ones doesn't run unless the script/CI list is updated.
- `@types/react` is absent, so JSX gives `key` no special handling on a typed
  component — a props interface must declare `key?: string` or every
  `.map()` render site fails `tsc`. See `LectureCardProps`.
- An Xcode scheme Xcode created for you is NOT in the repo: it is written to
  `xcuserdata/`, which `ios/.gitignore` excludes, so it exists on the machine
  that opened the project and nowhere else. `xcode-project build-ipa --scheme App`
  on a fresh CI clone then fails with "scheme not found" — a failure that cannot
  reproduce locally, because locally the file is there. Commit
  `App.xcodeproj/xcshareddata/xcschemes/App.xcscheme`.
- `CURRENT_PROJECT_VERSION` checked in as a literal `1` uploads to TestFlight
  exactly once; the second build is rejected for reusing a build number, after
  the archive has already been paid for. Stamp it in CI. `agvtool` is the usual
  answer and is the wrong one here — this project never sets
  `VERSIONING_SYSTEM = apple-generic`, so agvtool rewrites the Info.plist
  literal instead of the build setting `$(CURRENT_PROJECT_VERSION)` that
  Info.plist actually interpolates.
- The compliance gate scans a directory the build produces
  (`ios/App/App/public`, written by `cap sync`), so a CI pipeline that orders it
  before the sync scans nothing. `assert-no-payment-surface.mjs` exits 1 on a
  missing directory rather than reporting zero violations, which is the only
  reason a mis-ordered pipeline fails loudly instead of passing vacuously —
  keep that arm if the script is ever rewritten, and do not add a redundant
  existence check in the pipeline that shadows its error message.
- A build-time key read through `import.meta.env` that the code only
  `console.warn`s about when missing (`src/lib/iap.ts`) produces a SUCCESSFUL
  build and a broken app — Vite inlines the value, so there is no runtime
  recovery and no failing test. Assert the variable in CI before the build, not
  after it.
- Dropping `GoogleService-Info.plist` into `ios/App/App/` is NOT enough. The
  Capacitor project is `objectVersion = 48` with no
  `PBXFileSystemSynchronizedRootGroup`, so it is a classic Xcode project:
  on-disk presence does nothing, and a resource absent from the
  `PBXResourcesBuildPhase` is simply absent from the `.ipa`. `cap sync` does not
  add it either. The file needs a `PBXFileReference`, a `PBXBuildFile`, an entry
  in the App group's children, and one in the Resources phase — four edits, or
  Firebase aborts at launch. Folder-synchronisation advice written for modern
  Xcode projects does not apply here.
- `ios/App/App.xcodeproj/project.pbxproj` is checked out **CRLF** on Windows,
  so any anchor-based edit written with `\n` silently matches nothing. Detect
  the file's own ending and insert with it, and make the script refuse rather
  than guess when the anchor is absent — a half-applied pbxproj edit is far more
  expensive than a failed one.
- Pinning a fixture to the wall clock is not enough when the code under test
  applies a GRACE WINDOW: `streak.test.ts` opened its term on the Baghdad date
  while record-activity was still crediting yesterday, so every run between
  00:00 and 02:00 resolved to preseason and all ten assertions read `undefined`
  off a response that was never written. Derive fixture dates from the same
  helper the handler uses, and derive "yesterday" from that, not from `Date.now`.
- An index-drift checker that treats "no `orderBy`" as "no composite index
  needed" misses the commonest count-query shape: two equality filters plus one
  inequality DOES need one. Ours reported a clean bill while three indexes were
  missing in production, including the one behind `expireSubscriptions`.
- A `getCountFromServer` for a "what is my rank" row belongs in its own
  try/catch. Sharing the board's catch means one missing index throws away the
  twenty rows already fetched, and the screen reads "no students in this stage"
  rather than "rank unavailable".
