# Simosan attendance: authoritative architecture, reliability contract, and recovery runbook

**Updated October 2026, Asia/Baghdad.**
This document supersedes all previous attendance documentation and premature completion claims. It serves as the single source of truth for the Capacitor-based native attendance system across Android, iOS, and Web/PWA platforms.

---

## 1. Product decisions and acceptance contract

- **Firebase Authentication** identifies callers and holds canonical student and lecturer profiles. Verified stage rosters and timetable data live in Firebase.
- **Supabase PostgreSQL** owns the authoritative attendance ledger and device enrollment records. Its service-role key is strictly server-only and must never enter a client bundle or mobile application.
- **Strict 36-hour submission window:** Student uploads must reach the database no later than **36 hours after the scheduled lecture end**, measured strictly by the server. Neither client wall clocks, closure events, nor late lecturer synchronization can extend this deadline.
- **Late receipts:** Preserved with receipt reason `late_arrival` and resolution `needs_review`. Confirmation requires an explicit doctor action (`allowLateConfirmation = true`), a documented reason, and an audit event.
- **Device enrollment & single-student lock:**
  - One physical installation cannot record attendance for two students in the same lecture session.
  - One student may attend any number of lectures on their approved device.
  - New devices require supervised enrollment by the lecturer (checking university ID).
  - Attempting to record a second student on the same installation produces a `device_session_conflict` and requires manual attendance; doctor QR review cannot bypass device conflicts.
- **Location policy & native indoor timeout:**
  - Location permission denial or disabled location services blocks scanning.
  - Android API 24+ and iOS 15.0+ may proceed after a 4.5-second indoor timeout only if permission and location services are verified enabled.
  - Native badge label: **“Location unavailable — permission and location services enabled”** (Arabic: `📍 الموقع غير متاح — الإذن وخدمات الموقع مفعلة`).
  - Web/PWA timeouts remain strictly blocked. Campus geometry uses the fixed Al-Safwa coordinates (`32.623889, 44.006667`).
- **UI State Contract:**
  - **Saved on this device (`pending`):** Receipt and session lock committed locally in authoritative storage.
  - **Waiting for sign-in/upload (`waiting_for_login` / `pending`):** Evidence durable under its original account UID.
  - **Needs doctor review (`needs_review`):** Server retained evidence; attendance pending lecturer identity review.
  - **Confirmed (`confirmed`):** Server committed attendance and the local acknowledgement was persisted.
  - **Not saved (`failed`):** Persistence failed; retry or manual attendance is required.

---

## 2. Authoritative architecture

### A. Native plugin integration and signing
- **iOS (`AttendanceStoragePlugin.swift`):**
  - Integrated into `ios/App/App.xcodeproj/project.pbxproj` under the `App` source target.
  - Registered explicitly in `MyLectureBridgeViewController` (`AppDelegate.swift`) alongside `SettingsLauncher`.
  - P-256 public key export validates the uncompressed 65-byte X9.63 representation (`0x04` prefix check, 32 bytes x, 32 bytes y).
  - Uses `attendanceDeviceMessage(receipt)` as the exact byte serialization authority for native signing (IEEE-P1363 64-byte signature encoded in base64url).
  - Enforces the 2,330-byte limit on Doctor QR tokens with permit in the JWT header (`pmt`) without duplicating it in payload claims.
- **Android (`AttendanceStoragePlugin.java` & `AttendanceDatabaseHelper.java`):**
  - Upgraded SQLite database to Version 2 with columns `lease_id`, `lease_expires_at`, `owner_uid`, `encrypted_value`.
  - Replaced legacy newline serialization with shared `attendanceDeviceMessage(receipt)` producing IEEE-P1363 (64 bytes) signatures.
  - Excluded `attendance_device_meta.xml` and SQLite databases from backup rules (`backup_rules.xml` and `data_extraction_rules.xml`).
