# Simosan Attendance: Reliability Audit and Revised Implementation Plan

Reviewed: 2026-10-14. Status: specification only; attendance is not implemented by this document.

This replaces the attendance plan supplied in the conversation. The latest explicit Supabase requirement takes precedence over the earlier Firestore-only proposal: retain Firebase Authentication and the existing institutional data, but put attendance traffic and its source of truth in Supabase Postgres.

## 1. Audit of the original plan

### Evidence boundary

The repository contains the Services Hub and its optional `onSelectService` callback, but `src/App.tsx:1117` renders it without that callback. The proposed attendance components, service, and stopwatch logic were not found. Consequently, these are design verdicts, not claims that attendance code has passed runtime tests.

Existing integration points:

- `shared/supabaseClient.ts` already supplies a server-only Supabase client; existing API middleware verifies Firebase ID tokens.
- `src/lib/localDb.ts` already provides IndexedDB, currently version 4. Its generic write helper resolves on request success, before transaction completion. Attendance must not use that resolution as a durable-save acknowledgement.
- `Student.name` is the official roster name; `currentName` is not. Firebase/roster identities can be email-shaped strings, not UUIDs.
- A weekly timetable row is not a dated lecture occurrence or a curriculum/PDF lecture. Attendance must not conflate those identities.

### Question 1: Zero false-rejection guarantee

**Status: FAIL**

**Vulnerability / Edge-Case Analysis:** A mandatory device lock explicitly rejects a second legitimate student borrowing a phone. A localStorage UUID identifies one installation/browser profile, not physical hardware; clearing storage or changing browsers defeats the restriction. The original plan also leaves authentication expiry, camera denial, storage failure, delayed uploads after session closure, duplicate requests, roster mismatches, and outages unspecified. Removing the latest-arriving “overflow” entries can punish students who scanned earlier offline. Physical presence is not itself observable by this system.

**Required Fix:** Make device reuse and headcount discrepancy non-blocking review signals. Persist a receipt before attempting upload; preserve it through retriable failures; make uploads idempotent. Treat late submissions and identity discrepancies as review cases rather than irreversible absence. Provide authorized manual recording, an offline instructor roster, and a paper contingency. Never claim an uncommitted save succeeded. No software change can guarantee success with a dead device, unreadable QR, lost storage, or unavailable operator; the target is no automatic academic penalty caused solely by technical failure, with an auditable recovery path.

### Question 2: Incorrect clocks or timezone

**Status: FAIL**

**Vulnerability / Edge-Case Analysis:** `Date.now()` is a wall clock, not a monotonic timer. A constant offset cancels when subtracting two readings from the same unchanged clock, but a clock correction between scan and upload corrupts that delta. Subtracting a client-supplied elapsed duration from server receipt time also incorporates network delay and trusts a forgeable value. The plan does not define an authoritative QR issuance or expiry protocol. Changing timezone alone does not change Unix timestamps, but local date parsing, lecture selection, and week classification can still be wrong.

**Required Fix:** Use server-issued session identifiers/challenges and server/database time for issuance, receipt, and lifecycle decisions. Remove `elapsedSeconds` and client-clock checks from attendance acceptance. Resolve the dated occurrence from the QR, not the phone's “today.” Display institutional dates in `Asia/Baghdad`. Keep offline capture available for an already loaded/cached app and cached identity even when token refresh fails; authenticate again at upload. Extreme clock errors can still interfere with TLS or authentication infrastructure, so retain manual recovery and never disable certificate verification. The application can avoid clock-based attendance rejection, not guarantee that an arbitrarily misconfigured device can establish secure connections.

### Question 3: Phone reboot before synchronization

**Status: FAIL**

**Vulnerability / Edge-Case Analysis:** An in-memory stopwatch disappears on process termination. `performance.now()` is tied to an execution/time origin and is not a persistent trusted clock across browser/device restarts. Saving its previous reading, or adding `performance.timeOrigin`, does not restore a reliable cross-reboot elapsed duration. Persisting a wall-clock timestamp survives ordinary restarts, but does not prove its accuracy. A local queue alone also does not establish that its write committed before the battery died.

