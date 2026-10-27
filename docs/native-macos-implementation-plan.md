# Native macOS implementation plan

Prepared 25 October 2026. This plan is for a **separate macOS app binary and
App Store Connect macOS version**, with offline lecturer attendance. It is not
the existing "Designed for iPad" Mac compatibility route described in
`macos-launch-readiness-guide.md`.

## Decision and scope

Build a native SwiftUI/AppKit macOS target that packages the current React app
in WKWebView and supplies macOS implementations for every required native
service. This produces a real Mac application with native storage, signing,
file, window, and StoreKit behavior while reusing the established interface and
server contracts. It is **not** a full SwiftUI rewrite of every screen. A full
SwiftUI interface can follow later without changing the attendance protocol.

Keep the iOS target and its shipping workflow independent. Use the existing
`com.mohadaraty.app` bundle ID only if the macOS version is added under the
same App Store Connect app record and Apple accepts that record's platform
configuration. The existing macOS 1.0 draft must be inspected before choosing
the first Mac version/build number. Do not infer its state from the failed iOS
1.0 upload log.

### Scope of the first release

1. Lecturer login, assigned subjects/timetable, workspace, live QR sessions,
   manual attendance, emergency drafts, review, analytics, and export.
2. Prepared offline lecturer workflow with durable local commands and safe
   reconciliation after connectivity returns.
3. The student and general app features reachable in the Mac build, including
   subscriptions, must either work and be tested or be explicitly designed out
   of the Mac product before release. Do not ship visible but broken controls.
4. Arabic/RTL and English, mouse/trackpad, keyboard, resizable windows,
   projector/external display, accessibility, and printing/export.

## Verified repository baseline

| Area | Evidence | Gap for native Mac |
| --- | --- | --- |
| Build | `ios/App/App.xcodeproj/project.pbxproj` has one `App` target with `SDKROOT = iphoneos`; `codemagic.yaml` has `ios-release` and `ios-mac-qa` | No macOS target, scheme, `.app`/`.pkg` workflow, Mac signing, or sandbox entitlements |
| Runtime | `capacitor.config.ts`, `ios/App/Podfile`, and installed Capacitor/plugin podspecs are iOS focused | Capacitor 8 does not supply a supported macOS host; the iOS Podfile and plugins cannot be assumed to compile on Mac |
| Web build | `vite.config.ts` has web, Android `native`, and `ios` modes; `src/lib/platform.ts` has iOS purchase flag | Add an explicit Mac App Store build mode and platform service adapters; preserve the Apple billing rule |
| Attendance UI | `src/App.tsx` routes doctors to `DoctorPortal`; `src/components/doctor/*` includes live QR, timetable, analytics, and emergency drafts | Adapt desktop interaction, window/projector behavior, alerts, printing, and accessibility |
| Attendance logic | `src/services/attendanceService.ts` handles offline preparation, QR, command ordering, sync, and review | Make storage/signing available on Mac and verify lifecycle behavior |
| Attendance storage | `src/services/attendanceRepositoryFactory.ts` selects a Capacitor plugin or IndexedDB; `ios/App/App/attendance/AttendanceStoragePlugin.swift` uses SQLite, AES-GCM, and Keychain | Add a first-class Mac repository/signer; never silently fall back to IndexedDB for a native Mac release |
| Backend | `shared/attendanceApi.ts`, `shared/attendanceOffline.ts`, and Supabase migrations enforce permit and session contracts | Run Mac signing keys and requests against existing server verifier; change backend only if a demonstrated incompatibility exists |
| Purchase/auth/files | `src/lib/iap.ts`, `src/lib/googleSignIn.ts`, PDF and filesystem helpers use iOS/Capacitor paths | Supply Mac StoreKit/RevenueCat, auth, PDF, files, sharing, and permission paths |

The iOS publishing audit currently passes 14/14 checks, but it tests iOS
contracts only. There is no Mac compile or runtime evidence.

## Phase 0 — freeze contracts and define acceptance fixtures

- Record a commit/build baseline, current App Store Connect Mac draft state,
  assigned Apple team, bundle ID, RevenueCat project, and Codemagic integration.