- **Shared serialization authority (`shared/attendanceSecurity.ts`):**
  - `attendanceDeviceMessage(receipt)` formats:
    `[requestId, ownerUid, sessionId, occurrenceId, qrToken, installationId, localDeviceConflict === true]`
    as a UTF-8 JSON array. Request ID tampering, conflict flag flipping, or coordinate tampering immediately fails server verification (`invalid_device_proof`).

### B. Authoritative transactional native storage
- **Transactional transitions:** Database writes serialize through WAL mode with verified synchronous commits.
- **Upload leases:** Foreground and background uploaders acquire a durable upload lease (`acquireUploadLease`) with lease ID, expiration, and batch limit (25 items). Active leases prevent duplicate concurrent uploads.
- **Monotonic revisions:** Acknowledging batches checks monotonic record revisions; regressions are rejected.
- **UID-scoped metadata:** Offline packs, rosters, session snapshots, and cached user profiles are stored with `owner_uid` and encrypted using AES/GCM.
- **Structured storage health states:**
  - `ready`: Durable database healthy, queue counts accurate.
  - `migration_required`: Unmigrated legacy records detected.
  - `key_unavailable`: Android Keystore or iOS Keychain temporarily locked.
  - `corrupt`: Database or records unreadable.
  - `unavailable`: Hardware storage failure.

### C. Migration barrier and device identity
- **Single initialization barrier (`ensureAttendanceInitialized()`):** All attendance reads, captures, doctor mutations, and sync operations await migration initialization.
- **Authoritative native journal (`attendance_migration_journal`):**
  - Web localStorage checkpoints are non-authoritative; the native SQLite journal determines migration status.
  - Installations containing only offline packs or rosters are fully inventoried and migrated.
- **Proof-of-possession key rotation:**
  - Server generates a single-use nonce bound to `actorUid`, `challengeId`, and a 10-minute expiry.
  - Both old and new private keys sign the rotation message.
  - Supabase RPC `attendance_commit_key_rotation` validates ownership, locks enrollment, registers the alias in `attendance_key_aliases`, and consumes the challenge.
  - Identical retries return the recorded result (`rotated: true`, `existing: true`); changed payloads fail with `challenge_already_consumed`.

### D. Authentication and synchronization
- **Auth coordinator:** Native Firebase retains the canonical UID; web Firebase is synchronized to that UID.
- **Google Sign-In:** Uses `skipNativeAuth: true` on credential acquisition to prevent premature native logout.
- **Session Bridge (`/api/auth/session-bridge`):** Verifies token revocation (`checkRevoked: true`), active user whitelist status, and mints custom tokens strictly for the caller's verified UID.
- **Account Generation Guard:** Asynchronous storage and upload callbacks compare their operation generation against the active generation, preventing cross-account state pollution.
- **Explicit logout persistence:** `attendance_explicit_logout` is persisted natively and only cleared by an intentional, successful sign-in.

### E. Backend review revisions and security
- **Additive Migration (`20261021000000_attendance_review_revisions_key_rotation.sql`):**
  - `review_revision` on `attendance_receipts` enforces optimistic concurrency for doctor reviews.
  - Concurrency conflicts throw `concurrency_conflict` (HTTP 409).
  - Key rotation challenges (`attendance_key_rotation_challenges`) and aliases (`attendance_key_aliases`).
- **Gateway-only Supabase RLS:** All direct browser-role table access and RPC execution are revoked; only the server service-role gateway accesses the database.

---

## 3. Operational recovery runbook

### Scenario 1: Pending receipts stuck on device
- **Symptoms:** Student schedule displays "Saved on this device — waiting for sync" for an extended period.
- **Root causes:** Network outage, expired Firebase token, or active upload lease after abnormal app termination.
- **Recovery steps:**
  1. Verify student is signed into the exact same university account that captured the lecture.
  2. Pull down to refresh or tap "Sync Now" in Attendance Settings.
  3. The repository will automatically release any expired leases (> 60s old) and retry upload in batches of 25 with exponential backoff.
  4. If upload still fails after 36 hours, the receipt will be saved on server as `needs_review` (`late_arrival`). Inform the doctor to confirm the receipt via the review portal.

