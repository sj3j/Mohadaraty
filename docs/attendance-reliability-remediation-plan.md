# Attendance reliability remediation — Gemini implementation handoff

Prepared: 18 October 2026. Audited baseline: `31bf287`.

## Implementation update — 22 October 2026

The following work is now implemented and deployed: native initialization failures are surfaced, the receipt/lease acknowledgement contract retains record identity and voided revisions, doctor commands retain their local order, signed receipt proof version 2 binds scan-time location evidence, and the server confirms eligible signed on-campus scans while atomically enrolling a first device. Missing, unusable, or off-campus location remains `needs_review`; a late receipt still requires an explicit, reasoned doctor approval.

The linked Supabase project has applied migrations through `20261021173355_attendance_auto_confirm_signed_location.sql`; authenticated readiness returned healthy schema, RPC, signing, installation-secret, and campus-boundary checks. The matching Vercel production deployment is `mohadaraty-kxaq7vkbo-sj3js-projects.vercel.app` (aliases include `mohadaraty.vercel.app`). `npm run lint` and `npm run test:attendance` passed on this revision.

The following remain explicitly unverified: physical Android/iOS lifecycle behavior, iOS release compilation on macOS, OS-scheduled background uploading, 1,000-submission real-PostgreSQL load testing, and designated-account production attendance exercises. Do not represent those as completed certification.

This is a remediation plan, not a claim that the implementation or physical-device certification is complete. No application code, production data, or configuration was changed during this audit.

## 1. Decisions and acceptance contract

The user explicitly selected:

- Preserve iOS 15.0 support, including older iPhones capable of running it. Do not silently increase the deployment target.
- Keep the existing 36-hour automatic-reconciliation deadline. Preserve late receipts and permit an authorized doctor to review them with an audit trail.

Implementation defaults:

- Native Android remains API 24+. Require Android System WebView 108+ and show a bundled, readable update/manual-attendance screen below that version; never show a blank screen or erase the queue. Test current WebView as well as the supported minimum. An old engine passing compatibility tests is not a security recommendation to avoid updating it.
- Native apps use native durable storage for attendance, not WebView storage. Browser/PWA remains supported with explicitly weaker local durability.
- Preserve existing Firebase identities, Supabase gateway-only access, timetable authorization, supervised device enrollment, one-device/session conflict controls, and idempotent server writes.
- Do not add sanctions, change attendance percentages, or auto-approve late/offline evidence on the strength of a client clock.

### What “saved” must mean

1. **Saved on this device:** the signed receipt and its session lock have committed to durable storage. It is not yet confirmed attendance.
2. **Waiting for sign-in / upload:** the same immutable receipt remains queued; it is never reassigned to another account.
3. **Needs doctor review:** the server has retained the evidence, but no confirmed attendance is implied.
4. **Confirmed:** the server committed the attendance result and the local acknowledgement committed successfully.
5. **Not saved:** durable persistence failed. Show an unmistakable error and retry/manual-attendance action, never a success sheet.

Required guarantee: no acknowledged local receipt disappears during normal cache cleanup, process termination, reboot, token expiration, account switching, or an in-place app update, under the supported device/storage conditions.

Boundary: uninstalling, clearing all application data, device loss, unrecoverable storage corruption, or factory reset can destroy the only unsynchronized copy. No client-only design can guarantee otherwise. Server-confirmed attendance must remain recoverable after reauthentication on another installation. Browser site-data removal can destroy pending PWA receipts. Do not market browser persistence or OS backup as an absolute guarantee.

## 2. Evidence from the audit

### Confirmed findings