- Freeze the existing attendance QR, permit, signature, receipt, command, and
  acknowledgement schemas. Create fixture vectors in `shared/` that both the
  existing server verifier and Mac implementation consume.
- Capture the exact expected behavior for an offline lecturer: a server-issued
  seven-day permit and schedule/roster have been prepared while online; a
  lecturer can create a QR session, change headcount/notes, close it, and queue
  manual marks without a network. Without a valid prepared pack, offer only
  emergency drafts for later matching. An offline action is never displayed
  as server-confirmed attendance.
- Define the Mac feature matrix for every route and control. Mark each as Mac
  implementation, safe web behavior, intentional Mac-specific behavior, or
  removed with appropriate product copy. Include account management, student
  reader, purchases/restore, PDF annotation, attendance, push, location, and
  export. This prevents a successful shell build from masquerading as parity.

**Gate:** fixture vectors and route matrix are reviewed before Mac bridge work.

## Phase 1 — macOS target and packaged web shell

1. Add a separate macOS target, scheme, icon set, `Info.plist`, privacy manifest
   as required, deployment target, and test target. Use a real Mac application
   lifecycle, one primary window, and a dedicated QR presentation window for an
   external display. Keep the iOS Xcode project/build unaffected.
2. Add `build:macos` and an explicit Vite Mac mode. Compile an absolute API
   base, Apple Store purchase UI, and Mac capability flags. Keep the web bundle
   embedded. Do not point the WKWebView at the live website. Ensure bundled
   PDF.js assets, fonts, workers, and service-worker behavior are correct.
3. Load local assets through a stable, secure WebKit origin. Verify WebCrypto,
   Firebase Auth persistence, cookies, `fetch`, navigation, CSP, deep links,
   and backend CORS for the **observed** origin. Update `server.ts` CORS only
   after the Mac origin is known and tested.
4. Define one typed JavaScript-to-Swift bridge with explicit capability errors
   and versioning. Keep the existing attendance service/repository TypeScript
   contracts. Make `attendanceRepositoryFactory.ts` select the Mac adapter;
   native Mac builds must fail visibly if it is unavailable.
5. Implement desktop window, keyboard, RTL, focus, screen-reader, large-text,
   print, share, and export behavior. Test minimum window size and projector
   layout before polishing screenshots.

**Gate:** unsigned `xcodebuild` on Codemagic creates a launchable `.app`; login
screen and bundled assets work from the app with the network both on and off.

## Phase 2 — Mac attendance storage, identity, and offline authority

Create `MacAttendanceRepository` and `MacAttendanceSigner` implementing
`src/services/attendanceRepository.ts`. Port the *behavior* of the iOS plugin,
not the `CAPPlugin` wrapper or iOS Keychain assumptions.

- Store an encrypted SQLite database in the app's Application Support
  container, separate from the WebView cache and PDF cache. Use WAL, foreign
  keys, full commits, schema versions, forward-only migrations, and health
  reporting. Keep unresolved receipts and doctor commands out of cache cleanup.
- Generate a Mac installation identity and P-256 signing key in Keychain; keep
  private key material out of JavaScript. Choose the Mac Keychain access policy
  deliberately and test lock/unlock, reboot, migration, reinstall, and missing
  key behavior. Never create a replacement key while unreadable records exist
  and pretend those records are usable.
- Keep the existing owner UID and stage boundaries. A lecturer switch or
  logout must not expose another lecturer's roster, QR, drafts, or commands.
  Retain pending work under its original owner until authorized sync/recovery.
- Implement atomic `commitDoctorSession`: cached session snapshot and import
  command land together. Repeated calls with the same request ID return the
  committed result. Implement ordered command enqueue, update, lease/recovery,
  and explicit `needs_help` state without deleting evidence.
- Match existing ES256/JWK/P1363 signature encoding and field order. Verify Mac
  signatures with `shared/attendanceOffline.ts` and the server verifier. The
  Mac has its own device identity; never copy an iPad installation key.
- Prepare offline authority through the existing
  `/api/attendance/offline/prepare` endpoint. Store the signed permit,
  schedule, roster, server timestamp, and expiry with the owner UID and stage.
  Refresh online before expiry; preserve a still-valid pack when refresh fails.
  The Mac clock may guide UI but cannot become server authority. Recheck
  permission and revocation during server import.
