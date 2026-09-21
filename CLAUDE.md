# MyLecture

## Pitfalls log

`PITFALLS.md` is a terse, categorized log of bugs already fixed once — one
line each: what broke, and the rule that prevents it recurring. Two standing
rules, from the file itself but worth repeating here since this is the file
that's always loaded:

- **After fixing any bug**, append one line to `PITFALLS.md` under the
  matching category before calling the fix done.
- **Before writing a feature plan**, scan the categories in `PITFALLS.md`
  that the feature touches — it's the fast, cheap check; this file is the
  slow, thorough one.

## Architecture: the dual API surface

`server.ts` is the **dev** server, run via `npm run dev` (tsx). `api/index.ts` is
what actually serves **production** — `vercel.json` rewrites `/api/*` to it.

They used to disagree by 14 routes. **They now carry the same 66 paths**
(`/api/google-claim` was the most recent addition to both), and the only
difference left is server.ts's `"*"` SPA catch-all, which Vercel does not need. Re-check with

    grep -oE "app\.(get|post|put|delete|patch|all)\(\s*[\"'\`][^\"'\`]*" server.ts

against the same over `api/index.ts` before trusting that number again.

**A change to one needs the same change to the other.** Always check both before
concluding a route does or does not exist.

**A matching path list does not mean matching behaviour.** The ten streak routes
kept identical paths while their bodies drifted badly - production grew a
`globalFreeze` gap-skip and a `streakLog` audit trail dev never had, dev grew a
recovery push production never sent, and the two computed the same "effective
date" by different means. They now live in `shared/streakApi.ts` behind
`createStreakHandlers()`, mounted as one line each from both files, the way
`shared/simosanApi.ts` already does it. Prefer that to copying a handler.

## Rules in the repo are not rules in production

`npm run test:rules` runs the emulator against the **local** `firestore.rules`. It
passes 240 assertions and proves nothing about what is deployed. The two drifted
far enough apart that production was missing `isSupport()`, the narrowed
`settings/{docId}`, the subscription-ledger tightening, storage's
`payment_receipts/` block — and both timetable collections.

That last one is the shape to remember: **Firestore denies a path with no
matching rule, and the Admin SDK ignores rules entirely.** So the server wrote
59 timetable sessions successfully while every client read of them was refused.
The data sits in the console looking perfectly healthy, the app shows nothing,
and a refresh does not help — it reads as a client bug and is not one.

    npm run check:rules      # scripts/checkRulesDeployed.mjs

Compares the deployed rulesets (Firebase Rules REST API, same FIREBASE_*
service-account credentials the other scripts use) against both local files, and
reports **missing `match` blocks first** because that is the failure that denies
rather than merely misgrants. Exits 1 on drift, and also on missing credentials
or an unreachable API — a check that passes when it could not check is worse
than no check. Deploy with:

    npx -y firebase-tools@13 deploy --only firestore:rules,storage --project mylectures-app

## Knowledge graph

A Graphify code graph lives in `graphify-out/` (gitignored, regenerable) and is
mirrored as an Obsidian vault at:

    C:\Users\Laith\Documents\ObsidianVaults\MyLecture

Prefer `graphify query` / `explain` / `affected` over bulk-reading large files.

### What the graph does NOT contain

The graph is built from tree-sitter AST symbols: functions, types, imports, calls.
**String literals are not nodes.** Express route paths like `/api/admin/announcements`
do not appear in `graph.json` at all — verified, zero matches. For route-level
questions use grep on `server.ts` and `api/index.ts` directly; the graph cannot
answer them. The graph is for symbol-level structure: who calls what, what depends
on a type, which modules cluster together.

Firestore rules (`firestore.rules`, `storage.rules`) are also not indexed — Graphify
does not classify them as code.

### Hot files (bulk-read only when necessary)

| File | Lines |
| --- | --- |
| `server.ts` | 1922 |
| `src/components/StudentManagement.tsx` | 1450 |
| `api/index.ts` | 1159 |

### Architectural hubs

`Language` / `TRANSLATIONS` (`src/types.ts`) are the single most connected nodes
(70 and 33 edges) — i18n is woven through the whole component tree. `UserProfile`
(56), `db` (42) and `useStageContext()` (41) follow. `useStageContext()` has 20
direct callers, which matters for the in-flight stage-isolation work.

### Regenerate

```powershell
graphify update .                        # AST-only, no API cost
node scripts/graphifyToObsidian.mjs      # refresh the Obsidian vault
```

Communities are unnamed (`Community 0`-`Community 59`) because naming requires an
LLM call; the graph was built code-only and fully offline.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## In-app PDF reader

`src/components/pdf/` renders lecture PDFs inside the app with highlighting and
notes. Two decisions there are expensive to reverse, so they are recorded here.

**Anchoring** (`src/lib/pdfAnchor.ts` — pure, unit-tested via `npm run test:anchor`).
A highlight stores three redundant locators: canonical character offsets, a W3C
TextQuoteSelector (`exact`/`prefix`/`suffix`), and quads in **PDF user space**.
Resolution tries them in that order. Never store pixel coordinates — quads are
projected through the current viewport, which is what makes highlights survive
zoom and rotation. `canonicalizePage()` normalizes per item, never across items,
so an item's length cannot depend on its neighbours; changing it means bumping
`ANCHOR_ALGO`, which demotes existing anchors to the quote-repair path rather
than silently misplacing them. An annotation that cannot be located is marked
orphaned **in memory only** and surfaced in the notes drawer — never deleted.

**Storage is IndexedDB** (`src/lib/localDb.ts`, db `mylecture-local`), not
localStorage, and device-only — annotations never reach Firestore. localStorage
is one ~5MB origin-wide quota that `mcq_cache_${lectureId}` already fills
unboundedly, and `setItem` throws synchronously, so overflow would break MCQ
caching app-wide rather than merely failing to save a note.

**Downloaded PDF bytes moved into that same IndexedDB.** They cannot live in
CacheStorage: `vite.config.ts` sets `selfDestroying: mode === 'native'`, and that
worker's activate handler deletes *every* cache with no allowlist while
`registerSW.js` re-registers it on every page load — so offline downloads were
being wiped on each launch. IndexedDB is untouched by it.

The page wrapper, canvas and text layer are pinned `dir="ltr"`. The app shell is
RTL, and an inherited RTL direction changes bidi run splitting inside pdf.js's
absolutely-positioned spans, shifting `getClientRects()` and putting every
highlight in the wrong place.

## Subjects: the curriculum is not the timetable

`scripts/migrateToStages.js` seeds the `subjects` collection from the college
curriculum. The college's own timetable prints two subjects on one line when they
share a slot - `Physiology I + Computer Science`, `Baathist crimes + Arabic
Language` - and the first seed transcribed those lines verbatim. Each pair then
had one card, one lecture folder and one progress bar, so a physiology lecture and
a computer-science lecture landed in the same place and neither subject could be
tracked alone.

The seed is fixed. A database already seeded from it is repaired from المواد - a
flagged row warns, and its split button opens `SplitSubjectDialog`, which names
the parts and asks per lecture/recording which one it belongs to. That is the
only repair path; there is deliberately no standalone bulk script for this -
splitting is a judgment call about *where content goes*, not a mechanical
transform, and a one-shot admin-SDK script is exactly the kind of file this repo
avoids accumulating. A live-database fix instead runs the same client logic
directly (`src/lib/subjectSplit.ts`) against Firestore under admin credentials.

**Only `+` splits a name.** `and` / `و` do not: `Pharmaceutical and Cosmetic
Preparations` (المستحضرات الصيدلانية والتجميلية) is one subject whose name happens
to read as a conjunction, and splitting it would invent a subject the college does
not teach and move real lectures into it. The rule lives in `src/lib/subjectSplit.ts`
and is pinned by `npm run test:subjects`.