**Required Fix:** Persist the complete immutable QR receipt and request ID in an IndexedDB transaction; acknowledge only transaction completion, requesting strict durability where supported. After restart, replay that same receipt without reconstructing elapsed time. Set exact offline scan time to unknown. Submission delay affects review policy, not evidence preservation. A normal restart after a successful durable save must recover the receipt; power loss before commit, explicit data clearing, OS/browser eviction, and physical storage failure remain outside an absolute guarantee.

### Question 4: Immediate weekly-schedule reassurance

**Status: PARTIAL RISK**

**Vulnerability / Edge-Case Analysis:** The plan includes an offline notice and mentions pending sync as neutral, but does not specify a persisted queue-to-schedule subscription, hydration after restart, pending counts, or precedence over a cached absent state. A toast can disappear while the lecture remains apparently unrecorded. A neutral upcoming row is not sufficient reassurance.

**Required Fix:** Derive schedule state from canonical records plus the current user's persisted receipt store, keyed by exact occurrence. Immediately after commit, show “تم الحفظ على هذا الجهاز — بانتظار المزامنة” / “Saved on this device — pending sync” on that lecture, including a receipt ID and pending badge. Hydrate this before rendering absence. Pending/review is not absent and is not verified attendance; reserve green confirmation for a server-confirmed record. Keep the state visible after closing the scanner, navigation, and restart.

## 2. Reliability contract and architecture

### Non-negotiable behavior

1. No acceptance, rejection, expiry, attendance ordering, or absence decision depends on a student's or professor's wall clock or stopwatch.
2. “Saved on this device” means a completed local transaction, not a camera callback or successful IndexedDB request. “Confirmed” means a committed backend record.
3. An acknowledged receipt remains pending until a durable backend response is itself saved locally. Authentication, transport, and server errors never silently discard it.
4. At-least-once delivery produces one canonical attendance record per actual roster student and session. Repeated requests never inflate headcount.
5. Device sharing, unknown device identity, delayed synchronization, and headcount overflow do not by themselves reject an eligible student.
6. A QR proves possession of a session credential, not physical presence or exact scan time. Accepting offline receipts sacrifices strong prevention of screenshot sharing. Do not market this as fraud-proof attendance.
7. Every unresolved case has a visible student status, a professor review path, and an auditable correction path. Recovery is not equivalent to automatic acceptance of arbitrary or forged submissions.

### Backend ownership

```text
Cached app + Firebase identity
          |
QR scan -> committed IndexedDB receipt -> pending schedule row
          |
authenticated HTTP API (Firebase Admin verifies token)
          |
Supabase transaction -> receipt + canonical attendance + audit
          |
acknowledgement / scoped reads -> confirmed or review-needed row
```

- Firebase remains the identity provider and source of existing roster, staff permissions, and published timetable data. Do not migrate authentication or duplicate attendance writes into Firestore.
- Extend the existing shared-handler factory pattern with `shared/attendanceApi.ts`, mounted identically by development and production entry points. Do not introduce a second Firebase Functions API deployment merely for this feature.
- All attendance reads/writes go through this API to Supabase. Reuse the server-only Supabase client; no service-role credential reaches the browser. A missing Supabase configuration is an availability error, never a silent Firestore fallback.
- Cache an institutional roster/UID-binding snapshot in Supabase when preparing the dated attendance session. Fetch it once per preparation/explicit refresh, not once per scan. Keep snapshot version/source information, and use an authorized refresh to resolve corrections. Missing or conflicting bindings become review items, never nickname-based matches.
- Student submissions use the snapshot's trusted UID-to-roster mapping. Staff writes and review actions check current server-side staff capabilities and stage scope. No client-selected role, professor ID, real name, or student UID grants authority.
- No direct Firebase-to-Supabase third-party-auth integration is necessary for this gateway design. Do not introduce `auth.uid()` UUID assumptions or change existing Firebase role claims.

## 3. Models and public interfaces

### Institutional identity and dated occurrences

