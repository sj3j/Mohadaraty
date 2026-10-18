# Simosan attendance: implementation and release plan

Updated 2026-10-16, Asia/Baghdad. This specification supersedes the earlier seven-day/advisory-device proposal. Code exists; production deployment and operational certification are not complete.

## Confirmed decisions

- Firebase Authentication identifies callers. Firebase retains verified roster and timetable data. Supabase Postgres owns attendance; its service-role key never enters a student, lecturer, or Windows executable bundle.
- Student uploads must reach the database no later than **36 hours after the scheduled lecture end**. Closure, reboot, later lecturer synchronization, and device clock changes never extend this deadline.
- A late receipt is preserved but ineligible for QR confirmation. The lecturer may make a separate, reasoned manual correction based on independent evidence. A timely receipt awaiting identity review may be decided after its deadline.
- One installation cannot automatically record two students in one session. One student can attend any number of lectures using that installation. Supervised device enrollment prevents simply logging a friend's account into a second unapproved phone. A replacement phone requires identity verification again.
- Lecturers prepare their device online once, downloading a full-cohort roster and authorized dated timetable occurrences. They can subsequently create sessions for those occurrences, show QR codes, enter manual attendance, and save notes/closure locally without internet.
- Student scans do not need to update a fully offline lecturer's counter immediately. Local manual drafts appear immediately; remote receipts appear after synchronization. An offline count is explicitly not advertised as a live hall count.
- Substitution credit must use an explicit subject + theory/practical mode + teaching-unit link. A matching title, week, or subgroup is never sufficient. Automatic substitution remains disabled until that separate linkage model and its tests are implemented.
- Deprivation thresholds, 15% rules, and sanctions analytics are out of scope for this release.
- Preserve the requested Arabic disciplinary banner verbatim. Its legal consequences and claims about device/time fingerprinting require institutional approval; the software does not establish physical presence or a trusted offline scan timestamp.

## Reliability audit

### 1. Can a legitimate student ever be blocked?

**Status: PARTIAL RISK.** A validly formatted receipt is saved before a network request, and network/authentication failures preserve it. However, unavailable storage/camera/power, unapproved devices, deliberate device sharing, and uploads beyond 36 hours prevent automatic confirmation. The strict deadline is a policy choice that can affect genuinely present students during a prolonged outage.

**Required recovery:** Display a not-saved error when the local transaction fails; never show fabricated success. Preserve ineligible evidence, provide identity-checked manual recording, and keep a paper contingency. Neither browser code nor an executable can guarantee success after storage destruction or prove who physically holds a phone.

### 2. Are broken clocks accepted?

**Status: PASS for application-level eligibility; PARTIAL RISK for transport.** QR credentials identify the exact dated occurrence. The database uses its own receipt time and a fixed scheduled deadline. Client wall clocks and `elapsedSeconds` are never eligibility inputs. Times are displayed in Asia/Baghdad. Wrong clocks can still break HTTPS or Firebase token renewal; cached capture and manual recovery remain necessary.

**Required operational check:** Test extreme clock errors on supported real devices without weakening TLS. Local saved-at fields are diagnostics, not proof of scan time.

### 3. Does evidence survive reboot?

**Status: PARTIAL RISK pending physical-device certification.** IndexedDB commits the immutable credential, account UID, request ID, installation proof, and occurrence reference. Save acknowledgement waits for transaction completion with strict durability requested. Reopening the database restores the same key and receipt; retries use the original request ID. No stopwatch is reconstructed across processes.

**Required release gate:** Real Windows/mobile process termination, restart, storage-pressure and power-interruption tests. A simulated database reopen is not proof against hardware failure or browser eviction.

### 4. Is there immediate visual reassurance?

**Status: PASS in implemented state logic; visual/device QA outstanding.** The schedule merges canonical attendance with persisted receipts and hydrates local evidence before rendering absence. Pending rows display “تم الحفظ على هذا الجهاز — بانتظار المزامنة” and the actual request ID. Only backend-confirmed records are green. Cached or truncated history never creates a new absent state; a locally pending receipt outranks absence.

## Implemented architecture

### Server and authorization

- Both HTTP entrypoints use `shared/attendanceApi.ts`, Firebase token verification, and private/no-store responses.
- Existing stage-scoped `manageAttendance` staff permissions remain authoritative for administrators.
- Dedicated lecturer authority lives in the server-only Firebase document `attendanceDoctors/{firebaseUid}`:

  ```json
  { "enabled": true, "stageId": "stage_3", "timetableSessionIds": ["explicit-published-timetable-id"] }
  ```

- A display role or subject title does not confer authority. Each management operation checks the actual stage/timetable assignment. Disabled staff lose authority. These documents have no client write grant; only privileged administration may provision them.
- Supabase tables have RLS enabled and browser-role privileges revoked. All RPCs use invoker security and an empty search path. Service-role access still requires the gateway's authorization checks.