A split **hides** the combined document (`isActive: false`) rather than deleting
it. Content the splitter could not see would otherwise be left with a `subjectId`
pointing at nothing, which is invisible rather than merely misfiled.

## No app header

There is no `Navbar`. Search and the staff upload button live on the Study screen
they act on; theme, language, the notification inbox and the master admin's stage
picker live in Settings. Two consequences worth knowing before you add a screen:

* `App.tsx`'s root carries `paddingTop: env(safe-area-inset-top)` - the header
  used to absorb that inset. **Sticky offsets are measured from the viewport, not
  from that padded root**, so a `sticky top-0` header inside a screen has to say
  `top-[env(safe-area-inset-top)]` or it parks under the system clock.
* That root is also the **only** bottom clearance (`pb-[104px]`, the floating
  nav's real footprint). Screens used to add their own `pb-24`/`pb-28`/`pb-32` on
  top of it, which is what left a blank half-screen under the last card. Do not
  re-add one.

## Branding and app icons

Every launcher icon, notification icon, splash and web icon is **generated**, never
hand-edited. Two source files, both in `assets/`:

| Source | Used for | Keyed by |
| --- | --- | --- |
| `Normallogo.png` (2048², opaque white ground) | everything coloured | `extractMark()` |
| `TransparentBGlogo.png` (2048², alpha) | notification/badge stencils only | `trimToMark()` + `silhouette()` |

    npm run icons        # scripts/generate-app-icons.mjs

The two sources are not interchangeable, which is the thing to know before touching
this. `Normallogo.png` carries the book's inner outlines as **white ink**;
`TransparentBGlogo.png` had them removed along with the background, so they are
**holes**. Coloured icons need the ink (holes would show the plate through the
book). Stencils need the holes (Android discards colour and keeps only alpha, so
white ink flattens the mark into a featureless blob). Feeding either file to the
other path produces something that looks plausible at 512px and wrong at 24dp.

**The plate is `#FFFFFF`.** The mark is a light blue, so any blue plate has no
contrast — and `extractMark` leaves a faint pale fringe on the mark's anti-aliased
edge that composites back to the original artwork on white and reads as a halo on
anything darker. `@color/ic_launcher_background`, `@color/splashBackground` and
`capacitor.config.ts`'s SplashScreen background all agree on white; keep them that
way together.

For in-app UI use `/icons/logo-mark.png` (transparent). The `/icons/icon-*.png` set
bakes in the white launcher plate and reads as a white box inside the tinted
containers in `Navbar.tsx`, `LoginScreen.tsx` and `SignupScreen.tsx`.

`index.html` deliberately has **no** `<link rel="manifest">` — vite-plugin-pwa
injects one, and a browser honours the first it finds.

## Known gap: React has no types here

`@types/react` and `@types/react-dom` are **not installed**, and React 19 ships
none of its own. `npm run lint` (`tsc --noEmit`) therefore checks the component
tree with no JSX types at all — props resolve to `any` and prop-type mistakes go
unreported. Adding the types would be correct but will surface a backlog of
pre-existing errors, so treat a green `lint` as weak evidence for `.tsx` changes.

## Simosan: the AI tutor, and why it is server-side

`shared/simosan.ts` (budget), `shared/simosanChat.ts` (Gemini), `shared/simosanApi.ts`
(routes), `src/components/pdf/SimosanDrawer.tsx` (UI). Mounted in **both**
`api/index.ts` and `server.ts` as four one-line `app.*` calls, so the handlers
cannot drift the way the other 14 routes did.

**No Gemini key reaches the browser any more.** MCQ generation used to call
Gemini from the client with the key inlined by `vite.config.ts`; it is now
server-side too, and that `define` has been removed. The build is verified to
carry exactly one `AIza` string - the Firebase web key, which is public by
design.

**Grounding is the whole PDF, via the Files API - and that is the cheap option.**
Gemini bills PDF pages as images and does not charge for natively embedded text
on Gemini 3 models, so a lecture costs less *with* its diagrams than extracted
text alone would.

The billing rate is **~303 tokens/page measured**, not the 258 Google documents
- a live 66-page lecture billed 20,026 IMAGE tokens. `TOKENS_PER_PDF_PAGE` is
set to **310** for that reason and is pinned by a test; do not "correct" it back
to 258 on the strength of the docs. Sizing the reservation off 258 cleared
actual spend by only 5%, and would have *under*-reserved on a longer answer. Files API uploads and
storage are free and last 48h, so one upload per lecture is shared by every
student reading it; `aiFiles/{lectureId}` caches the URI and refreshes at 44h.
Inlining base64 per turn - what MCQ does - would re-ship several MB per question
and, on Vercel Hobby, burn the function budget before the first token.

**Prompt order is load-bearing.** `buildContents()` puts the file reference and
preamble first and never varies them within a chat, because Gemini's implicit
cache keys on a byte-identical prefix. That is what makes a follow-up cost a
fraction of the first question. Reordering it silently triples the bill.

**Energy is denominated in real price ratios**, not product feel: one unit is one
uncached input token, cached input is 0.25, output is 6 (`$1.50 ÷ $0.25`). The
bar and the Google invoice therefore cannot diverge. Changing the model means
changing those weights and `USD_PER_UNIT` together, or the ceiling stops meaning
dollars.

Spending is **reserve → stream → reconcile**, all transactional. The reservation
is the only thing stopping ten parallel requests from each reading a full bar;
`npm run test:simosan` asserts that directly. Reservations are deliberately
pessimistic (`RESERVE_SAFETY_FACTOR`) because over-reserving is refunded seconds
later while under-reserving overruns the budget. Any path that fails to produce
an answer releases the hold in full.

Off-topic refusals are refunded but **capped at `MAX_FREE_OFF_TOPIC_PER_DAY`**.
An uncapped refund is an infinite-spend hole: the whole PDF is already in the
prompt before the model decides to decline, so every refusal costs real money.

Reset is **Baghdad midnight** (UTC+3, no DST - Iraq abolished it in 2008). A UTC
reset lands mid-afternoon for every student in the app.

Measured on a real 66-page lecture with `gemini-3.1-flash-lite`: a fresh
question costs **$0.00569** (22,747 units) and a cached follow-up **$0.00274**
(10,955 units), because the PDF prefix hits Gemini's implicit cache - confirmed,
16,011 cached tokens on turn 2. The daily budget is **140,000 units** (~6 fresh
questions, or one fresh plus ~11 follow-ups). It was 55,000, which assumed a
30-page lecture and bought 2.4 questions on a real one.

`aiUsage` ownership is checked against the stored `uid` **field**, never parsed
out of the `{uid}_{date}` document id - a uid containing an underscore makes
`split('_')[0]` return a prefix, which denies a student their own row and could
match whoever owns that prefix.

**`SimosanAdminScreen` is web-only**, aliased to a null stub for
`mode === 'native'` in `vite.config.ts`. It renders dollars, and
`scripts/assert-no-payment-surface.mjs` scans the Android artefact for exactly
that - admin-only React still ships inside it, so a runtime guard is not enough.
This is the same lesson `SubscriptionScreen` records.

The drawer follows the reader's conventions, not the app's: inline `ar`/`en`
strings against `isRtl` rather than `TRANSLATIONS`, scrim `z-[170]` / panel
`z-[171]`, and `useBackDismiss(..., 'pdfSimosan')` registered **after** the
existing three so back closes Simosan first.


## The weekly timetable: parsed, reviewed, then published

The stage's timetable is still uploaded as one flat image
(`settings/weekly_schedule_{stageId}.photoUrl`, written client-side by
`WeeklyListScreen`). What changed is the *display*: `shared/timetable.ts` +
`shared/timetableApi.ts` read that image with Gemini on the **free-tier key**
and turn it into sessions, and students see their own week instead of a grid
holding every subgroup at once.

**Two documents per stage, and the split is the design.**
`timetableDrafts/{stageId}` is what the parse writes and the representative
corrects; `timetables/{stageId}` is what students read. `/api/timetable/parse`
**never writes the published one**, so a failed re-parse cannot take a working
timetable off students' screens - that is a property of the schema, not a rule
the failure handler has to remember. A draft could not have lived in
`settings/`, which is `read: if isAuthenticated()`: every student would read
every unreviewed parse.

Both are matched by `canWriteStage(stageId)` directly, because the stage **is**
the document id - none of the id-rebuilding that forced `canWriteScheduleDoc`
into existence is needed. Rules scope by role-and-stage only, as every content
collection does; the `manageTimetable` capability is enforced in
`src/lib/permissions.ts` for the UI and inside the parse handler for the one
path that spends quota. `verifyAdmin` admits admin, moderator **and** support,
so the route re-implements `canManage()`'s arms itself - `staffCan()` alone
returns false for a representative, which is exactly the role that should hold
this by default.

**`groups: []` means everyone, and is deliberately not "every subgroup".** An
expanded list is a snapshot of the group structure at parse time: add a group to
`stages/{id}.groupConfig` next semester and every theory session silently stops
applying to its students, which renders as an *empty agenda* - read as "no
lectures", not as a bug. The full-cover collapse in `normalizeParsedGroups()`
turns a row printed "A, B, C, D" back into `[]` for the same reason.

**The audience fails OPEN.** A practical whose group label the model could not
read has an empty audience and is therefore shown to *everyone*, badged amber in
the editor. Showing one lab too many costs a glance; hiding the one that was
theirs costs the lab. Pinned by `npm run test:timetable`.

**Nothing here touches `subjects`.** `TimetableSession` has no `subjectId` and
never will: the college prints two subjects sharing a slot as
`Physiology I + Computer Science`, and transcribing those into `subjects` is the
exact mistake the split flow above exists to undo. A cell stays a string;
`titles` splits it on `+` **for display only**, by the same `+`-only rule as
`src/lib/subjectSplit.ts`.

The image is fetched by **URL resolved from Firestore**, never
`admin.storage().bucket()` - neither route file passes a `storageBucket` to
`admin.initializeApp()`, so `.bucket()` throws at runtime. Same SSRF contract as
`/api/mcq/generate`: the client posts an id.

`TIMETABLE_RESPONSE_SCHEMA` carries **no `minItems`/`maxItems`** for the reason
`MCQ_RESPONSE_SCHEMA` records, and this schema is the same
array-of-objects-containing-arrays shape that triggers it. `day` is a named enum
rather than an integer so "is 0 Sunday?" is never the model's problem.

Unlike MCQ there is **no cross-stage lock**. MCQ refuses when any other lecture
is generating because a bulk upload fires N calls at a free key; this is five
stages with one hand-triggered image each, so a global lock would block one
stage while another parses for no quota benefit.

Staff are notified through `systemNotifications` (which `functions/index.js`
turns into an FCM push for free) - and that query includes `'support'`, which
`shared/mcqApi.ts` omits. Students are **not** fanned out to on publish: a stage
is ~400 accounts and each row becomes an individual send.

## The chat is gone, and what replaced its button

The in-app group chat was deleted: `ChatScreen.tsx`, `chat/ReportMessageSheet`,
the `sendMessage` callable, the `archiveOldMessages` cron, the
`/api/admin/create-chat-bundle` route on both surfaces, and the rules for
`chat_messages` (+ its `private/` subcollection), `chat_archive`,
`chat_settings`, `chat_presence`, `chat_typing`, `inbox_sessions` and
`private_chats`. `scripts/purgeChat.ts` empties all of it from a live project -
dry run unless `--commit`, and it walks subcollections explicitly because
deleting a parent leaves them orphaned, and `chat_messages/{id}/private/sender`
held the real identity behind every anonymous message.

Two fields survive on `users/` with nothing reading them:
`notificationPreferences.chat` and `permissions.manageChat`. `manageChat` was
never enforced anywhere - `syncRole` put it on the custom claim, but no rule and
no function ever read it; `ChatScreen` was its only consumer.

The nav slot is **reserved for Simosan**, which today exists only as a drawer
inside the PDF reader. `SimosanSoonScreen.tsx` holds it - inert by design, no
listener, no state. The tab id is `simosan`, not `chat`.

`moderationService.ts` and Settings -> Blocked users stay. Blocking is still
reachable and both stores want it, but `reportMessage()` has lost its only
caller: **the app no longer has an in-app reporting path**. If a store reviewer
raises Apple 1.2 / Play UGC, the fix is a report button on announcements, not a
restored chat.

### Sharing a lecture sends the FILE

The three "share to chat" buttons are gone. Records and announcements lost
theirs outright; the lecture button now hands the actual PDF to the OS share
sheet (`src/lib/shareFile.ts`), so a classmate gets the file rather than a link
into an app they may not have.

**It must write into `Directory.Cache` and nowhere else.** `@capacitor/share`
runs every entry in `files[]` through
`FileProvider.getUriForFile(activity, packageName + ".fileprovider", ...)`, so
the path has to sit under a directory `android/app/src/main/res/xml/file_paths.xml`
already serves. It has `<cache-path path="." />`, and Capacitor's
`Directory.Cache` is `context.cacheDir` - so that combination needs no native
change, and any other directory throws from FileProvider at runtime with
nothing a build would catch.

Two more things that only fail on a device:

* **The filename decides the MIME type.** Android reads it with
  `MimeTypeMap.getFileExtensionFromUrl`, which yields an extension only when
  the percent-encoded name matches `[a-zA-Z_0-9.\-()%]+`. Arabic is fine (it
  encodes to `%D8%A7`); `'` `!` `~` `*` are not, because `Uri.encode` leaves
  them alone. `safeFileName()` in `src/lib/shareFileName.ts` whitelists instead
  of blacklisting, and `npm run test:share` pins it.
* **The cached copy is swept on the NEXT share, never after this one.**
  `Share.share()` resolves when the chooser returns, which is routinely before
  the receiving app has read the stream - deleting on resolve ships a zero-byte
  attachment.

Bytes come from `readStoredPdf()` when the lecture is already downloaded, so a
saved lecture shares with no connection at all, and encoding goes through
`FileReader.readAsDataURL`: `btoa(String.fromCharCode(...bytes))` spreads one
argument per byte and throws `RangeError` on any real PDF.


## Streaks: three stores, and which one is true

`users/{uid}` holds the live counters. A season end (`shared/seasonReset.ts`) writes
two archives *from one in-memory pass*: a per-student card at
`users/{uid}/streakHistory/{seasonId}` and a top-50-per-stage list on
`semesterArchives/{seasonId}`. Because both come from the same object in the same
loop **they cannot legitimately disagree** - a divergence means something rewrote a
card afterwards. `scripts/streakAudit.ts` is the check (dry-run by default); it
found exactly one diverged card in 50 and that is the shape to expect.

`users/{uid}/streakHistory` is therefore `write: if false` - Admin SDK only. It was
`isAdmin()`, and an admin client used that to overwrite a finished season three
weeks after the fact.

**A season has to be OPENED as well as closed.** `closableTerm()` only ever
returns a term whose live end has passed, so a calendar's *first* term has no
predecessor, `startNewSeason` never fires at the year's open, and whatever an
account carried in survives into day 1. Compounding it, `resolvePhase` marks
every preseason day paused and `activeDaysBetween` skips paused days - so a
`lastActiveDate` from *last June* read as a one-day gap and `record-activity`
incremented it. One student opened term 1 on 2 with everyone else on 1.
`openSeason()` (`shared/seasonReset.ts`) is the missing half: idempotent via
`app_settings/streak.seasonOpenedFor`, called from `runSeasonRollover` after the
close pass, and **selective** - it clears only accounts whose `lastActiveDate`
predates the term, so it is safe to run mid-term without wiping the day the
cohort legitimately earned. `startsFreshSeason()` is the same rule enforced per
request, because the rollover cron fails closed without `CRON_SECRET`.
It is scoped to the YEAR's opening boundary, never a term boundary inside it -
closing term 1 *is* a closable term, so `npm run test:calendar`'s "a break costs
no streak days" must keep passing. Repair a live database with
`npm run streak:audit -- --only preseason [--commit]`.

**`longestStreak` is per-season and is zeroed by the reset.** The all-time record
lives in `bestStreakAllTime`, which is deliberately absent from the reset patch and
is raised there from the closing season before `longestStreak` goes to 0. Anything
that raises `longestStreak` must raise `bestStreakAllTime` too - both API surfaces,
the two admin recovery routes, and the account merge.

**A finished season's board is keyed to the stage it was PLAYED in**, never the
viewer's current stage. `LeaderboardTab.tsx` used to fall back to the live profile
stage, which collapsed a 415-student board to the single promoted student and then
renumbered them to rank 1, crown and all. Archives with no `stageId` on any row
predate stage scoping and are shown whole; stored `rank` is never renumbered.

**Promotion does not touch streak fields.** `progressionSubmit.ts` and
`stagePromotion.ts` write `stageId` to both `users/` and `students/` (both are
required - `syncUserStage` copies `students` -> `users` on every login and would
otherwise undo it) and leave the streak alone, so it carries across a stage change.
Archive the season **before** any bulk promotion, or the cohort is filed under the
wrong stage permanently (`scripts/importRoster.ts:18-21`).

**The pending-reset queue only drains at the season reset.** `pending_streak_resets`
docs carry an `expiresAt` that nothing reads, and the only other clear is a manual
admin action, so 325 accounts once sat flagged for four months. The reset now deletes
the doc and the `hasPendingStreakReset` flag together.

## The MCQ board is filtered on a COPY of the stage

`LeaderboardTab` scopes the MCQ board with
`where('stageId','==',effectiveStageId)` + `orderBy('mcqRankScore','desc')` on
`userMCQStats`. That `stageId` is a **denormalised copy** of `users.stageId`,
kept because a board cannot otherwise be scoped without reading every user
document.

A copy has to be written by every path that moves a student, and one was not:
`shared/progressionSubmit.ts` wrote `users/` and `students/` and left the stats
row filed under the stage the student had just left. `stagePromotion.ts` (the
bulk path) always re-filed it, so only students who went through the
**self-service** progression flow drifted.

**The symptom is specific and misleading.** They keep their place on the STREAK
board, which reads `users/` directly, and disappear from the MCQ board for the
stage they are actually in — while padding the board of the stage they left.
That reads as "the MCQ leaderboard is broken for stage N", not as one stale
field, and nothing in the console looks wrong: every document involved is
individually healthy. The indexes are deployed and the rules are fine.

    npm run stage:audit                 # dry run - always the default
    npm run stage:audit -- --commit     # re-file the stale rows

`scripts/stageConsistency.ts` reports both directions separately, because they
are different failures: **stale** (the copy names a stage the student has left)
and **missing** (no copy at all — `mcqAnswerService` omits the field when the
user document had no stage at the time, so the student is on no board at all).
Rows whose `users/` document is gone are left alone; an account merge or a purge
owns those.

The existence check on the stats document in `progressionSubmit` is not
optional: a student who has never answered an MCQ has no row, and `update()` on
a missing document fails the **whole** batch — which would take the promotion
down with it. Pinned by `npm run test:progression`.

## Offline: absence is only meaningful from the server

Firestore runs with `persistentLocalCache` + `persistentMultipleTabManager`
(`src/lib/firebase.ts`). It was on the default MEMORY cache, which is empty at every
cold start, while Auth persistence was durable - so an offline launch restored a
signed-in session and then entered a boot path whose reads could not succeed.

Three SDK behaviours drove every bug here, and they are not the same:

| call | offline, not in cache |
| --- | --- |
| `getDoc` (document) | **rejects** with `unavailable` |
| `getDocs` (query) | resolves **empty**, `metadata.fromCache` true |
| `onSnapshot` (document) | fires with `exists() === false`, `fromCache` true |

So a failed read and an absent document are indistinguishable unless you check.
`App.tsx` used to sign the user out on both - the catch around the whitelist `getDoc`,
and the `users/{uid}` listener reading a cached miss as a deleted account. `signOut`
wipes the refresh token, so reconnecting could not recover it and `LoginScreen` refuses
to submit offline. **Never call `signOut` on a thrown error**; discriminate with
`isTransientNetworkError()` (`src/lib/firebase.ts`), and gate any "record is missing"
conclusion on `!snapshot.metadata.fromCache`.

**The persistent cache also makes the offline MUTATION queue durable.** A write issued
offline now survives the tab and flushes on reconnect. `StageContext` seeded
`DEFAULT_STAGES` whenever `snapshot.empty` - true offline - which would now overwrite
five real `stages/*` documents, `groupConfig` included. It is guarded on
`!snapshot.metadata.fromCache`. Check any other write that keys off an "empty" read
before adding one.

Also: `await setDoc` does not settle until the server acks, so awaiting one in a boot
path hangs forever offline. `StageContext` stalled on `stage_1` that way and never
cleared `isLoadingStages`.

**Downloaded lectures need metadata, not just bytes.** `PdfReaderOverlay` already
resolved bytes as `local ?? await fetchPdfBytes(...)`, but the Downloads tab listed
lectures from the Firestore listener, which yields nothing offline - so saved PDFs were
invisible. `downloadPDF()` now snapshots `{id, title, pdfUrl, ...}` into the
`offlineLectures` store (`src/lib/localDb.ts`, db version 2) and the tab merges that with
the live array.

`pdfBlobs` is still keyed by `pdfUrl`. An admin re-upload mints a new URL
(`AdminUpload.tsx`), so the key stops matching and the reader silently falls back to the
network while the stale bytes and the `pdf_${id}` marker both persist. Keying by lecture
id instead would serve the OLD file after a re-upload, which is why it has not simply
been swapped - it needs a migration that drops superseded bytes.

## Master admins: one list, and the copies that cannot import it

`shared/masterAdmins.ts` is the source of truth. Everything that can import does
(`server.ts`, `api/index.ts`, `App.tsx`, `LoginScreen`,
`StudentManagement`, `AdminGradesScreen`). Four places cannot and hold a checked
copy: `firestore.rules` and `storage.rules` (rules have no imports),
`functions/index.js` (deploys as its own package, so `../shared` is not on disk)
and the `.mjs` scripts. `npm run test:masters` parses all four and fails if any
disagrees, and also fails if a new source file hardcodes an address instead of
importing.

It exists because the inline lists **had already drifted**. `LoginScreen`, the
old `ChatScreen` and `AdminGradesScreen` carried one address while the two
servers carried two. That is not cosmetic: `LoginScreen` decides the `role` written onto
a brand-new `users` document, so a master admin whose first-ever sign-in was
Google was created as a **student** and had to be repaired by hand.

Adding an address takes effect on four independent paths, and it is worth
knowing which does what:

* **`shared/googleLogin.ts` bypasses the whitelist for a master admin.** They
  have no `students/` doc and no `allowed_admins/` entry, so that bypass is the
  *only* reason Google sign-in works for them at all - an address missing from
  the list gets `NO_ACCOUNT` and is routed to the signup form.
* **`isMasterAdmin()` in both rules files has an email arm**, which is what
  admits a new master admin before they have any document at all.
* **`functions/index.js`'s `syncRole` rewrites the custom claim on EVERY
  `users/{uid}` write**, and `App.tsx` stores `role: 'admin'` for a master admin.
  An address missing from *that* copy has its `master_admin` claim stripped again
  by the next profile write, which is why the functions copy is not optional.
* `/api/bootstrap-admin` mints the claim on first load and is what `App.tsx`
  calls when the email matches but the claim does not.

The `isMasterAdmin` boolean on `users/` is a UI convenience
(`src/lib/permissions.ts`) set by `scripts/assignStageRepresentatives.mjs`; it is
never the authority. Nothing security-relevant reads it.

## Duplicate accounts: the app used to create them on purpose

The single most important fact here, because it makes the obvious fix
impossible: **there is no Firebase email/password account anywhere in this
project.** `createUserWithEmailAndPassword` and `admin.auth().createUser` appear
zero times. A staff-created account is a `students/{id}` document holding a
hashed `password`; its Auth record is materialised by `signInWithCustomToken`
with **uid = that document id** and **no `email` property at all**.

So Firebase sees a roster identity and a Google identity as unrelated
principals. `auth/account-exists-with-different-credential` is structurally
unreachable, and Firebase-level account linking has nothing to link. The join is
ours to make, and it lives in `students.googleEmail`.

**The duplicate was the happy path, not an accident.** A student with a roster
account pressed "Continue with Google" with a personal Gmail;
`resolveGoogleLogin` missed on the doc id and on `googleEmail`, threw
`NO_ACCOUNT`, and `LoginScreen` opened `SignupScreen` *prefilled with that
Gmail*. `createSignupRequest` checked only `students/{email}` by doc id, so the
request was filed, a representative approved it, and a second `students` row, a
second `users` doc and a second streak came into existence. The remedy already
existed - `linkGoogleAccount` - but only in Settings, reachable only **after** a
password login, which is exactly what this student could not do.

`/api/google-claim` (`claimAccountWithGoogle`) is the missing half. It demands
**two independent proofs**, and neither alone is sufficient: `verifyGoogleIdentity`
for the mailbox (it refuses an unverified email - without it anyone could claim a
classmate's address) and `resolveStudentLogin` for the account. It then calls the
same `linkGoogleToStudent` core the Settings page uses, so the conflict guards
cannot drift, and mints the token under the **existing** uid.

**`examCode` is never an identifier.** It is reissued every year, so it
identifies a year's enrolment rather than a person - matching on it would both
miss a real duplicate whose code has rolled over and fuse two students holding
the same stale number. Nothing matches, merges or authenticates on it;
`findStudentCandidates` takes email, login code or folded name and never has. A
negative test in `scripts/signup.test.ts` pins that two students sharing a code
are neither flagged nor blocked.

### What makes a merge stick

`mergeUserAccounts` folded the `users` doc and stopped, leaving the losing
`students` row live at the address it is keyed by - so the student signed in
again and minted the duplicate straight back. The loser is now **retired in
place** (`isActive:false` + `mergedInto`) and its address copied onto the
survivor as `googleEmail`: the duplicate becomes the link. Retired rather than
deleted, on the same reasoning as a subject split.

**The ordering trap this creates is the whole game.** `resolveGoogleLogin`
checks the students doc id *before* it reads `isActive`, so a retired row would
be found first and reported as `DISABLED` - undoing the very link the merge
created. `followMerge()` (`shared/studentLookup.ts`) is applied at all three
lookup sites, and in the Google path it runs **before** the `isActive` check.
One hop only; a cycle is ignored.

The merge is not transactional and cannot be - it spans a dozen collections - so
an `accountMerges` row is written before it starts and closed after, and a
re-run is a no-op. Two latent bugs were fixed on the way, both of which would
have corrupted a bulk run: the `streak_history` re-key split the doc id on `_`
although a roster uid **is** an email address, and the source delete sat
*outside* the guard that noticed. It also silently dropped a live subscription,
the academic record (`degrees/{uid}/exams`), and the season and year archives.

    npm run accounts:duplicates            # dry run - always the default
    npm run accounts:duplicates -- --commit

Four passes, and the split is the design. **A, B, C are structural** (several
users docs for one students row; a users doc matching no students row; a linked
`googleEmail` that is itself another row) - each is a join on a value the system
wrote, so a match is a fact, and only these are merged by `--commit`. **D is a
judgement** - the same folded name twice in one stage, which is the shape the
signup funnel produced and has no structural key at all. It is reported for a
representative who knows the cohort to settle in إدارة الطلاب, never auto-merged
at any flag. The winner is the **oldest** `students` row: the roster row
predates the self-signup that duplicated it, and unlike activity it is not
something the student can change.

`StudentManagement` grouped strictly on `users.email`, so a roster uid and a
Google uid for one student could never appear in the same merge dialog. It now
unions the three structural links, and merges **every** duplicate rather than
the first one `find` returned - a student holding three users docs merged two
and reported success.

### The third Auth record

`src/lib/googleSignIn.ts` runs `signInWithPopup` on a throwaway secondary app.
Deleting that app does **not** delete the Auth user it created - that record is
project-wide - so every web Google sign-in left an orphan. `discardPopupIdentity`
removes it, guarded on **owns no `users` doc AND is not the uid being signed
in**: a master admin's Google uid *is* their real account, so an unconditional
delete would remove a live administrator.

## Known hazard: two identity spaces

Roster students sign in with a **custom token whose UID is their college email**
(`uid: "ph2023099@student.alsafwa.edu.iq"`, `customAuth: true`, no `email` on the
auth record). Google sign-in users get a normal opaque UID. So `users/` is keyed
both ways, and the same human can hold **both** documents with separate streaks,
stages and progression state - `examCode 30086` currently maps to three `users`
docs, two of which are one student in different stages.

Consequences to keep in mind: any rule of the form `request.auth.uid == userId`
works for both only because the email *is* the uid; `streak_recoveries.userId` and
older `semesterArchives.topStudents[].userId` hold a mix of uids and emails; and
`shared/adminUsers.ts` merge is the only path that reconciles two accounts.

Unifying this touches 423 auth users and every uid-keyed collection. Do not attempt
it as a side effect of another change.

What has changed since that was written: the app no longer *creates* new pairs -
see "Duplicate accounts" above - and `shared/adminUsers.ts` is no longer the only
path that reconciles two accounts. `/api/google-claim` links them before a second
one exists, which is the cheap half; the merge remains the only repair for the
pairs already in the data.

## Three build targets, and what each may sell

The two stores want opposite things, which is why there is no single
"store build" any more:

| `--mode` | Artefact | Sells | Rail |
| --- | --- | --- | --- |
| *(none)* | web | yes | ZainCash + Super Qi |
| `native` | Android APK/AAB | **nothing** | - |
| `ios` | App Store `.ipa` | yes | Apple IAP via RevenueCat |

Play requires its own billing for in-app digital purchases *and* forbids
steering users to pay elsewhere, so the Android build has no purchase surface
at all. Apple requires digital access to be sold **through** its billing - so
hiding the paywall on iOS is its own rejection. Same policy family, opposite
obligations.

**Two flags, not one** (`src/lib/platform.ts`). `IS_STORE_BUILD`
(`__NATIVE_BUILD__`) means "inside an app binary" and is true for both native
targets - it is what `src/lib/apiBase.ts` keys the absolute API base off, and
what gates screens stubbed on both. `CAN_SELL` (`!IS_STORE_BUILD || IS_IOS_BUILD`)
means "may show purchase vocabulary and a route to a buy flow". Every runtime
check that softens "الاشتراك / Subscription" into "حالة الوصول / Access", or
hides the row that reaches the paywall, means the second one. Asking
`IS_STORE_BUILD` there ships an iOS app that cannot be bought from
(`ProfileScreen.tsx`, `settings/SettingsScreen.tsx`). The two rows that open a
*stubbed* screen - إدارة الاشتراكات and استخدام سيموسان - correctly stay on
`IS_STORE_BUILD`.

Three layers keep each artefact honest:

1. **Build-time exclusion**, `vite.config.ts`'s alias array, now in three
   groups. `SubscriptionManagement` + `SimosanAdminScreen` → stubs on **both**
   native targets (an admin ledger and a dollar dashboard belong in neither).
   `SubscriptionScreen` / `SubscriptionPaywall` / `i18n/payments` → inert stubs
   on Android, and → `src/ios/*.ios.tsx` + `src/i18n/paymentsIos.ts` on iOS. A
   runtime guard is not enough: the stores scan the artefact, and hidden UI is
   still *in* it.
2. **Vocabulary is per-target.** One specifier, three files:
   `src/i18n/payments.ts` (web), `src/native-stubs/payments.ts` (`{}`),
   `src/i18n/paymentsIos.ts` (Apple only). The iOS file carries **no price
   literals and no currency codes** - every figure a student sees is
   RevenueCat's localized `priceString`, which is Apple's own price in the
   viewer's storefront. `PLAN_CONFIG`'s IQD figures are the web rail's.
3. **The Android stubs speak in ACCESS terms**, not quieter purchase terms:
   `accessActive` / `accessInactive` / `accessUntil` / `accessManagedByRep`,
   all true, none a transaction. **iOS says the true thing instead** - there
   really is a subscription, bought through Apple, so the badge reads
   "مشترك / SUBSCRIBED" and the settings row says "الاشتراك / Subscription".

The distinction being drawn: *stating that an account lacks access* is a fact
about the account. *Telling the user where to go and pay for it* is steering -
prohibited by both stores whether or not the app handles the money, and
**not** what Apple's own IAP sheet or its
`itms-apps://apps.apple.com/account/subscriptions` link are. Keep new copy on
the right side of that line for the target it ships in.

`npm run check:payment-surface` (Android) and `check:payment-surface:ios` run
the same scanner against the two artefacts. It flags gateway names, currency
codes, price fields, the Super Qi wallet, off-store contact links and the
receipt storage path - so it passing is **necessary but not sufficient**: it
would not catch a "Subscription" row with a credit-card icon.

Exemptions are **per rule, not per file**, and each is pinned to a
`manualChunks` entry so nothing else can hide behind it:

- `legal-pages` is excused the gateway-name rule, because a privacy policy has
  to name its processors truthfully. It is still checked for currency codes.
- `support-contact` (`src/lib/support.ts`) is excused the off-store-contact
  rule. The support desk's Telegram and WhatsApp are spelled with the same
  `t.me/` and `wa.me/` literals `src/lib/paymentContact.ts` builds the
  *seller's* from, so no pattern separates them.
- `revenuecat` is excused the gateway-name rule, because the SDK enumerates
  every store it supports, Stripe included. That chunk is created **only** when
  `isIos` - without the guard it existed on Android too, empty of SDK, and
  Rollup filled it with Vite's shared preload helper, so the exemption would
  have excused 9KB of unrelated runtime on the one target that may not sell.

The privacy policy's processor list is per-platform for the same reason and
must stay in step: ZainCash (web), Apple + RevenueCat (iOS), nothing (Android).

## iOS push needs a real FCM token, and does not have one yet

`useNativePush` uses `@capacitor/push-notifications`, which returns whatever the
OS hands back: on Android an **FCM registration token**, on iOS a raw **APNs
device token**. The plugin calls `registerForRemoteNotifications` and has no
Firebase dependency, so nothing converts one into the other. Every sender in
`functions/index.js` goes through `admin.messaging()`, which only accepts the
former.

**The hook therefore publishes nothing on iOS, and that is deliberate.** The
naive version hardcoded `platform: 'android'` and wrote the token regardless,
which is worse than useless rather than merely ineffective: `fcm_tokens/{uid}`
is **one document per user**, and the senders prune on failure -
`functions/index.js` deletes that document on
`messaging/registration-token-not-registered`. So a student who installed the
iOS app would overwrite the FCM token their Android phone had registered, every
send would fail, and the prune would take the working Android token with it.
"iOS push does not work yet" would have become "this student gets no
notifications on any device".

iOS still registers with the OS, so the permission prompt and the foreground
listeners behave normally; only the publish is skipped, behind
`Capacitor.getPlatform()`.

Closing it is **three things, and none of them is just an npm install**:

1. `@capacitor-firebase/messaging`, which brings the `FirebaseMessaging` pod and
   exchanges the APNs token for an FCM one. Keep Android on the existing plugin
   - it works today for 423 accounts, and a swap risks it for no gain.
2. An **APNs auth key** (`.p8`) uploaded to the Firebase console. Without it FCM
   has nothing to talk to APNs with, and the exchange fails at runtime with
   nothing a build would catch. This is a THIRD `.p8` - not the App Store
   Connect API key and not the In-App Purchase key.
3. The **Push Notifications capability** on the App target, which means an
   `App.entitlements` file (the project has none) and a provisioning profile
   minted with push enabled.

Until all three land, treat iOS push as absent rather than broken.

## The Apple rail: RevenueCat, and why it is a sibling not a caller

`shared/iap.ts` (pure logic + entitlement application), `shared/iapApi.ts`
(three routes, mounted one line each from both surfaces), `src/lib/iap.ts` (the
only module that touches the SDK), `src/ios/SubscriptionScreen.ios.tsx` (the
paywall). `@revenuecat/purchases-capacitor` is pinned at **11.3.2** - the last
line peering `@capacitor/core >=7.0.0`; 12.x needs Capacitor 8.

**The App User ID is an opaque server-minted hash, never the Firebase uid.** A
roster student's uid IS their college email, so using it would ship ~400 real
addresses into RevenueCat's dashboard, exports and webhook payloads.
`rcAppUserIdFor()` is `sha256(uid)`, so it never has to be stored to be trusted;
`rcLinks/{rcAppUserId}` exists only for the reverse direction, which a hash
cannot give. `/api/iap/identity` writes both **before a purchase is possible** -
a payment that arrived before the link existed would be unattributable - and
`/api/iap/sync` re-ensures it, so a lost link is recoverable rather than an
orphaned payment. `rcAppUserId` is frozen against self-edit in `firestore.rules`
beside the three subscription fields: a student who could point it at another
account would have that account's subscription applied to their own.

**The client never asserts entitlement.** `purchase()` and `restore()` return
only enough to stop a spinner; what grants access is `/api/iap/sync` asking
RevenueCat with the **secret** key. That also closes the window between a
purchase completing on the device and the webhook landing, which is most of the
time a student spends watching that spinner.

**`applyAppleEntitlement` is a SIBLING of `activateSubscription`, not a caller** -
the single most important decision here. `activateSubscription` stacks
`PLAN_CONFIG.days` onto an existing end date and overwrites the three
`users/{uid}` fields unconditionally. That is right for a one-off ZainCash
payment and wrong three ways for Apple: the expiry belongs to Apple and moves
every renewal (stacking drifts further from the truth each period), it
supersedes only `existingSubs.docs[0]`, and it would let a 1-month Apple
purchase **shorten** a live 1-year ZainCash subscription.
`recomputeUserAccess()` takes `max(endDate)` across every active row instead,
which can only raise access - so the two rails coexist without either knowing
about the other. `npm run test:iap` pins both directions.

`functions/index.js`'s `expireSubscriptions` carries a checked copy of that
recompute for the same reason (functions/ deploys as its own package, so
`../shared` is not on disk - the same constraint as the master-admin list). It
used to blanket-clear the three fields, which with two rails revokes access the
other one was paid for.

**One row per account, at `subscriptions/apple_{rcAppUserId}`.** Apple
auto-renew is one continuous subscription; a row per renewal would count the
same student once a month in توزيع المشتركين. The doc id is deterministic, which
is also free idempotency. `amount` is **0** on purpose: Apple settles in the
buyer's own currency net of commission and this ledger's `totalRevenue` is IQD,
so the admin dashboard shows the count alone and App Store Connect stays where
Apple revenue is read.

**`CANCELLATION` is a GRANT.** In Apple's vocabulary it means auto-renew was
turned off, not that access ends now - the student keeps the period they paid
for. A refund arrives as the same event with a past `expiration_at_ms`, so the
grant-to-stored-expiry rule revokes it with no special case. `BILLING_ISSUE` is
ignored because Apple retries for up to 60 days with access intact; cutting off
at the first failed charge would punish an expired card. `EXPIRATION` is what
actually ends it.

**An unmapped product fails OPEN on access and LOUD on the label.** A product
added in App Store Connect before `PRODUCT_PLAN_MAP` learns about it still
grants access, with an `adminAlerts` row and a `notes` field naming it.
Refusing a student who paid is a refund and a support ticket; a mislabelled plan
is a reporting problem. Same philosophy as the timetable's amber audience.

**The webhook fails CLOSED.** With `REVENUECAT_WEBHOOK_AUTH` unset it answers
503 rather than trusting the delivery - `header !== SECRET && SECRET` is a no-op
when the secret is missing. It takes **no auth middleware**: RevenueCat is not a
Firebase user and holds no ID token. `iapEvents/{eventId}` is the idempotency
key, because RevenueCat retries reuse `event.id`. The raw body for the optional
HMAC comes from the `verify` hook on the **one global** `express.json()` in each
route file - a path-mounted `express.raw()` would put an ordering requirement in
two files that must not drift.

Apple is never hand-approvable, for ZainCash's reason plus one: approving would
route through `activateSubscription` and stack days onto an expiry Apple owns.
Both surfaces refuse it; `needsManualApproval` filters it out of the queue.

**The App Store review screenshot is generated, not photographed.**
`scripts/paywallPreview/` renders the real `SubscriptionScreen.ios.tsx` with
only the store boundary mocked, so it cannot drift from what ships, and taking
one does not need a Mac. Its vite root is the **repo**, not the preview folder:
rooted at the folder, Tailwind v4's content detection scans only that folder and
emits a stylesheet that styles nothing. Prices come from `PAYWALL_PRICES`
because they belong to App Store Connect.

    PAYWALL_PRICES='{"com.mohadaraty.app.1month":"$1.99", ...}' npm run build:paywall

## The manual payment method: Super Qi / Qi Card

ZainCash settles itself - the gateway calls back and `shared/subscriptions.ts`
inquires and activates. **A Super Qi transfer lands in a wallet nothing here can
query**, so the only two things the app can do are point the student at a number
and a human, and collect enough evidence for that human to recognise the
transfer in their own wallet history. The form used to do neither: it printed the
literal placeholder `07XXXXXXXXX` and demanded a transaction id with nobody to
ask about it.

Both halves are deliberately **one of two, not both** (`src/lib/paymentContact.ts`,
pinned by `npm run test:payments`):

* **Contact: WhatsApp OR Telegram.** A seller who only uses Telegram should not
  have to invent a WhatsApp number, and a row of dead buttons is worse than one
  live one. The wallet number is *not* a channel - it takes money and answers
  nothing, so a student who has already paid would have nowhere to go.
  `normalizeWhatsapp()` rewrites a local `07xx` to `9647xx` because wa.me opens
  its own "invalid number" page otherwise, and `normalizeTelegram()` refuses a
  `t.me/joinchat/...`, `t.me/+invite` or `t.me/c/123/45` link - a remaining `/`
  means the path is not a username, and "joinchat" survives the username check.
* **Proof: a receipt screenshot OR the transaction number.** Super Qi shows its
  reference once, on a screen most students have already dismissed; requiring it
  is what made the form unfinishable. `isProofSufficient()` is the rule and it is
  enforced three times - the disabled submit button, the service before the
  write, and the test.

**The student's own contact field was removed from the submit form again.** It
briefly required WhatsApp OR Telegram (`contactWhatsapp` / `contactTelegram`) so
a reviewer could ask something back, but the seller's own contact is already
shown on the same screen, so the product call is that a student with a question
messages first rather than filling in a second contact field.
`createPendingSubscription` no longer takes or requires a `StudentContact`.
`hasStudentContact` / `normalizeStudentContact` still live in
`src/lib/paymentContact.ts` and stay pinned by `npm run test:payments` as pure
functions, and `SubscriptionManagement`'s admin search still matches
`contactWhatsapp` / `contactTelegram` on the rows that already have them from
before this change - both needles there are guarded on being non-empty,
`"abc".includes("")` is true, so an unguarded digit match would make every row
with a number answer a plain name search.

**The details live in Firestore (`settings/payment_contact`), not an env var**,
and are edited in-app from Subscription Management. The receiving number is the
single most likely thing to change and a rebuild is not an acceptable cost for
that. `settings/*` is already `read: if isAuthenticated()` / `write: if isAdmin()`,
which is exactly the audience. The dead `SUPERKEY_PHONE_NUMBER` this replaces was
never read by anything: no `VITE_` prefix, so it never reached the browser - the
same dead-code shape as the MCQ key above.

Receipts go to `payment_receipts/{uid}_{ts}_{salt}.{ext}` in Cloud Storage. The
object name **must** start with the uploader's uid: `storage.rules` admits the
write with `fileName.matches(request.auth.uid + ".*")`, and the default fallback
grants write to staff only, so without that rule a student attaching a receipt
gets a 403. Reads are not narrowed and cannot be - the fallback already allows
any authenticated read and Storage grants on ANY matching rule - so what keeps a
receipt private is the token in its `getDownloadURL()` link. The upload happens
on submit, not on pick, so an abandoned form leaves no orphan object; a failed
upload still submits when a transaction number was typed, because either half is
enough.

**The stored `paymentMethod` stays `'superkey'`.** Live subscriptions carry it and
`SubscriptionManagement`'s stats and filters key off it. Only the label was
corrected: "SuperKey" was a mis-transliteration of سوبر كي, which is Super Qi,
Qi Card's own wallet app. Renaming the value would strand every existing row.

All of it is web-only by construction: the strings are in `src/i18n/payments.ts`
and the logic is reachable only from the two components `vite.config.ts` stubs
for `mode === 'native'`, so `paymentContact.ts` leaves the native graph with
them. Verified - no `t.me/`, `payment_receipts` or "Super Qi" in a native build.
Generic-sounding keys in `payments.ts` carry a `pay` prefix (`paySave`,
`payCopied`, `payOr`) so nothing outside the purchase UI can come to depend on a
string that vanishes there.


## The subscription ledger: rows, people, and who may see either

**The dashboard counts two different things and they are not interchangeable**
(`src/lib/subscriptionStats.ts`, pinned by `npm run test:subscriptions`). إجمالي
المشتركين, المشتركون الفعالون and توزيع المشتركين count **people** — distinct
`userId`. إجمالي الإيرادات and إحصائيات طرق الدفع count **transactions**, because
a count sitting beside a revenue figure has to mean payments. إجمالي المشتركين was
`subscriptions.length`, so a student who abandoned two ZainCash attempts before
paying was three subscribers and a rejected Super Qi request was one; the live
board read 8 against a single real subscriber.

`'inactive'` is **not** a failure state — it is written when a subscription
expires (`functions/index.js`, `expireSubscriptions`) and when one is superseded
by an early renewal (`activateSubscription`), so `active || inactive` is the set
of subscriptions that really happened, and it is the denominator for both the
lifetime total and revenue. `pending` and `cancelled` are attempts.

توزيع المشتركين takes each person's **newest** active row, because
`activateSubscription` supersedes only `existingSubs.docs[0]` — a user holding
two active rows is a real shape, and counting rows let the breakdown exceed its
own total.

**ZainCash is never approved by hand.** It settles against the Inquiry API, so a
click on Approve would grant access for money nobody checked was collected; the
route refuses `paymentMethod === 'zaincash'` and the queue filters it out
(`needsManualApproval`). What made it *look* manual was that nothing ever moved a
row out of `pending`: the redirect comes back through the customer's browser and
the webhook does not fire in the test environment, so a student who paid and
closed the tab was stuck until an admin pressed the button.
`reconcilePendingZainCash()` is the sweep — run from the student's own
subscription screen and from إدارة الاشتراكات on open, not a cron, because
Vercel Hobby crons are daily and a payment cannot wait a day.

Two traps inside that path:

* **The probe's `eventId` must be unique per attempt.** It was
  `inquiry-${transactionId}`, and `claimForSettlement` writes `lastEventId` when
  it takes the claim while the `still_pending` branch releases only `settling` —
  so every re-check after the first returned `duplicate_event` without reaching
  the gateway. Double settlement is prevented by the claim's
  `status !== 'pending'` arm, not by that id.
* **`findLiveZainCashPayment` probes before checking `expiryTime`**, not after.
  The old order returned early on an expired window, which is precisely the row
  that needs asking about.

**`manageSubscriptions` is a `SYSTEM_CAPABILITIES` entry** (`src/lib/permissions.ts`)
— a subscription belongs to an *account*, not a stage, so there is no `stageId`
to scope a representative by, and a representative's "allowed unless explicitly
false" arm would be exactly wrong for it. Master admin always; support when
ticked; representative and moderator never. Support gets the statistics and منح
اشتراك; approve/reject/extend/cancel and `settings/payment_contact` stay
master-admin-only, on all three layers.

Those three layers used to disagree in opposite directions, which is the reason
this is written down: the Settings row was `isMasterAdmin`, `firestore.rules` was
`isAdmin()` (every stage representative could read the whole payment history and
edit any row straight from the client), and all five API routes were bare
`verifyAdmin` — which admits `admin`, `moderator` **and** `support`, so any
moderator could grant themselves a free subscription with a direct POST.

`settings/payment_contact` is matched by `match /settings/{docId}`, a
**single-segment** wildcard. It was `{document=**}`, and a recursive wildcard
binds a `Path`: `document == 'payment_contact'` is quietly *false* against one,
so the ternary fell through to `isAdmin()` and the narrowing did nothing. Nothing
nests under `settings/`.

## Two Gemini keys, and which pipeline uses which

| | Simosan | MCQ generation |
| --- | --- | --- |
| Key | `GEMINI_API_KEY` (paid) | `GEMINI_FREE_TIER_API_KEY` (free) |
| Model | `gemini-3.1-flash-lite` (**paid-only**) | `gemini-3.5-flash` (**has a free tier**) |
| PDF delivery | Files API, cached in `aiFiles` | inline base64, downloaded server-side |
| Metering | energy bar + $50 monthly ceiling | none - it is free |

The models are not interchangeable: flash-lite has no free tier, so it cannot run
on the free key, and that mismatch is what stops the two pipelines being silently
swapped.

**The free tier means Google trains on what it is sent.** Its terms say unpaid
content is used "to provide, improve, and develop Google products" and may be
read by human reviewers. That was accepted deliberately: *these lectures are
already public material*. Student questions are not, which is why Simosan stays
on the paid key - do not "simplify" by pointing it at the free one.

### Why MCQ moved server-side

The client read the key as

    import.meta.env.VITE_GEMINI_API_KEY
      || (typeof process !== 'undefined' && process.env ? process.env.GEMINI_API_KEY : undefined)

and `process` does not exist in a browser, so the second branch short-circuited
**before** Vite's `define` substitution was reached. `process.env.GEMINI_API_KEY`
was always dead code client-side; only `VITE_GEMINI_API_KEY` ever worked. Setting
the server key alone therefore reported `not_configured` on every generation,
which looks like a billing fault and is not.

### Rules that changed with it

`mcqs` was `allow create, update: if hasAccess()` because the student's own
browser wrote the generated result. Nothing legitimate creates it from a client
now, so create is `false` and update is `isAdmin()` - the old rule let any
student with access forge a lecture's whole answer key.

### Operational notes

Generation is **staff-only**; students press "اطلب تحضير الأسئلة", which writes
`mcqRequests` and notifies staff with stage, subject and lecture named in the
message. Serialisation is a **Firestore lock** (`mcqs.status` + `startedAt`, 90s)
because Vercel invocations share no process and an in-memory queue would
serialise nothing. `failureCount` caps retries at 3 so an unprocessable PDF
cannot drain the daily free quota. Alerts distinguish `free_tier_limit` from
`not_configured` from `bad_request` - the remedies are unrelated.

**`MCQ_RESPONSE_SCHEMA` carries no `minItems`/`maxItems`, and must not.** With
them (20/20 on `questions`, 2/5 on `choices`) Gemini answered *every* generate
call with `400 INVALID_ARGUMENT` before reading a page of the PDF, so the
server-side pipeline shipped and never produced one question set. The bounds are
accepted on a smaller schema, which is what makes them look innocent - it is the
combination with this nesting depth that is rejected. The count is asked for in
the prompt and enforced by `validateQuestions()`, which also carries the 2..5
choice bound that `maxItems` used to.

That failure was invisible for a second reason worth keeping separate:
`classifyFailure()` returned `'error'` for it, and only `free_tier_limit` /
`not_configured` raised an alert. `INVALID_ARGUMENT` now maps to `bad_request`
and alerts, because nothing a student or a PDF does can cause it - it is always
a bug in the request we send.

**A stale client is its own failure mode.** The pre-refactor browser generator
read the removed `VITE_GEMINI_API_KEY` and reported `not_configured` from cache
long after the server moved. Firestore tells them apart: server writes carry
`failureCount` and `stageId`, and alerts carry `note`; the old client's never do.

Endpoints take **`lectureId`, never a URL**: Vercel caps request bodies near
4.5MB, and a caller-supplied URL would let anyone make the server fetch arbitrary
hosts. Bank imports pass a Cloud Storage **path**, resolved through the Admin SDK
against this project's own bucket.

## Simosan: persona, markdown and the split view

The system prompt merges a clinical-professor persona over two mechanisms that
must survive any tone rewrite: `[[OFF_TOPIC]]` gates the energy refund and the
free-refusal cap, and `[[p:N]]` becomes the tappable page chips.

**Citation markers may carry a list.** A live answer emitted `[[p:7, 8]]`; a
single-number regex fails to match that and the marker reaches the student as raw
text. `CITATION_RE` accepts a comma-separated list and the renderer draws one
chip per page. Pinned by a test.

**The prompt is deliberately impersonal.** The student's first name and the
subject are injected into the FINAL user turn, never the system instruction,
because the system instruction sits inside Gemini's cached prefix - a name there
would give every student a different prefix for the same lecture and destroy the
cross-student sharing on a ~20,000-token PDF.

Chunked walkthroughs are opt-in via the "اشرح المحاضرة بأجزاء" button, which
sends `[[WALKTHROUGH]]`. Applying chunking to every question would turn a
one-line answer into a three-turn negotiation, each turn billed in full.

**The drawer has no scrim**, so the lecture stays visible *and* interactive
behind it. On phones it is a bottom sheet with two snap points (~55% / ~92%);
tablets and up keep the side drawer. The sheet must remain a SIBLING of the PDF
scroll container - as a child, its transform becomes the reader's containing
block and pinch-zoom breaks. Losing the scrim also loses tap-outside dismissal,
so the close button and `useBackDismiss('pdfSimosan')` are the only exits.

`react-markdown` + `remark-gfm` render answers. The repo's no-`dangerouslySetInnerHTML`
rule survives - react-markdown builds React elements, and `rehype-raw` is
deliberately absent, so HTML in a reply is escaped rather than parsed.