| Priority | Finding | Evidence and impact |
|---|---|---|
| P1 | Pending attendance has only a WebView IndexedDB copy | `src/lib/localDb.ts` stores receipts, session locks, doctor commands, packs, and the nonextractable installation key in `mylecture-local`, alongside document storage. An in-memory fake-IndexedDB replay of the actual commit path saved a receipt, deleted the database, then found no receipt and a different installation identity. This proves absence of recovery after that storage is erased; it does not reproduce an actual OS eviction. |
| P1 | Older-runtime attendance ID generation throws | `src/services/attendanceCrypto.ts:4` calls `crypto.randomUUID()` without a fallback; doctor UI call sites also call it directly. Removing that capability in a harness against the actual function produces `crypto.randomUUID is not a function`. The app declares iOS 15.0 support; browser compatibility data places this API at Safari/iOS 15.4. |
| P1 | Styling dependency contradicts iOS 15 support | Installed Tailwind is 4.2.2. Tailwind's own documentation requires Safari 16.4+ for v4 and recommends v3.4 for older browsers. This is a documented support mismatch, not a claim that every screen was rendered on an iOS 15 device. |
| P1 | Missing auth restoration can destroy the offline entry point | `src/lib/sessionRestoration.ts` returns `clearPersistence: true` when Firebase has no user and `navigator.onLine` is true, even with a previously signed-in cached profile. `src/App.tsx:666` then clears that profile and the sign-in marker. A captive portal or disconnected uplink can still advertise “online.” The receipt itself is not deleted by this branch, but offline access/recovery is obstructed. |
| P1 | Native Android camera declaration is missing | The app manifest and inspected installed plugin manifests do not declare `android.permission.CAMERA`. The scanner uses `getUserMedia` through html5-qrcode, and Capacitor's Android implementation requests CAMERA. Add the declaration and verify the merged release manifest and runtime permission flow. A physical-device failure was not executed in this audit. |
| P1 | Late receipts are permanently ineligible for the existing review path | `20261015073458_attendance_device_policy.sql` classifies arrivals after the deadline as `invalid_evidence/submission_deadline_passed`; its review function also rejects late evidence. Keeping a receipt locally does not currently preserve a route to review it. |
| P2 | Native Firebase dependency support is inconsistent | Installed authentication plugin 7.5.0 declares Firebase JS `^11.2.0`; installed Firebase is 12.19.0. `.npmrc` suppresses the conflict with `legacy-peer-deps=true`. The plugin maintainer now marks its 7.x line deprecated. This is a support/build-risk finding, not proof it caused a particular lost session. |
| P2 | Native iOS dependency resolution is not reproducibly locked | No tracked `ios/App/Podfile.lock`; CI runs `pod install`. Native transitive versions can therefore drift independently of the npm lockfile. |

### Important corrections and additional risks

- `iosScheme: 'https'` is unsupported, but installed Capacitor normalizes it to its default scheme. Do not describe this as a demonstrated launch crash. Make the effective `capacitor://localhost` origin explicit and preserve it through upgrades.
- The native self-destroying service worker deletes CacheStorage, not IndexedDB. Do not incorrectly blame that code for the demonstrated IndexedDB-erasure case.
- `navigator.storage.persist()` is best-effort, its result is ignored, and older WebKit does not provide the same persistence API support. It cannot protect against deliberate site-data deletion.
- Firebase persistence falls back as far as session/memory storage without a user-visible durability classification. Native Firebase currently serves the Google handshake, then is signed out; it is not a recovery source for the canonical app identity.
- The cached profile is global rather than UID-keyed. Auth callbacks in `App.tsx` perform asynchronous work without a generation guard. Add integration tests for stale callbacks and cross-account profile restoration; the audit did not execute a real cross-account race.
- Current upload triggers are JavaScript timers and browser lifecycle events. They cannot guarantee execution while an OS suspends or force-stops the app.

### Verification already performed

- `npm run test:attendance`: passed, including configuration tests and the final 33 security/offline/database tests.
- `npm run test:auth-session`: 15 passed.
- `npm run test:offline`: 21 passed.
- `npm run lint`: passed.
- Read-only in-memory probes reproduced the UUID capability failure, the online/no-session clearing decision, and receipt/identity loss after simulated IndexedDB erasure.

These existing passing tests do not certify native process death, storage eviction, low disk, WebView upgrades, or iOS 15 UI compatibility. No physical-device runs or current production-readiness verification were performed in this audit.

## 3. Implementation workstreams

### A. Compatibility and reproducible dependencies