### Offline lecturer delegation

1. The local installation creates a non-extractable P-256 private key in IndexedDB.
2. An authenticated, authorized preparation request sends only its public key. The server creates a signed permit and immutable full-cohort/schedule snapshot in `attendance_offline_grants`.
3. The client saves the complete pack before reporting readiness. Only downloaded, authorized dated occurrences can be used offline; arbitrary unprepared lectures need online setup or manual contingency.
4. The lecturer signs QR credentials locally. The server signing secret is never distributed. Session IDs are deterministic per dated occurrence, preventing independent offline installations from creating duplicate lecture identities.
5. A student's first upload can import the session and challenge before the lecturer reconnects. The backend verifies both signatures, stored grant, current authority, and immutable occurrence fields. Import does not move the scheduled deadline.
6. Lecturer session snapshots and import commands commit atomically. Manual entries, notes, headcount edits, and closure persist under the lecturer's UID. Import precedes dependent commands. Conflicting edits remain visible for correction instead of silently overwriting another operator.

### Student evidence and device policy

- The student installation signs the immutable receipt envelope. The server derives stable device and session-scoped installation digests; a user-submitted UUID alone does not grant trust.
- The local session claim and receipt commit together. A second account's evidence is saved as requiring manual attendance, not silently lost or represented as confirmed.
- The backend atomically claims an installation for a canonical roster student. Voiding a record does not release the device claim. Enrollment or replacement requires explicit lecturer identity verification; shared-device conflicts cannot be bypassed with the QR review-confirm action.
- Startup, foreground, reconnect, and manual retry trigger account-bound synchronization with bounded retry delays and network/authentication timeouts. An account switch cannot upload another account's queued evidence.
- Requests and canonical student/session records are idempotent. Retries return the current confirmed/voided revision and cannot restore a voided record.
- Optional scan-time GPS and short same-runtime reconnect hints are advisory. Missing permission never blocks local saving. Upload-time coordinates are not capture evidence. Raw coordinates are discarded after successful synchronization; the backend retains coarse distance/accuracy flags only.
- Lecturer tables label timestamps **Received**, not Scanned. Flags sort for review but never prove fraud; overflow is a session warning, not permission to remove the latest arrivals automatically.

## Interfaces

- The live student view uses real receipts and history, not mock attendance or generated success codes. Local receipt state updates immediately; remote history refreshes on foreground/reconnect, manual retry, and a two-minute visible-page interval. The scanner has no demonstration-success button.
- The current lecturer portal uses signed session QR credentials, a cached full-cohort roster, real confirmed counters, offline-pack preparation, local manual drafts, identity review, audited void/restore, and a scoped Supabase-backed attendance matrix. The matrix pages twenty dated lectures at a time and refreshes on demand; the selected live session polls every ten seconds. After the fixed deadline and resolution of reviews, the lecturer can finalize an ended session, enabling explicit absence display. Confirmed and pending manual counts remain distinct.
- Lecturer login has a dedicated Firebase email/password path; student custom-token login remains unchanged.
- The master-admin Settings modal provisions doctor accounts through privileged Firebase Admin endpoints. One or two college subjects must be explicitly linked to distinct stage timetable slots. The server stores immutable slot-to-subject links separately from the doctor account so student subject cards never rely on matching titles. Account disable removes attendance authority and revokes refresh tokens.
- Spreadsheet cells use reasoned manual confirmation and audited void/restore. If a dated lecture has no session, the lecturer must supply a physical headcount before the first cell correction creates one. Excused/explicit absence entry and 15% sanctions are disabled until institutional rules and a dedicated correction model are approved. Student subject cards, weekly occurrences, and local pending receipts use live data; no sample attendance is displayed.
- `POST /api/attendance/receipts/sync` is the canonical verification endpoint; the mock JSON QR and `/api/attendance/verify` handoff sketch are not wire protocols. A short rotating display cannot invalidate earlier offline scans while preserving the 36-hour submission policy, so old signed challenges remain redeemable within that window. QR forwarding is therefore a known limitation, with advisory location and device review.

## Operator setup before any pilot

