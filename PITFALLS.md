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

## Data model & consistency
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

## Store compliance (Play / App Store)
- A build-time UI exclusion (aliasing a screen to a stub) is necessary but
  not sufficient for "no purchase surface in this build" — a scanner that
  only checks gateway names/currency codes won't catch a purchase-shaped
  screen with access-only wording; review the copy too.
- Hidden/dead UI still ships inside the compiled artifact — verify by
  scanning the built output, not just by confirming the runtime guard exists.

## Tooling & test coverage
- `tsc --noEmit` on a large codebase can hit the default V8 heap and exit
  134 (OOM) — that looks like a hang/crash, not a type error; give it a
  larger `--max-old-space-size` rather than debugging the "failure".
- When a shared predicate function is added to replace N duplicated copies,
  the bug that made the copies inconsistent is usually in what *feeds* the
  predicate, not the predicate itself — test the input-hydration site
  (e.g. does the listener projection actually copy every field the
  predicate reads?) as its own check, not just the predicate's logic.
- A test suite for a mirrored/duplicated script (`bot/` importing shared
  logic) needs its own `npm test` wiring checked — a new test file sitting
  next to old ones doesn't run unless the script/CI list is updated.