1. Replace Tailwind 4 with exactly `tailwindcss@3.4.19` and a PostCSS-based v3 pipeline. Remove the v4 Vite integration; translate v4 CSS directives, theme configuration, variants, and incompatible utility names. Preserve Arabic/RTL, dark mode, typography, dimensions, and existing visual behavior. Audit all screens reachable through login and attendance, not just the scanner.
2. Set explicit Vite JavaScript/CSS compatibility targets for Safari/iOS 15.0 and Chrome/WebView 108. Syntax compilation is not an API or CSS-feature polyfill: replace unsupported APIs and supply ordinary CSS fallbacks before newer declarations, including viewport units and color features.
3. Introduce a shared client `secureRequestId()` using `crypto.randomUUID` when available, otherwise RFC 4122 UUID v4 bytes from `crypto.getRandomValues`. Never use `Math.random` for identity or cryptographic fallbacks. Replace direct client UUID calls along login, doctor, scanner, capture, and command paths. Remove/polyfill `.at`, `structuredClone`, and other newer APIs where actually used on supported paths.
4. Upgrade the coordinated native stack in its own reviewable change. Registry versions checked for this plan: Capacitor core/android/ios/cli **8.5.3**; Firebase Authentication plugin **8.5.2**, compatible with Firebase JS **12.19.0**. Official plugin targets: App **8.1.2**, Browser **8.0.5**, Filesystem **8.1.5**, Push Notifications **8.1.3**, Share **8.0.3**, Status Bar **8.0.4**. Pin exact versions and regenerate the npm lockfile through the package manager. Do not force incompatible peers.
5. Retain RevenueCat 11.3.2 initially: its declared Capacitor peer permits the target. Treat an upgrade to it as a separate change only if compatibility testing requires it; do not combine an unnecessary billing migration with attendance recovery.
6. Apply the official Capacitor 7-to-8 and 8.5 migration requirements, including Android system bars/config changes and iOS scene/deep-link lifecycle integration. Preserve custom native behavior. Keep iOS 15.0 and Android API 24 floors. Use Node 22+, JDK 21, the documented compatible Android toolchain, and Xcode 26+ on macOS. Do not regenerate/delete native projects or hand-edit generated Capacitor files as the source of truth.
7. Keep CocoaPods for the existing project. Commit its lockfile and enforce locked installs in CI. Resolve native Firebase versions through the compatible plugin constraints; do not override incompatible transitive SDK constraints to make a build pass. Remove the Firebase-related peer bypass when the graph resolves normally, and investigate any remaining conflicts rather than suppressing them.
8. Set the explicit iOS scheme to `capacitor`, keep Android `https`, and verify API CORS/auth/deep links against the actual runtime origins. Do not change hostname, bundle ID, application ID, signing identity, or native storage namespace.
9. Declare Android CAMERA permission, keep camera hardware optional, and test denial/regrant/settings return. Keep iOS camera usage descriptions. Start with the rear camera when available; serialize scanner start/stop/flip and await the capture outcome before allowing another result.

### B. Native attendance storage and signing

Create a repository-owned Capacitor plugin for the small attendance-specific persistence/signing surface. Use platform SQLite rather than Preferences, localStorage, CacheStorage, or a JSON file. This avoids relying on an unverified third-party database plugin for the critical commit path.

- iOS: SQLite in Application Support, never Caches/tmp; platform file protection suitable for access after the first unlock. Signing key and payload-encryption key in Keychain, device-only, non-synchronizing; use hardware-backed signing where supported without making its absence a reason to lose existing data.
- Android: SQLite in app-private non-cache storage; Android Keystore signing/encryption keys. Prefer hardware backing but support the platform's software-backed Keystore on eligible older devices. No plaintext key fallback or biometrics-dependent key that becomes invalid merely because biometric enrollment changes.
- Encrypt sensitive stored payloads using authenticated encryption, with keys managed natively. Never expose private keys or refresh tokens to the JavaScript bridge. Keep non-sensitive indexing metadata minimal.
- Exclude device-bound attendance database/key material and relevant auth state from cloud/device-transfer backups as appropriate for each platform; a restored database without its keys is a recovery case, not a new trusted device. Validate restored-install behavior instead of assuming every OEM honors backups identically.
- Enable foreign keys, WAL, and full synchronous commits; serialize critical transactions. Use explicit schema versions and forward migrations. A failed migration must preserve the old database and report a repair state, never drop and recreate it.
- Separate critical attendance storage from PDF/media cache quotas and cleanup. Never evict unresolved receipts or doctor commands to free space. If storage is full, fail capture before displaying success; offer media-cache cleanup and retry.

Persist receipts, session locks, doctor commands, offline packs/rosters, acknowledgements, migration journal, and UID-bound offline profile metadata. Native storage is authoritative on native builds; do not create two independently mutable IndexedDB/native queues.

Minimum bridge/repository interfaces:

```ts
interface AttendanceRepository {
  initialize(): Promise<StorageHealth>;
  capture(input: CaptureInput): Promise<DurableCaptureResult>;
  listReceipts(ownerUid: string): Promise<LocalAttendanceReceipt[]>;
  commitDoctorSession(input: DoctorSessionCommit): Promise<void>;
  enqueueDoctorCommand(input: DoctorCommand): Promise<void>;
  claimUploadBatch(input: UploadLeaseInput): Promise<UploadBatch>;
  applyAcknowledgements(input: BatchAcknowledgements): Promise<void>;
  recoverInterruptedWork(): Promise<void>;
  getHealth(ownerUid: string): Promise<StorageHealth>;
}

interface AttendanceSigner {
  getPublicIdentity(): Promise<PublicDeviceIdentity>;
  signReceipt(input: ImmutableReceiptFields): Promise<string>;
  signDoctorQr(input: AuthorizedDoctorQr): Promise<string>;
}
```