- Add an attendance term definition with stage, term ID, start date, week boundaries, holidays, and timezone `Asia/Baghdad`. An authorized staff member configures it; do not infer semester weeks from free-text timetable labels or local device dates.
- Materialize dated occurrences from the published timetable and chosen teaching weeks. Each gets a stable `occurrenceId`, `termId`, `stageId`, source timetable row/version, institutional date, title snapshot, start/end instants, and audience/subgroups. Preserve historical occurrences when a timetable is edited; new/replacement occurrences require explicit mapping or cancellation.
- Never treat a timetable title as a curriculum subject ID. Preserve combined titles and audience rules. Include Saturday when configured; do not silently drop teaching days outside Sunday–Thursday.
- At session creation the professor explicitly selects the occurrence and verifies its displayed date. The backend checks permissions and occurrence identity, rather than trusting the professor laptop's current date. Permit audited schedule overrides.

### Supabase entities

Use UUIDs for new attendance entities, `text` for Firebase UIDs and existing roster/stage/timetable identifiers, `timestamptz` for authoritative instants, and a `date` for the institutional lecture date.

| Entity | Required behavior/data |
| --- | --- |
| `attendance_terms`, `attendance_occurrences` | Dated academic identity, audience and title snapshots, cancellation, timezone, immutable historical linkage. |
| `attendance_session_roster` | Session, canonical roster ID, trusted Firebase UID bindings, official `Student.name`, minimal searchable roster identifier, subgroup, source version. Never copy passwords or the entire student document. |
| `attendance_sessions` | Occurrence, authenticated professor UID, expected headcount, notes, `active / ended / finalized / cancelled`, server-created/ended timestamps, reconciliation deadline, revision. One canonical session per occurrence; concurrent creation returns the existing session. |
| `attendance_challenges` | Session, random challenge ID, exact issued-token hash, issuance timestamp, signing key ID, explicit revocation metadata. Preserve validation information for historical uploads. |
| `attendance_receipts` | Request UUID, authenticated actor UID, canonical payload hash, challenge/session, server receipt timestamp, resolution, reason, canonical record reference. Request IDs are immutable and globally unique. |
| `attendance_records` | Session, canonical roster ID, bound student UID, official name snapshot, `confirmed / voided`, `qr / manual`, server receipt/decision timestamps, nullable reported client time, review flags, revision. Unique `(session_id, roster_student_id)`; no physical-device uniqueness constraint. |
| `attendance_audit_events` | Actor, request, session/record, action, reason, before/after revision, server timestamp. Append-only for manual entries, edits, review, void, restore, and finalization. |

- A QR record's exact `scanTime` is not known: replace it with `receivedAt`, `decidedAt`, optional untrusted `clientReportedAt`, and `scanTimeConfidence: 'unknown'`. Neither a signed issuance timestamp nor an upload timestamp is labeled “actual scan time.”
- Device identity becomes optional `installationId`, not “hardware UUID.” Reuse the old localStorage key only as a migration input if it exists; generate/store in IndexedDB otherwise. If unavailable, proceed without it. Store a server-keyed, session-scoped digest for correlation, not a cross-session hardware fingerprint.
- Do not persist a misleading per-student `isOverflow` verdict. Compute session discrepancy as `confirmedDistinctStudents > expectedHeadcount`. It identifies a mismatch, not which student is fraudulent.
- Index receipt requests; records by session/roster and student/session; occurrences by stage/term/date; challenges by challenge ID; and audit events by session. Use foreign keys and check constraints. Verify plans with realistic row counts before release.

### Client service contract

- `createAttendanceSession(occurrenceId, requestId, headcount)` returns canonical session, signed QR, and authoritative server time.
- `updateAttendanceSession(sessionId, requestId, expectedRevision, patch)` supports authorized notes, headcount, and lifecycle updates with conflict detection.
- `captureAttendanceScan(rawQr)` parses bounded input and commits a receipt; returns `saved_locally`, `already_saved`, or `not_saved` with actionable recovery. It does not require a live network.
- `subscribeToAttendanceState(uid, listener)` publishes hydrated local receipts merged with backend results; scanner and weekly schedule use this same source.
- `syncAttendanceReceipts()` uploads only receipts owned by the currently authenticated UID and reconciles per-item results.
- `subscribeToSession(sessionId, listener)` provides a near-real-time professor snapshot using bounded polling, with explicit freshness state; it is not a Firestore listener.
- `fetchStudentSemesterAttendance(termId)` derives the caller from authentication and returns only their scoped occurrences, records, and review results.
- `markManualAttendance(...)`, `resolveAttendanceReview(...)`, and `voidAttendanceRecord(...)` require request ID, current revision, authorized actor, and reason. A void is reversible through a separate audited restore action, never physical deletion.