1. The three attendance SQL migrations were backed up, staged, and applied in order to the configured Supabase project on 2026-10-17. Remote migration history, RLS/privileges, database advisors, and Ghazwan's authenticated lecturer workspace were verified afterward. Apply the same ordered migrations before using attendance in any other environment; do not substitute edited files into an existing migration history.
2. **Required production attendance variables & crypto architecture:**
   - `SUPABASE_URL`: HTTPS URL to the Supabase project.
   - `SUPABASE_SERVICE_ROLE_KEY`: Server-only secret key (validated via zero-row read probe).
   - `ATTENDANCE_QR_KEY_ID`: Active key ID string (defaults to `attendance-v1`).
   - `ATTENDANCE_QR_PRIVATE_KEY`: P-256 (`prime256v1`) EC private key in PKCS#8 PEM format. Signs ES256 QR tokens.
   - `ATTENDANCE_QR_PUBLIC_KEYS_JSON`: JSON map of key IDs to P-256 SPKI PEM public keys. Must include the public key for `ATTENDANCE_QR_KEY_ID` matching the private key. Older retained public keys may be included for verifying receipts from previous sessions without overriding the active key.
   - `ATTENDANCE_INSTALLATION_SECRET`: At least 32 bytes of cryptographically random high-entropy material (base64url). **WARNING:** Treat as permanent infrastructure state; changing it invalidates all enrolled student device digests.
3. **Admin readiness endpoint & cache control:**
   - `GET /api/attendance/admin/readiness` is mounted in both `server.ts` and `api/index.ts`.
   - Access is strictly restricted to master admins with verified email addresses. Non-master or disabled accounts receive HTTP 403.
   - Returns HTTP 200 with `ready: true` only if all 6 checks pass (or campus boundary is disabled). Returns HTTP 503 if any required check fails.
   - PostgREST OpenAPI schema is inspected to verify all 12 attendance tables and 9 RPCs without invoking mutations. Internal readiness status is cached for at most 30 seconds.
   - Cache control middleware `Cache-Control: private, no-store` is mounted before all `/api/attendance/*` routes in both server entrypoints.
4. **Campus boundary status:**
   - Remains disabled (`ATTENDANCE_CAMPUS_*` absent) until verified coordinates and radius are officially provided by the college.
5. **Sanctions and deprivation analytics:**
   - Sanctions/15% deprivation analytics remain strictly unmounted and hidden until institutional policy is approved.
6. **Production preflight procedure:**
   - Run readiness check via authenticated master-admin token.
   - Verify doctor workspace GET returns valid stage occurrences and roster.
   - Verify student `/api/attendance/mine` returns HTTP 200.
   - Never insert synthetic attendance rows into the production database.
7. **First real operational pilot:**
   - The first real doctor-led lecture serves as the operational pilot to test the end-to-end mutation flow (session creation, QR scan, sync, review, and manual ledger).
8. Enable Firebase email/password authentication for lecturers. Use the master-admin Settings modal to provision `users/{uid}`, `attendanceDoctors/{uid}`, and `attendanceSubjectSlots/{slot}` through the authenticated server. Do not grant unrelated administrator permissions or put lecturer accounts in the administrator registry. Deliver initial passwords through an approved private channel; password reset, reassignment, and invitation delivery are later work.
9. The new Firestore attendance metadata collections must remain server writable only. They are not a substitute for the Supabase attendance ledger, and there is no separate Supabase `users` profile table in this architecture.
10. Sign in online, open attendance, download the offline pack, and confirm it is saved before disconnecting. Use an OS account appropriate for the cached full-cohort roster, and maintain a paper contingency.

## Windows executable status

The persistent offline protocol is implemented in the shared web client. **No Windows `.exe` installer has been built or certified yet.** The intended wrapper must bundle all assets for cold offline start, retain a stable private application data directory across upgrades, restrict navigation/IPC, keep Node privileges out of its renderer, and protect local secrets with OS-backed facilities where available. Never ship Firebase Admin or Supabase service-role keys in that executable. Test setup, restart, update, logout/account switching, and uninstall behavior on actual Windows machines before calling it ready.

## Verification

Run `npm run test:attendance`, `npm run lint`, and `npm run build`.

The attendance suite covers server-signature tampering, clock shifts, database reopen, transaction abort after request success, installation enrollment, multiple lectures/day, two accounts sharing an installation, duplicate/void retries, GPS advisory behavior, pending schedule precedence, direct-role denial, exact deadline/late/manual behavior, student-first offline import, permit revocation, and mutation idempotency. SQL tests run actual Postgres semantics through PGlite; they are not a production network/load test.

Still required before rollout:

- Browser and real-device camera/QR/foreground/reboot/offline cold-launch QA, including the Windows wrapper.
- Firebase/Supabase deployed integration and authorization tests using separate student, doctor, administrator, and disabled accounts.
- Real database multi-connection void/retry races and 1,000 submissions across ten sessions in 60 seconds, with no lost committed evidence or duplicate canonical records.
- Lost acknowledgements, expired tokens, quota exhaustion, unavailable backend, corrupt local storage, shared Windows profiles, and roster/assignment revocation tests.
- Explicit subject/mode/teaching-unit equivalence storage and one-credit-only substitution tests.
- Account password reset/reassignment, explicit excuse/absence correction policy, measured capacity/cost, and a one-stage pilot.

Do not describe these remaining gates as passed or the system as “100% error-free.”