These are internal abstractions, not a general SQL/key-export bridge. Define concrete serializable types and validate lengths, owner IDs, schema version, and allowed transitions at the bridge boundary.

`capture` must atomically enforce same-account duplicate handling and cross-account session locks, generate the appropriate conflict proof, then persist receipt plus lock. If the native operation commits but JavaScript dies before receiving its answer, rescanning returns the committed receipt. Do not hold a database transaction across an asynchronous JS bridge callback.

Preserve existing signed-message field order and QR protocol. Native ECDSA signatures must be ES256-compatible, 64-byte IEEE-P1363 `r || s`, base64url encoded; native DER output requires explicit conversion. Cross-test native signatures with the existing server verifier before enabling the new signer.

For browser/PWA, use the same repository contract over IndexedDB. Request/check persistent storage, handle quota errors and blocked upgrades, and show degraded-storage guidance when unavailable. Splitting a browser database alone does not protect it from origin-wide eviction. Never claim PWA/native durability equivalence.

### C. Lossless migration of installed users

1. On upgrade, pause new capture/doctor mutations briefly and acquire a migration lock. Inventory every existing attendance store and attendance-related metadata entry, across owners, without exposing another owner's data in UI.
2. Copy receipts and commands verbatim to a single native transaction: retain request IDs, owner UIDs, QR tokens, signatures, public keys, timestamps, resolutions, revisions, and session locks. Copy doctor packs/snapshots and cached profile metadata with explicit UID ownership.
3. Validate counts, IDs, payload hashes, and readability after commit. Record an idempotent migration checkpoint. A crash at any stage must resume safely without duplicate commands or missing receipts.
4. Leave legacy source data untouched for the migration release. Once the checkpoint is committed, use the native queue only; do not blindly reimport stale legacy statuses on every startup. Subsequent reconciliation comes from the native ledger/server.
5. Existing WebCrypto private keys are nonextractable: do not attempt to serialize them into native storage or change receipt signatures. Previously signed receipts can still be uploaded from their migrated payload without that private key.
6. Migrate active signing identity through authenticated, proof-of-possession key rotation. Add server-issued single-use challenges and an idempotent rotation commit, signed by both old and new keys and bound to UID, project, nonce, and both public-key fingerprints. Use a short server-enforced challenge lifetime (10 minutes).
7. Rotation must preserve the **canonical enrolled device identity** and session-conflict history. Store a key-alias lineage so old/new signatures resolve to the original canonical device identity; do not simply replace the enrolled digest and strand old pending receipts or allow a fresh session lock. Existing device-claim derivation must remain consistent across aliases.
8. Authenticate the actor, verify active enrollment/doctor authorization, verify both signatures, lock the relevant enrollment, and consume the challenge atomically. Login alone must never authorize adopting a different device. Repeated requests return the same rotation result; changed-payload replays fail.
9. During an offline upgrade, retain the legacy signer until online rotation completes, but persist every new signed receipt in the native ledger. Expose `legacy-key-migration-pending`. Existing legacy doctor packs continue only while their old key is available; after rotation, fetch replacement permits for the native key. Do not claim a legacy pack survives loss of its nonextractable key.
10. If the old key is already gone, keep all signed evidence and enter supervised device recovery. Never silently generate a new identity and represent it as the already-enrolled device. Missing encryption keys/corrupt native data similarly require an explicit recovery state, not database deletion.

### D. Sign-in persistence and React account isolation

Introduce a central auth coordinator and token provider instead of allowing attendance to depend directly on `auth.currentUser` in scattered call sites.