### HTTP surface

- `POST /api/attendance/sessions`; `PATCH /api/attendance/sessions/:id`.
- `GET /api/attendance/sessions/:id` for authorized professor snapshot/version and paginated official roster.
- `POST /api/attendance/receipts:sync` for batches of at most 25 receipts and 128 KiB; return one durable result per processed request ID. Transport failure is not a per-item rejection.
- `GET /api/attendance/mine?termId=...` for the authenticated student's schedule/history, including canonical revisions.
- `POST /api/attendance/sessions/:id/manual`; `POST /api/attendance/reviews/:id/resolve`; `POST /api/attendance/records/:id/void`; `POST /api/attendance/records/:id/restore`.
- Sync input contains `requestId`, signed QR, optional installation ID, and optional diagnostic client time. It does not accept authoritative student names, roles, elapsed seconds, or client-selected acceptance times.
- Sync results distinguish `confirmed`, `already_recorded`, `needs_review`, and `invalid_evidence`; include current canonical state/revision, receipt ID, reason code, and server time. Authentication failures pause upload, not erase capture. A duplicate of a subsequently voided record returns its current voided state, not an obsolete green confirmation.

## 4. QR protocol, durable capture, and reconciliation

### Session credential

1. After authenticated session creation commits, issue a versioned compact JWS signed server-side with ES256. Include `kid`, challenge ID, session/occurrence/stage/term identifiers, a small dated lecture label, and server issuance time. Include no student PII and no client-enforced expiry. Store the exact token hash with the challenge. Keep the QR payload below 2 KiB and reject unknown versions/algorithms on the backend.
2. Display/cache this credential on the professor device. Normal v1 operation uses one session credential, not short-lived rotating codes that penalize offline students. Explicit replacement revokes the old challenge for automatic acceptance but preserves it for review.
3. The offline app stores the complete QR bytes plus a new request UUID and cached owner UID. Cached verification keys may validate the signature locally, but unknown keys or unavailable crypto do not discard a structurally valid receipt; it remains explicitly unverified pending server validation. Decoded offline labels are display hints, never authorization.
4. On upload, validate signature, exact issued-token hash, challenge/session binding, authenticated UID, and trusted roster mapping on the server. Do not use JWT `iat` as the scan time or impose the scan application's `Date.now()` on token verification. Firebase authentication tokens retain their normal server-side expiry checks.
5. Invalid signatures or fabricated session credentials do not grant attendance. Preserve an explanatory local receipt state and offer manual review. Revoked, cancelled, mismatched, or too-late otherwise valid receipts become review cases.

**Explicit tradeoff:** The same QR can be photographed and relayed. Signature verification prevents forgery, not forwarding. Strong physical-presence proof and unrestricted offline acceptance cannot both be supplied by this QR-only protocol. Review and professor observation are the chosen controls; device UUIDs, GPS, and exact-time claims are not substitutes.

### Persistence and restart algorithm

1. Add attendance outbox, receipt-cache, and schedule-cache stores in a non-destructive upgrade of the existing IndexedDB database (next version after the current version 4). Store schema version, owner UID, request UUID, exact QR, occurrence hint, optional installation ID, and sync state. Do not persist auth tokens inside receipts.
2. Check for an existing receipt for the same owner/session inside the write transaction, so repeated camera callbacks reuse it. Different requests are still safely deduplicated at the backend.
3. Commit the complete receipt atomically. Resolve on `transaction.oncomplete`; reject on abort/error. Do not reuse the existing request-success acknowledgement semantics. Request `{ durability: 'strict' }` where supported and document fallback storage durability rather than claiming hardware guarantees.
4. Only after completion emit “Saved on this device,” show receipt ID, update the schedule, and close the scanner. If local storage fails but the network is available, attempt authenticated server submission; only a committed backend acknowledgement can then show confirmation. Otherwise show “Not saved — ask the professor to record attendance.”
5. On cold launch, read the outbox before deriving schedule status. Recover leftover in-flight items to pending; retry the original request IDs. No stopwatch, unload handler, continuously running timer, or reconnect event from the previous process is needed.
6. Save backend resolution plus canonical record locally and remove/retire the pending item in one completed local transaction. If power fails after server commit but before local acknowledgement, replay safely. Keep a lightweight receipt history; do not delete unresolved/review receipts automatically.
7. Request persistent storage with a user-facing explanation where supported; detect unavailable/full storage and provide recovery. Persistence permission is not guaranteed, and does not protect against explicit data deletion, uninstall, or hardware failure. Warn before account logout/reset when pending receipts exist; logout hides other users' receipts but does not silently erase them. Explicit user-requested destructive clearing must warn about unsynced data.
8. Precache the attendance route, scanner dependency, and necessary app shell on supported web/PWA builds; cache identity and schedule during normal online use. Native builds must bundle those assets and test WebView persistence. First-ever use while offline is not promised; professor/manual recording remains available.

