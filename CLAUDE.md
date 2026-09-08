# MyLecture

## Architecture: the dual API surface

`server.ts` (43 routes) is the **dev** server, run via `npm run dev` (tsx).
`api/index.ts` (29 routes) is what actually serves **production** — `vercel.json`
rewrites `/api/*` to it. The two have drifted by 14 routes.

**A change to one usually needs the same change to the other.** Always check both
before concluding a route does or does not exist.

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
| `src/components/ChatScreen.tsx` | 2543 |
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
(`server.ts`, `api/index.ts`, `App.tsx`, `LoginScreen`, `ChatScreen`,
`StudentManagement`, `AdminGradesScreen`). Four places cannot and hold a checked
copy: `firestore.rules` and `storage.rules` (rules have no imports),
`functions/index.js` (deploys as its own package, so `../shared` is not on disk)
and the `.mjs` scripts. `npm run test:masters` parses all four and fails if any
disagrees, and also fails if a new source file hardcodes an address instead of
importing.

It exists because the inline lists **had already drifted**. `LoginScreen`,
`ChatScreen` and `AdminGradesScreen` carried one address while the two servers
carried two. That is not cosmetic: `LoginScreen` decides the `role` written onto
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

## No purchase surface in the store build

The app sells access on the **web**; the Android build cannot, because Play
requires its own billing for in-app digital purchases and forbids steering users
to pay elsewhere. Three layers keep that true, and all three matter:

1. **Build-time exclusion.** `SubscriptionScreen`, `SubscriptionManagement`,
   `SubscriptionPaywall` and `SimosanAdminScreen` are aliased to stubs for
   `mode === 'native'` in `vite.config.ts`. A runtime `IS_STORE_BUILD` guard is
   not enough - the stores scan the artefact, and hidden UI is still *in* it.
2. **Vocabulary lives in `src/i18n/payments.ts`**, which is aliased to an empty
   object for native. The entire subscription vocabulary now lives there -
   including `subscriptionRequired`, `askRepresentative` and `subscriptionActive`,
   which used to sit in `TRANSLATIONS` because the old stubs rendered them.
3. **The stubs speak in ACCESS terms**, not quieter purchase terms. They say
   only what the account's state is (`accessActive` / `accessInactive`,
   `accessUntil`) and who changes it (`accessManagedByRep`) - both true, neither
   a transaction. In store builds the settings row is "حالة الوصول / Access"
   with a key icon rather than "الاشتراك / Subscription" with a payment card,
   and the profile badge reads "مفعّل / ACTIVE" rather than "SUBSCRIBED".

The distinction being drawn: *stating that an account lacks access* is a fact
about the account. *Telling the user where to go and pay for it* is steering,
which is prohibited whether or not the app handles the money. Keep new copy on
the first side of that line.

`npm run check:payment-surface` only flags gateway names, currency codes and
price fields, so it passing is **necessary but not sufficient** - it would not
have caught a "Subscription" row with a credit-card icon.


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