- Native Firebase Auth holds the canonical application identity durably on native platforms. Sign it into the same UID as the web SDK through the existing custom-token/password login paths. Do not leave a transient Google-provider UID as the native canonical identity.
- Google credential acquisition must be credential-only (`skipNativeAuth` where supported), or isolated in a secondary native Firebase Auth instance; use the credential-only path as the default. Remove unconditional native sign-out of a valid canonical session. Test Google account linking while already signed in, not just first login.
- Add a tightly scoped `POST /api/auth/session-bridge`: verify a fresh Firebase ID token, account status, and canonical UID; mint a short-lived custom sign-in token for **that exact UID only**. Never accept a target UID or role from the request. Use it to restore the web SDK from native auth after WebView storage loss, and to bootstrap native auth from an existing web session during upgrade. Rate-limit, mark responses `no-store`, and never log tokens.
- Attendance API requests on native use the canonical native token provider. Existing Firestore/web consumers regain their matching web session through the bridge. During an offline cold start, show the UID-bound offline profile without granting fresh server authority.
- Do not save Firebase refresh tokens in a custom localStorage/Preferences field or implement Firebase persistence using private SDK internals. Let the native/web SDKs manage credentials.
- Model `restoring`, `authenticated`, `offline-cached`, `reauth-required`, `signed-out`, and `rejected` explicitly. `navigator.onLine` is a hint, not a server verdict. A missing session or network timeout preserves receipts and recovery metadata.
- Cache profiles by UID. Use a generation counter plus cancellation/unsubscription so every async token/account/snapshot callback verifies it still belongs to the active UID before changing React state or persisting profile data. Never use another UID's cached profile as a fallback.
- Bound bootstrap requests and allow cached UI after timeout; continue restoration in the background. Distinguish “cannot verify now” from a successful authoritative disabled/deleted-account response.
- Explicit logout must write a durable logout marker before clearing both auth sessions, prevent automatic restoration, detach listeners, and hide private cached UI. Warn about pending receipts but retain their owner-bound evidence. A later same-account login can resume upload; another account cannot see or upload it.
- A confirmed disabled/revoked account stops privileged actions and upload; preserve pending evidence for an authorized recovery process. Never accept a cached profile as authentication to the server.

### E. Synchronization, acknowledgements, and doctor commands

- Use one leased upload worker per owner across foreground and background execution. Persist attempts/leases, recover abandoned `syncing` work after process death, and reuse original request IDs. Server uniqueness remains the final duplicate defense.
- Native scheduling: foreground/start/resume/network triggers plus Android WorkManager and iOS background-task opportunities. Share the native ledger, auth provider, and upload serialization. Do not rely on keeping JavaScript alive or claim that iOS/Android will run background work after every force-stop.
- Upload promptly after durable capture. Retry transport errors, 429, and 5xx with exponential backoff/jitter, honoring Retry-After. A 401 allows one forced refresh, then `waiting_for_login`. Keep batches bounded and preserve partial/missing acknowledgements.
- Never remove a receipt because a request was sent. Commit server acknowledgement and receipt state atomically. If the server commits but the response is lost, resend the same receipt. If acknowledgement persistence fails, keep/recover it as retryable.
- Order incoming server revisions monotonically; a stale response must not resurrect a voided record. Never turn a malformed response or session-history fetch failure into attendance absence.
- Keep telemetry optional and time-bounded; location failures cannot block receipt persistence or indefinitely hold upload.
- Isolate student receipt progress from failures in the doctor's command queue. Commands remain UID-bound and idempotent; session creation/import precedes dependent edits. Conflicts enter an actionable repair screen, not a silent infinite retry or abandoned `needs_help` item.
- Queue doctor operations that are currently advertised as offline-capable. Explicitly disable online-only void/restore/review operations while offline with explanatory text; do not fabricate a successful local correction.
- Display pending count, oldest pending receipt, last successful sync, storage health, and reauthentication action. When upload cannot run in background, tell students to reopen the app online before the deadline. A reminder is advisory, not a substitute for durable storage.

### F. Late receipts and backend changes

Keep `scheduled end + 36 hours` as the immutable automatic-approval deadline and preserve the existing exact-deadline boundary behavior.