### Synchronization and server transaction

- Run a single in-process sync worker on startup, sign-in/token refresh, network hints, foreground/resume, and a visible Retry action. Use short request timeouts and exponential backoff with jitter, capped at 60 seconds while foregrounded. Reset relative retry timers on restart; do not let a stored wall-clock deadline block retries for years.
- `navigator.onLine` is only a hint. Probe through actual API requests; handle captive portals, DNS/TLS failure, timeout, malformed gateway responses, 429 and 5xx as pending. Background sync is optional optimization, never the only recovery path. Reopening the app online must resume synchronization.
- On 401 try one normal Firebase token refresh, then enter `waiting_for_login` if needed. Do not sign out or delete the queue for a transient failure. Never upload account A's receipts under account B's token, and never rewrite ownership to “fix” a mismatch.
- Use one short Postgres RPC transaction per receipt: bind verified actor, verify registered challenge and session eligibility, enforce idempotency, resolve canonical roster identity, upsert the one record, append audit if needed, update session revision, and return the committed outcome. Do not attempt an HTTP check-then-insert sequence. Perform remote authentication/roster-source calls outside database locks.
- Serialize affected session mutations consistently with a short session-row lock, including close/finalize/void, so counters/revisions and concurrent submissions agree. Put uniqueness constraints under the transaction; compute distinct confirmed count rather than incrementing a blind counter. Keep timeout/retry behavior visible and load-test the contention point.
- Same request/actor/payload returns existing receipt plus current canonical state. Reusing a request ID with different actor/payload is an idempotency conflict, not an overwrite; retain evidence and require recovery. Separate requests for the same roster student/session return the same canonical record, without duplicate attendance. Retries cannot restore a voided record.
- `ended` stops the projected collection UI, not legitimate delayed uploads. Default automatic reconciliation window: seven days after the later of scheduled end or actual server-recorded end. Use server receipt time only. Even a forgotten active session does not accept new automatic confirmations forever.
- Within that window, an otherwise valid receipt with a unique trusted roster binding confirms attendance. Installation reuse and headcount excess attach review flags without rejecting confirmation. Beyond the window, or after finalization, preserve a `needs_review` claim and allow an authorized correction without a technical hard deadline.
- Finalization is explicit, server-authorized, and blocked before the reconciliation window closes or while known unresolved cases remain. The server cannot know about receipts still stranded on a device. A later valid claim can correct a provisional absence through review; an offline client never turns a locally pending receipt red just because the session closed.

## 5. Student and professor behavior

### Student schedule state

Use the exact occurrence ID, not course title, weekday, or `lectureId` alone. Never let last week's attendance color this week's lecture.

| State | Presentation | Counts |
| --- | --- | --- |
| Confirmed canonical record | Green, “تم تأكيد الحضور” / “Attendance confirmed” | Confirmed attendance |
| Committed local receipt, unsynced | Neutral/amber, “تم الحفظ على هذا الجهاز — بانتظار المزامنة”, receipt ID | Pending, separate from confirmed |
| Uploading or waiting for login | Same saved receipt plus syncing/login action | Pending |
| Needs review or record voided | Explicit review/reason/appeal state, not silent disappearance | Separate review count |
| No claim, occurrence upcoming/unfinalized | Upcoming or “Not yet finalized” | Not absent |
| Server-finalized absence, no local pending/review evidence | Red “Absent” with correction route | Absence |
| Unavailable/unhydrated data | Loading/unknown with last-known freshness | No guessed absence |