### Scenario 2: Lost device keys or Keychain/Keystore corruption
- **Symptoms:** App health reports `key_unavailable` or `corrupt`. Scanning fails to sign receipts.
- **Root causes:** Hardware keystore invalidation, OS security reset, or biometric credential purge.
- **Recovery steps:**
  1. Do NOT uninstall the app (uninstall clears pending unuploaded receipts).
  2. If online, initiate supervised key rotation:
     - Request a rotation challenge via `/api/attendance/rotate-key/challenge`.
     - Generate a new P-256 keypair in the secure hardware.
     - Have the doctor verify student college ID and approve the device change in the lecturer portal.
  3. If unrecoverable, the student can use manual attendance by the lecturer until the key is re-enrolled.

### Scenario 3: Device replacement or phone transfer
- **Symptoms:** Student scans attendance on a new phone; receipt is held as `needs_review` (`device_change_required` or `device_enrollment_required`).
- **Root causes:** New hardware fingerprint does not match the enrolled device digest in `attendance_enrolled_devices`.
- **Recovery steps:**
  1. The receipt is safely stored on the server with `resolution = 'needs_review'`.
  2. The student visits the lecturer during or immediately after the lecture.
  3. The lecturer opens the session review tab, verifies the student's physical college ID card, and clicks "Confirm & Enroll Device".
  4. The server links the new device fingerprint to the student's roster ID. Subsequent lectures will confirm automatically.

### Scenario 4: Migration failure or interrupted native upgrade
- **Symptoms:** App displays `migration_required` or storage health error on startup.
- **Root causes:** App killed during legacy IndexedDB to native SQLite migration.
- **Recovery steps:**
  1. The single initialization barrier (`ensureAttendanceInitialized`) automatically resumes the migration journal.
  2. The native journal verifies payload hashes and counts before marking completion.
  3. Legacy source data in IndexedDB is never deleted during migration; it remains intact as a fallback.
  4. Reopening the app triggers a safe resumption of the migration journal without data loss.

---

## 4. Verification and release gates

| Release Gate | Verification Method | Status |
|---|---|---|
| **Protocol & Signing** | IEEE-P1363 (64 bytes) base64url signatures verified against server P-256 verifier with request ID & conflict tamper tests | **VERIFIED** (`scripts/attendanceIntegrationContract.test.ts`) |
| **X9.63 Coordinates** | 65-byte uncompressed EC key validation with prefix `0x04` and length checks | **VERIFIED** (`scripts/attendanceIntegrationContract.test.ts`) |
| **Authoritative Storage** | Native SQLite v2 with upload leases, monotonic revisions, and encrypted UID metadata | **VERIFIED** (`src/services/nativeAttendanceRepository.ts`) |
| **Database Migrations** | Additive migration for review revisions, key rotation nonces, and alias lineage | **VERIFIED** (`supabase/migrations/20261021000000_...sql`) |
| **Review Concurrency** | `expectedRevision` optimistic locking with rejection of stale revisions and -999 | **VERIFIED** (`scripts/attendanceDatabase.test.ts`) |
| **Location Badge** | "Location unavailable — permission and location services enabled" | **VERIFIED** (`shared/attendanceSecurity.ts`) |
| **Google Sign-In** | `skipNativeAuth: true` preserving native Firebase session | **VERIFIED** (`src/lib/googleSignIn.ts`) |
| **Session Bridge** | Revocation check, active user status, target UID rejection | **VERIFIED** (`server.ts`, `api/index.ts`) |
| **Capacity & Multi-Connection** | 100 parallel submissions in PGlite with zero duplicate records | **VERIFIED** (`scripts/attendanceIntegrationContract.test.ts`) |
| **Physical Device Verification** | Android API 24+ and iOS 15.0+ builds | **PENDING PHYSICAL DEVICE PROVISIONING** |