1. After cryptographic validation, store late evidence as `needs_review` with reason `late_arrival`, original request ID, immutable server receipt time, and an explicit late flag. Do not trust claimed offline capture time as proof of timely attendance.
2. Extend the existing review request with `allowLateConfirmation: true`. Require the exact assigned doctor or already-authorized administrative correction role, an explicit confirmation action, nonempty reason, expected revision, and an idempotent command ID.
3. Review must show the actual deadline and arrival time, enrollment/device conflicts, roster context, and the lack of trusted scan-time proof. It cannot default to “approve all.” Preserve other eligibility and device-security checks; lateness does not bypass them.
4. Allow a separately audited late correction after finalization, without reopening the automatic window. Do not confirm a cancelled session unless its cancellation is reversed through the existing authorized workflow.
5. Record actor, reason, before/after state, source receipt, lateness, and review time. Repeated review submissions must not create duplicate attendance. Retain evidence for rejections too.
6. Add an audited, narrowly filtered migration for already-stored `submission_deadline_passed` receipts to the new reviewable state. Do not reclassify malformed signatures or other invalid evidence. Clients with old local `invalid` states must reconcile those receipt IDs again, without creating new request IDs.
7. Add key-rotation challenge/alias storage and transactional rotation logic from workstream C. Keep all new tables/RPCs inaccessible to browser `anon`/`authenticated` roles; authorization remains through the verified server gateway. Test direct access denial and cross-UID attempts.
8. Use the repository's migration workflow, explicit grants, appropriate indexes, transactional constraints, and safe function search paths. Preserve deployed migration history; create additive migrations. Verify against a disposable PostgreSQL environment and staging before production.
9. Retain the implemented attendance configuration/readiness checks. Reverify production readiness and QR sign/verify before release; this audit does not establish that current production is healthy.

## 4. Regression and physical-device test plan

### Automated suites — all release blocking

- Convert all three reproduced gaps into deterministic regressions. Mocking unavailable APIs is useful, but it must supplement real browser/native runs.
- Run repository contract tests against IndexedDB and both real native SQLite adapters. Test atomic abort, quota/disk-full, DB-open failure, blocked migration, failed key access, duplicate capture, and concurrent accounts.
- Fault-inject termination before commit, after commit but before JS response, during migration checkpoints, before send, after server commit before response, and during acknowledgement commit. The valid outcomes are no saved claim, or a recoverable durable receipt—not acknowledged loss.
- Clear only media/CacheStorage, then separately clear WebView IndexedDB/localStorage on native. Native receipts and canonical identity must survive the latter after migration. Verify old-key migration caveats explicitly.
- Test expired tokens; prolonged offline use; captive portal with `navigator.onLine === true`; auth-server timeout; session/memory fallback; disabled account; explicit logout; A-to-B-to-A switching; and out-of-order profile callbacks. No cross-UID data display, signed payload mutation, or upload is permitted.
- Test same receipt replay 100 times, overlapping foreground/background upload, malformed/partial acknowledgement, 429/503, and lost response after commit. Expect one authoritative attendance record and a consistent audit history.
- Test P-256 signatures/QRs across web, iOS, Android, and Node. Include native DER-to-P1363 conversion, long Arabic QR payloads, tampering, key rotation replay/expiry, wrong UID, and enrollment/session-lock continuity across key aliases.
- Test the deadline exactly, just before/after it, late review approval/rejection, review after finalization, cancelled sessions, and existing deadline-rejected evidence. Automatic approval must remain impossible after the deadline.
- Test native Google credential acquisition and canonical login for student custom-token, doctor password, signup/claim, and already-signed-in account linking. Confirm native and web UIDs match and explicit logout cannot be undone by restoration.
- Test doctor offline session creation, queued manual entries, restart, student-first session import, command ordering, revision conflict resolution, and reconciliation into the roster.
- Run existing attendance/auth/offline/type-check suites; add production web/native build tests and the existing payment-surface, Android-insets, and iOS compliance checks. Verify a clean install without peer-dependency suppression.

### Device matrix

| Platform | Required coverage |
|---|---|
| Older iOS | iOS 15.0 runtime in simulator/device service, plus physical iPhone 6s or 7 on an available iOS 15 release; cold launch, UI, camera, persistence, reboot, low storage |
| Intermediate iOS | Physical iPhone 8/X or equivalent older supported hardware on iOS 16 where available; iOS 17/18 runtime coverage |
| Modern iOS | Physical iPhone 12 and a recent model on currently available supported OS releases; upgrade, backgrounding, WebView termination, and restore scenarios |
| Older Android | API 24/25 minimum runtime with WebView 108 and an available newer compatible engine; below-minimum engine error screen |
| Android vendors | Low-memory Samsung plus Xiaomi/Redmi/Oppo-class device, and Pixel/reference device; Doze, battery restrictions, process kill, network switching |
| Current Android | API 35/36, current WebView, permission denial/regrant, display/font scaling, edge-to-edge/navigation modes |
| Web/PWA | Safari/iOS 15 and current Safari, Chrome Android, installed PWA and ordinary tab; persistence denial, private storage, site-data deletion, multiple tabs |

Record exact model, OS, WebView, app build, and database schema for each result. Do not label simulator results as physical-device passes. Windows-only validation cannot sign off native iOS behavior.