- Apply the newest canonical revision first; a confirmed record remains confirmed despite duplicate local retry. A voided record stays under review until an audited restore. Local pending evidence overrides stale absence, but never overrides a newer explicit void with green confirmation.
- Hydrate local evidence before showing attendance colors. If an occurrence is not in the cached schedule, render the QR's dated pending item in a visible “Unmatched pending scans” area until server mapping resolves it; do not silently drop the receipt.
- Summaries say, for example, “8 confirmed / 9 lectures; 1 pending.” Keep cancellations/excuses separate from counted eligible lectures. Use text/icons in addition to color and accessible live announcements after save.
- Expand the server-indicated current academic week by default. Offline, use the last synchronized week and identify stale data; automatically open/highlight the scanned occurrence's week. Allow navigation without dependence on a correct device date.
- Preserve the established Arabic/English, RTL, light/dark styling. Use flat semantic states and existing components, not gradients, decorative AI styling, or ambiguous success animations.

### Professor controls and recovery

- Keep official real-name search and roster labels. Search `Student.name` and approved roster identifiers only, never account nicknames. Distinguish identical names with the minimal institutional identifier; do not expose a full roster to students.
- Display confirmed count, pending review count, headcount discrepancy, and last successful refresh independently. Offline submissions are not yet visible to the professor; say so rather than presenting the live counter as an exact physical headcount.
- Sort the table by server receipt time with a stable tie-breaker and label it “Received,” not “Scanned.” Offline scan order is unknown. Do not put “excess students” at the bottom as if that establishes guilt.
- Replace one-click destructive overflow removal with a selected student's reasoned, confirmed, audited void; provide audited restore. Changing expected headcount never invalidates attendance automatically.
- Cache authorized roster/session data for professor manual drafts. Queue offline manual actions under the professor UID; verify current permission and record revision when uploading. Lost permissions or conflicts remain reviewable, not silently applied. Give the student a provisional reference while a manual draft is unsynced.
- If the professor loses connectivity after caching a session QR, keep displaying it. If no valid session credential was prepared before losing connectivity, use the cached roster/paper fallback; do not manufacture an unsigned accepted session or fake successful server creation.
- Handle camera denial/unavailability with instructions, a typeable session reference for instructor-assisted recovery, and manual recording. Torch and camera switching are conditional capabilities, not prerequisites.
- Autosave notes with debounce, visible saved/pending/error state, revision checks, and local draft preservation. An unsaved change is never labeled saved.

### Navigation and authorization

- Keep tab ID `simosan`, rename its label to “الخدمات” / “Services,” and use an existing neutral services/grid icon.
- Wire the hub's existing attendance callback and show `SimosanPage` with a return-to-hub action. Leave unrelated service cards and the existing AI tutor unchanged.
- Add an explicit stage-scoped `manageAttendance` capability to the server's staff capability model; default deny, with the established master-admin override. Do not assume existing administrators/moderators are professors or infer authority from timetable teacher text. Sessions belong to an authorized stage operator; another operator with that capability can perform audited recovery.
- Render professor controls only for authorized staff. A development role switcher may preview fixtures under `import.meta.env.DEV`; it never changes authenticated permissions and is absent from production.

## 6. Security, quotas, and availability