- Clarify storage health in the UI: **saved locally**, **waiting for login**,
  **uploading**, **needs review/help**, **confirmed**, or **not saved**. Do not
  show success when the native commit fails, disk is full, or the key is
  inaccessible.

**Gate:** Mac unit tests cover database migration, atomicity, encryption,
Keychain failures, owner isolation, signature vectors, duplicate requests,
and recovery after process termination.

## Phase 3 — lecturer flows and reconciliation

- Reuse `useDoctorAttendance.ts` and `attendanceService.ts` after the Mac
  adapter works. Test prepared online/offline workspace and permit renewal.
- Show the static signed QR in a high-contrast, full-screen projector window;
  keep lecturer controls and pending statuses in the main window. Screen
  sharing or screenshots of a static QR are possible; preserve the existing
  server/device/location/review defenses rather than claiming the QR proves
  scan time.
- Support multiple lecture sessions and queued updates. Import an offline
  session before dependent headcount, close, or manual commands. Preserve
  `localOrder` and stable request IDs; idempotent retry must not create a
  duplicate session or record.
- Keep emergency drafts available when no valid permit/schedule exists. Require
  lecture/student matching after reconnect; ambiguous matches remain
  `needs_help` for lecturer correction, never auto-assigned.
- Keep offline manual marks visibly pending. Display confirmed counts from the
  server separately from local pending marks. Closing the projector window
  must not silently finalize a session. Preserve the existing 36-hour student
  receipt reconciliation and explicit, reasoned review for late evidence.
- On launch, unlock, wake, network return, and auth restoration, attempt sync
  for the signed-in owner. Use bounded retries with backoff; retain queued
  commands when offline or unauthorized. Native scheduling may improve
  delivery while the app runs, but do not promise sync after the Mac sleeps or
  the app is quit. The queue must survive until the next launch.
- Audit review, void/restore, finalization, spreadsheet export, and analytics
  against both online and cached states. Keep role/stage/subject enforcement on
  the server. Test desktop keyboard navigation and Arabic RTL grids.

**Gate:** a lecturer can prepare online, disconnect, create two sessions,
project QR, queue headcount/close/manual commands and an emergency draft,
force-quit/relaunch, reconnect, and see one correctly ordered server result
per request with clear pending/review/confirmed states.

## Phase 4 — remaining Mac platform services

- **Authentication:** verify email/password, token refresh, cached offline
  lecturer entry, explicit logout, account switching, and app relaunch. Decide
  whether Google sign-in is offered on Mac; implement and test a real Mac OAuth
  path before exposing it. Keep server-issued account identity authoritative.
- **PDF and files:** use macOS PDFKit or the tested web PDF.js path. Implement
  persistent lecture downloads, annotation, file open/save panels, share,
  print, and file sandbox access. Test large PDFs and relaunch offline.
- **Purchases:** use a macOS-supported RevenueCat/StoreKit implementation,
  register the Mac product configuration, and connect it to the existing
  server-side entitlement reconciliation. Test buy, restore, expired, and
  cross-platform entitlements. Do not reuse the iOS Capacitor plugin by
  assumption, and do not expose web payment rails in the Mac App Store build.
- **Permissions:** implement only Mac capabilities the product uses. Test
  camera, location, notifications, download/share, and denial paths. A Mac
  lecturer QR presenter does not require camera; student scanning does if
  offered. Give an explicit fallback for missing hardware.
- **Privacy/security:** document stored roster data and offline retention,
  validate all bridge inputs, avoid logging student PII or keys, and make
  sandbox file access intentional. Review the Mac privacy manifest and App
  Store privacy answers against actual SDK behavior.

**Gate:** every exposed control in the Mac feature matrix has a passing Mac
runtime check or is removed with accurate product copy.

## Phase 5 — Codemagic and release engineering

Add two independent workflows to `codemagic.yaml` after the Mac target exists:

| Workflow | Required steps | Artifact / gate |
| --- | --- | --- |
| `macos-qa` | `npm ci`; Mac web build and asset checks; resolve Swift packages; unsigned Mac target build; unit/integration tests; remote VNC runtime pass | `.app`, logs, test results; no upload |
| `macos-release` | Same checks; verify no debug tools or off-Apple purchase surface; set unique Mac build number; fetch Mac App Store profile/certificates; archive/sign; package with Mac Installer Distribution certificate; inspect entitlements and bundle resources | Signed `.pkg` and dSYMs; upload only after QA gate |

Use Codemagic's App Store Connect integration. Mac distribution requires a Mac
App Distribution certificate, Mac App Store provisioning profile, and a Mac
Installer Distribution certificate for the `.pkg`. Enable App Sandbox and
only the required entitlements. First publish to TestFlight; inspect the
processed build and Mac runtime before App Review. Do not reuse the iOS
`xcode-project build-ipa` step or `ios_signing` block.

Without a physical Mac, use Codemagic's interactive remote builder for Xcode
and runtime checks. Also recruit at least one Apple silicon Mac tester for the
actual TestFlight/store install, since CI compilation and a temporary builder
do not verify the delivered app or all hardware states.

## Phase 6 — product page, migration, and launch

1. Capture the **running Mac app** on the remote Mac with fictional/test data.
   Supply Mac 16:10 screenshots at an accepted size (1280×800, 1440×900,
   2560×1600, or 2880×1800). Do not stretch iPad screenshots into Mac assets.
2. Complete Mac-specific description, privacy, category, review credentials,
   notes explaining offline attendance preparation/reconciliation, and
   subscription metadata. Select the processed Mac build and submit for review.
3. Before replacing an existing iPad-on-Mac installation, ensure its pending
   attendance work is uploaded. A new native Mac app has a separate local
   container and signing identity; server-confirmed records can be fetched,
   but unresolved device-bound receipts/commands cannot be assumed to migrate.
4. Release in a controlled territory/test cohort, monitor crash and sync
   diagnostics without private data, and verify an App Store install, login,
   offline session, reconnection, and subscription restore. Keep the iOS
   release lane independent.

## Verification matrix and release blockers

| Scenario | Required result |
| --- | --- |
| Offline first launch without a prepared pack | No QR authority; emergency draft saves locally with a clear pending label |
| Prepared pack, network lost, Mac clock changed | Server-issued authority and server reconciliation remain decisive; no false confirmation |
| Force quit between DB commit and JS response | Reopen finds the same session/command/request ID; no duplicate |
| Sleep/reboot during upload | Queue survives, lease recovers, retry is idempotent |
| Two lecturer accounts on one Mac | Each sees only its own cache/commands; no cross-account upload |
| Permit expired or revoked | New offline QR blocked locally when known; server rejects invalid import; draft path remains |
| Disk full, Keychain unavailable, DB corrupt | Explicit `not saved` or repair state; no fabricated success or destructive reset |
| Import succeeds, acknowledgement fails | Retry does not duplicate attendance; local acknowledgement eventually commits |
| Conflicting remote revision or ambiguous draft | Item becomes `needs_help`; lecturer can inspect and resolve; evidence remains |
| Late student receipt | Existing 36-hour automatic deadline and reasoned doctor review remain intact |
| TestFlight and store install | Sandbox, login, files, PDF, purchases, QR presentation, and reconnection work in delivered binary |

Release is blocked until Mac compile, runtime, offline reconciliation,
TestFlight/store install, Mac screenshots, signing, and App Store metadata all
have recorded evidence. Passing iOS tests or an unsigned Mac compile is not a
substitute.

## References

- [Apple: Add platforms and separate Xcode targets](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-platforms/)
- [Apple: Mac screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications)
- [Apple: Mac App Sandbox](https://developer.apple.com/documentation/xcode/configuring-the-macos-app-sandbox)
- [Codemagic: Signing macOS apps](https://docs.codemagic.io/yaml-code-signing/signing-macos/)
- [Codemagic: App Store Connect publishing](https://docs.codemagic.io/yaml-publishing/app-store-connect/)
- [Capacitor: Supported application targets](https://capacitorjs.com/docs/getting-started/environment-setup)
- [RevenueCat: macOS installation and universal purchases](https://www.revenuecat.com/docs/getting-started/installation/ios)