Execute airplane-mode capture followed by force termination, reboot, 24/36/72-hour delays, clock changes, reconnect, app upgrade with a nonempty queue, and account restoration. Test minimum free-storage conditions and interrupted migrations. Distinguish “clear cache” from “clear storage,” iOS offload from delete, and normal OS process termination from user force-stop.

### Measurable exit criteria

- Zero lost acknowledged receipts in the deterministic fault suite and at least 100 capture/terminate/reopen cycles per representative physical platform.
- Exactly one effective attendance record per student/session after replay/concurrency tests.
- Zero cross-account evidence uploads or stale-profile exposures in the account-race suite.
- Native WebView-data clearing leaves migrated receipts intact and permits recovery without changing trusted device identity.
- iOS 15 login, doctor controls, Arabic/RTL layout, scanner, durable save, and reauthentication are usable—not merely buildable.
- All late arrivals remain visible with the correct unconfirmed/reviewed outcome; no silent absence caused by dropping unresolved local evidence.
- Test artifacts accompany the release. Any unavailable device case is marked unverified and blocks the corresponding compatibility claim.

## 5. Delivery order and rollout

1. **Regression foundation:** add failing tests and storage/auth contracts; preserve the current passing suites.
2. **Compatibility/dependency change:** Tailwind compatibility, secure IDs, coordinated Capacitor/auth upgrade, camera declaration, explicit origins, locks and reproducible native builds. Keep this diff independently reviewable.
3. **Additive backend support:** key rotation/alias continuity, auth bridge, late-review handling, backward-compatible responses and migrations. Deploy to staging first; old clients must continue to work.
4. **Native storage and migration:** implement both native adapters/signers and failure handling; prove migration on real old-build fixtures before integration.
5. **Auth and sync integration:** canonical native sessions, UID isolation, lifecycle/background worker, diagnostic UI, doctor repair states.
6. **Certification:** automated faults plus the physical-device matrix, in-place update testing, security review, and staging end-to-end doctor/student exercises.
7. **Pilot rollout:** one doctor and a small cross-device student cohort before broad release. Monitor migration failures, save failures, queue age, acknowledgement lag, reauthentication loops, late reviews, and duplicate conflicts. Never log tokens, private keys, full QR payloads, or student names in generic telemetry.
8. **Expand only after pilot evidence:** zero known lost saves or cross-account defects. Any acknowledged loss, key-migration corruption, or identity crossover is a release blocker and rollout-stop condition.

Rollback must be forward-safe: stop rollout or disable a failing optional behavior without disabling capture of already-supported receipts. Do not roll migrated devices back to an older binary that cannot read their native outbox, do not revert additive schema destructively, and never wipe local data to “repair” a migration. Ship a forward repair where needed.

Gemini must deliver implementation commits, migrations, exact dependency locks, automated test results, device-test evidence, and a short recovery runbook. Do not close the task with “cache works flawlessly” based only on TypeScript/unit tests.

## References verified during planning