- Enable RLS on every new exposed table. Revoke table privileges and RPC execution from `PUBLIC`, `anon`, and browser `authenticated` roles; grant required server operations explicitly. Use server-only, security-invoker RPCs where possible. The service role bypasses RLS, so every gateway handler must enforce actor, stage, and record scope; RLS is not a substitute for gateway authorization. Do not change grants for existing unrelated tables.
- Student endpoints derive identity from the verified Firebase token and expose only that student's records. Staff endpoints use authoritative capabilities and stage ownership. Scope all lookups even when a caller guesses another session/record UUID. Do not log raw QR credentials, full roster PII, auth tokens, or Supabase secrets.
- Keep signing keys and Supabase credentials in server secret configuration. Retain historical verification keys until receipt review/retention no longer needs them; compromised credentials move affected claims to review without deleting already collected evidence.
- V1 professor updates use a three-second foreground polling interval, returning a small revision/count response if unchanged and fetching roster pages only on changes. Slow to fifteen seconds when idle, stop while hidden, refresh immediately on focus, and expose stale state on failure. Paginate at 100 rows with a snapshot revision; if pages span revisions, refetch instead of combining inconsistent totals. This is explicitly near-real-time, not a guaranteed push stream.
- Students fetch their own term snapshot on opening/focus and after synchronization; do not attach one class-wide roster subscription per student. Request batches, indexed lookups, and server-derived counts limit load without pushing every attendance event through Firestore.
- Retain the existing Firebase login system; an attendance capture must not require a successful refresh at scan time. TLS validation stays enabled. There is no “accept any token when offline” server bypass.
- Supabase avoids making Firestore the attendance read/write hot path; it is not unlimited or automatically cheaper. Measure database compute, storage, API-host invocations, connection limits, egress, and retry amplification against the actual project plans before launch.
- Alert on API/database failures, old unresolved receipts observed by the server, local-storage errors reported on reconnection, roster-binding misses, stale professor views, and reconciliation backlog. Do not claim backend monitoring can see a phone that has never uploaded its receipt.
- Export and restore-test attendance/audit data. Keep a documented instructor fallback and reconciliation procedure during outages. A feature flag may disable new session creation, but must leave pending receipt upload, review, and history available.

## 7. Implementation sequence and release gates

### Build order

1. Add shared attendance types, dated occurrence/calendar logic, receipt outcome/state reducer, and test fixtures. No runtime attendance behavior is changed by this document.
2. Add versioned, additive Supabase migrations for tables, constraints, indexes, grants, and transactional RPCs. The repository currently has a SQL bootstrap script, not an attendance migration history: initialize an imperative Supabase migration workflow and generate migration names through the CLI rather than inventing applied history. Validate on a local/test database; no automatic production push.
3. Add gateway handlers, scope/capability checks, signing, roster snapshot preparation, and development/production route-parity tests.
4. Add IndexedDB transaction-complete persistence, schema upgrade, retry/recovery worker, and shared schedule-state subscription. Test failures before building optimistic UI around it.
5. Implement professor/student views, exact-occurrence schedule mapping, service navigation, official-name search, and recovery UX. Reuse the already-present QR libraries; do not overwrite unrelated package changes.
6. Run automated checks, physical-device fault tests, and capacity tests; pilot one stage under a feature flag before general release. Retain evidence of tests instead of marking this design “100% reliable” by inspection.

### Automated tests

Add focused TypeScript tests in the existing `scripts/*.test.ts` style and a local Supabase integration suite. Browser persistence tests must use real IndexedDB; simple object/localStorage mocks are insufficient. Pin any added test dependencies through the repository lockfile.

| Scenario | Required assertion |
| --- | --- |
| Professor clock +/-2 years; student clock +/-3 hours; timezone changes | Same valid QR maps to the same occurrence and acceptance result; no client time gate. Test transport failure separately from business logic. |
| Student clock changes after offline capture | No elapsed reconstruction; immutable receipt still uploads. |
| Offline capture -> navigation/process kill -> restart -> upload | Same receipt/request ID recovered; one canonical record. |
| Power interruption before local transaction completes | No saved acknowledgement; recovery/manual instructions remain accurate. |
| Power interruption after local completion | Committed receipt recovers on supported devices; document actual durability limits. |
| Server commits but response/local acknowledgement is lost | Retry returns canonical result, no duplicate count/audit action. |
| IndexedDB request succeeds then transaction aborts | Capture reports not saved; no false schedule success. |
| Outbox schema upgrade and blocked upgrade | Existing receipts preserved; blocked upgrade gives an actionable recovery state. |
| Camera permission denied; torch unavailable; storage full/private mode | No uncaught exception or false success; manual/server fallback offered. |
| Same student scans repeatedly, two tabs, concurrent API requests | One roster-student attendance record; deterministic current-state replies. |
| Two legitimate students share an installation | Both receipts can be captured/confirmed under their own authenticated identities; device anomaly flag only. |
| Account switch while receipts are pending | No cross-account upload or disclosure; original owner's receipts recover after re-login. |
| Expired token, revoked/disabled account, missing roster binding | No unauthorized acceptance; receipt preserved with login/review recovery and no automatic technical-failure absence. |
| Shared QR, forged QR, changed session ID, old signing key | Relay risk explicitly demonstrated; forgery denied; registered old keys validate; revocation routes to review. |
| Session closes before the student reconnects | Upload during seven-day grace confirms if otherwise eligible; later upload becomes review, not lost evidence. |
| Scan in week 2 of the same timetable lecture | Only week 2 occurrence changes. Cancellations and combined titles remain correct. |
| Missing cached occurrence / cached red absence | Pending scan remains visible and overrides stale absence; no guessed record binding. |
| Headcount 5, six legitimate records, late offline receipt | Six records remain; discrepancy shown; no automatic deletion or “last arrival = fraud.” |
| Void/restore races with queued retries | Audit and revision checks hold; replay never resurrects a void. |
| Client changes UID, stage, role or official name | Server ignores/rejects untrusted authority; no cross-stage access or nickname substitution. |
| Direct anonymous/authenticated Supabase requests | Attendance data/RPCs inaccessible; only authorized gateway calls succeed. |
| Production/development route parity | Both entry points mount all handlers with required auth; production has no role switcher. |
| Reconnect without `online` event, captive portal, app backgrounding | Focus/startup/manual retries recover; no reliance on background execution. |

Run `npm run lint`, `npm run test:offline`, `npm run test:auth-session`, `npm run test:timetable`, and the new focused unit/integration/browser suites during implementation. Build web and native bundles and verify attendance/scanner assets remain available offline. Record unrelated existing failures separately.

### Physical-device and operational acceptance

- Test Safari/iOS, Android Chrome, and the packaged Capacitor apps on supported OS versions: airplane mode, screen lock, browser force-close, device restart, battery/power interruption, several-day delayed upload, storage pressure, and offline cold launch. DevTools offline simulation alone does not certify these cases.
- After a completed local save, the pending lecture row and receipt ID must appear without a network round trip and survive normal restart. Under healthy connectivity, recovery converges to exactly one canonical record. Green must never precede server confirmation.
- Exercise manual paper/cached-roster capture with the professor fully offline and later reconcile without requiring the student to scan again. Test storage loss explicitly: do not claim the destroyed local receipt can be recovered without an independent copy or instructor evidence.
- Initial capacity gate: 1,000 submissions across ten sessions within 60 seconds, concurrent instructor views, duplicate retries, and one interrupted backend response. Require zero lost committed records/duplicate attendance, stable queue recovery, and target p95 API latency below two seconds on the selected deployment. This is a test workload/target, not a capacity claim; size deployment from measurements.
- Before broad rollout, verify modern TLS compatibility of the API server's Supabase client and supported student browsers. The Supabase changelog announces removal of older TLS 1.2 CBC suites starting no earlier than 2026-11-10; do not work around failures by weakening TLS.
- Sign off separately on data correctness, recovery behavior, UI reassurance, authorization, and acceptable QR-sharing risk. Any claim of “zero false rejection under every possible condition” remains unachievable.

## 8. Supporting references

- [W3C High Resolution Time, clocks](https://www.w3.org/TR/hr-time-3/#clocks): wall-clock changes and the execution-limited scope of monotonic clocks. This reference is a working draft; the plan does not depend on future browser behavior.
- [IndexedDB specification, transaction durability](https://w3c.github.io/IndexedDB/#transaction-durability-hint): completion and durability hints; strict durability reduces risk rather than promising indestructible storage.
- [WHATWG Storage Standard](https://storage.spec.whatwg.org/): persistence permission and storage clearing boundaries.
- [Firebase ID-token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens): authenticate server requests with verified Firebase identities.
- [Supabase API security](https://supabase.com/docs/guides/api/securing-your-api): explicit grants, RLS, and exposed database APIs.
- [Supabase Firebase Auth integration](https://supabase.com/docs/guides/auth/third-party/firebase-auth): available if direct client access is designed later; not required for the existing server-gateway approach.
- [RFC 5280 certificate validation](https://datatracker.ietf.org/doc/html/rfc5280#section-6.1.3): certificate validity is time-dependent, so incorrect device clocks can remain a transport-layer problem.
- [Supabase TLS deprecation notice](https://supabase.com/changelog/cbc-tls-ciphers-deprecated): check supported client/server TLS before rollout.