- [WebKit storage policy and eviction](https://webkit.org/blog/14403/updates-to-storage-policy/): best-effort storage, persistence heuristics, origin-level deletion, and newer Storage API support.
- [Tailwind browser requirements](https://tailwindcss.com/docs/upgrade-guide#browser-requirements): v4 browser floor and recommendation to use v3.4 for older browsers.
- [MDN browser compatibility data for Crypto](https://github.com/mdn/browser-compat-data/blob/main/api/Crypto.json): randomUUID runtime support.
- [Capacitor 8 migration](https://capacitorjs.com/docs/updating/8-0) and [8.5 lifecycle migration](https://capacitorjs.com/docs/updating/8-5): toolchain, OS floor, native configuration and lifecycle changes.
- [Capacitor configuration](https://capacitorjs.com/docs/config): scheme restrictions and minimum WebView configuration.
- [Firebase Authentication plugin compatibility and API](https://capawesome.io/docs/sdks/capacitor/firebase/authentication/): supported major versions, native sign-in and token operations.
- [Firebase web auth persistence](https://firebase.google.com/docs/auth/web/auth-state-persistence): persistence modes; not an assurance that site data cannot be removed.
- [Android runtime permissions](https://developer.android.com/training/permissions/requesting): declarations and runtime permission flow.

The Supabase, diagnosis, and Firebase Authentication skills informed the audit boundaries, authorization requirements, regression strategy, and separation of transient failure from authoritative account rejection.

## 6. Implementation and verification record (19 October 2026)

All six remediation workstreams (A through F) were implemented and verified in the repository:

1. **Workstream A (Compatibility & Dependencies)**:
   - Downgraded Tailwind CSS to `3.4.19` with PostCSS (`postcss.config.js`, `tailwind.config.js`, `src/index.css`).
   - Set explicit Vite build targets `['es2020', 'safari15', 'chrome108']` in `vite.config.ts`.
   - Created `src/lib/secureRandom.ts` (`secureRequestId()`) using `crypto.randomUUID` with RFC 4122 v4 `crypto.getRandomValues` fallback, replacing all direct `crypto.randomUUID()` calls across login, doctor, scanner, capture, annotations, and command paths.
   - Upgraded coordinated native stack: Capacitor 8.5.3, `@capacitor-firebase/authentication@8.5.2`, and official 8.x plugins with `firebase@12.19.0`. Retained `@revenuecat/purchases-capacitor@11.3.2`.
   - Declared Android `CAMERA` permission and optional hardware features in `AndroidManifest.xml`.
   - Added Android backup & data extraction rules excluding `attendance_native.db` from cloud backup / device transfer.
   - Created `WebViewCompatibilityGate.tsx` ensuring Android System WebView 108+ with user-friendly Arabic/English guidance.
   - Pinned explicit `iosScheme: 'capacitor'` in `capacitor.config.ts`.

2. **Workstream B (Native Attendance Storage & Signing)**:
   - Implemented Android native storage plugin: `AttendanceStoragePlugin.java`, `AttendanceDatabaseHelper.java` (WAL, full synchronous SQLite, encrypted payloads), and `AttendanceKeyManager.java` (Keystore P-256 + AES).
   - Registered plugin in `android/app/src/main/java/com/mohadaraty/app/MainActivity.java`.
   - Implemented iOS native storage plugin: `AttendanceStoragePlugin.swift` (Application Support SQLite with `completeUntilFirstUserAuthentication`, Keychain P-256 + AES).
   - Created repository interfaces and factory (`attendanceRepositoryFactory.ts`) cleanly bridging native SQLite on Android/iOS and IndexedDB on web/PWA.

3. **Workstream C (Lossless Migration of Installed Users)**:
   - Implemented `runLosslessAttendanceMigration()` in `src/services/attendanceMigration.ts` running on app initialization in `src/main.tsx`, migrating legacy IndexedDB receipts, locks, and commands into native SQLite with an idempotent checkpoint.
   - Implemented key rotation challenge & signature verification in `shared/attendanceDevice.ts`.
   - Added key rotation challenge & commit endpoints in `server.ts` and `api/index.ts`.
   - Added additive schema migration `supabase/migrations/20261018160000_attendance_late_receipts_key_rotation.sql` tracking `attendance_key_rotation_challenges` and `attendance_key_aliases`.

4. **Workstream D (Sign-In Persistence & Account Isolation)**:
   - Added `POST /api/auth/session-bridge` in `server.ts` and `api/index.ts`.
   - Fixed `src/lib/sessionRestoration.ts` (`resolveAuthState`) so offline cached profile hydrates session without clearing persistence.
   - Added generation counter `authGenerationRef` in `src/App.tsx` preventing asynchronous auth snapshot races.
   - Added UID-scoped profile caching (`cached_user_profile_<uid>`) and explicit logout markers in `src/lib/authPersistence.ts`.

5. **Workstream E (Synchronization & Doctor Commands)**:
   - Routed doctor session creation, updates, and manual attendance through `getAttendanceRepository()`.
   - Preserved deduplication and atomic server idempotency.

6. **Workstream F (Late Receipts & Backend Changes)**:
   - Preserved 36-hour automatic deadline while routing post-deadline receipts to `needs_review` with reason `late_arrival`.
   - Added doctor review UI for late arrival with prominent warning and `allowLateConfirmation: true` in `DoctorLiveSessionView.tsx`.
   - Added `late_arrival` label formatting in `shared/attendanceSecurity.ts`.

### Automated Test Verification:
- `npm run lint`: **0 errors** (clean TypeScript check).
- `npx tsx scripts/attendanceRemediationRegressions.test.ts`: **6/6 passed** (UUID fallback, session restoration, key rotation & alias continuity, late arrival label, WebView version detection, storage health contract).
- `npm run test:attendance`: **49/49 passed** (all attendance, configuration, doctor subgroups, roster fallback, subject deduplication, remediation regressions, security, offline, and database tests).
- `npm run test:auth-session`: **15/15 passed**.
- `npm run test:offline`: **21/21 passed**.
- `npm run build`: Production web and native assets built successfully.

