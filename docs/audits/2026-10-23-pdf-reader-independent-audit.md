# Independent PDF Reader Audit

**Date:** 2026-10-23  
**Verdict:** **Blocked - not ready for production**  
**Candidate:** `55bd7981d5aaf83f686354153253ab87779613d5` plus the frozen 28-file dirty working tree

## Scope and integrity

This is an evidence-gathering audit of all claimed PDF-reader phases. No application source or real user data was changed. Before testing, SHA-256 values were captured for all 28 modified/untracked candidate files. The same manifest was rechecked after testing and was unchanged.

`git diff --check` found one pre-existing whitespace error: `src/vite-env.d.ts:36` has a blank line at EOF.

## Environment

| Item | Evidence |
| --- | --- |
| Node / npm | v24.14.1 / 11.15.0 |
| Capacitor / Gradle | 8.5.3 / 8.11.1 |
| Java | Default Temurin 17.0.19; Android Studio JBR 21.0.10 available |
| Android target inventory | `Pixel_8` AVD exists, no device was running |
| iOS tooling | `swiftc` and `xcodebuild` unavailable on this Windows host |
| CI | No `.github/workflows` directory |
| PDF raster tooling | `pdftoppm`/`pdfinfo` unavailable |

The first Android build failed under the default Java 17 because Capacitor's Android dependency requires source release 21. Re-running with Android Studio JBR 21 compiled and packaged Debug successfully.

## Traceability and evidence

| Phase / requirement | Reachable implementation observed | Evidence run | Result |
| --- | --- | --- | --- |
| Phase 1: bridge and interaction revision routing | `PdfReaderOverlay` -> `nativePdfViewer` -> registered `MohadaratyPdf` plugins on Android/iOS | `test:pdf-interaction`, source trace, Android Debug compile | Partial: static contracts and Android compile pass; no device proof |
| Phase 2: native ink and gesture ownership | Android `NativePdfReaderHost`, `NativeGestureCoordinator`, `PdfInkOverlayView`; iOS `NativePdfPageOverlayProvider` / `PdfGeometryAdapter` | `pdfNativeInkV2.test.ts`, Android Debug compile | Partial: 9 source/algorithm checks pass; no Android/iOS interaction runtime evidence |
| Phase 3: canonical V2, durability, export | `unifiedPdfAnnotationService`, native repository journal/strokes, `pdfExportService` | `pdfUnifiedAnnotation.test.ts`, `nativePdfStorage.test.ts` | Partial: 9 canonical/export and 26 storage-contract checks pass; no native sandbox migration, crash recovery, or visual export evidence |
| Phase 4: hardening, rollback, performance, security | revisioned interaction state and `VITE_PDF_NATIVE_INK_V2` gate are reachable | interaction tests and source trace | Partial: no device performance, ANR, log-leak, feature-rollback, or stress-on-device evidence |

Static source-contract tests are not credited as proof of native touch delivery, persistence durability, or PDF rendering.

## Commands and results

| Command / check | Classification | Result |
| --- | --- | --- |
| `npm run test:pdf-interaction` | unit/static contract | Pass: interaction revision (1), stability contract (8), drawing (15), web DOM/vector (18) |
| `npx tsx scripts/pdfNativeInkV2.test.ts` | static contract + geometry math | Pass: 9/9 |
| `npx tsx scripts/pdfUnifiedAnnotation.test.ts` | Node integration | Pass: 9/9, including idempotency, journal simulation, export parseability, and 100-stroke undo/redo |
| Reader anchor/search/compat/text/mobile/gesture checks | unit/static contract | Pass except `pdfSearchAndTheme.test.ts` |
| `npx tsx scripts/nativePdfStorage.test.ts` | mocked native-storage integration | Pass: 26/26 |
| `npx tsx scripts/offlinePersistence.test.ts` | unit/integration | Pass: 21/21 |
| `npm run lint` / direct `tsc --noEmit` | type check | Inconclusive: both exceeded the local 30-second command window without an exit result |
| `npm run build`, `build:native`, `build:ios` | web bundle | Processes completed and refreshed `dist`; no final exit result was captured by the command controller. All emitted the same Vite warning about browser externalization of the guarded dynamic `fs`/`path` imports in `pdfExportService`. |
| `gradlew :app:compileDebugJavaWithJavac :app:assembleDebug` with JBR 21 | Android compile/package | Pass: `BUILD SUCCESSFUL`; Debug APK refreshed at 2026-10-23 16:00:11 |
| iOS native compilation / simulator | native build/runtime | Blocked: no macOS/Xcode |
| Android install/runtime | device runtime | Blocked: no running disposable emulator and `adb` was not on PATH; existing AVD was intentionally not booted |
| PDF raster and independent-viewer inspection | visual export | Blocked: no generated visual fixture/export run and no Poppler tools |

## Findings

| ID | Severity | Status | Finding and evidence |
| --- | --- | --- | --- |
| AUD-001 | High | Open | iOS native compilation, simulator/device interaction, PencilKit input, and iOS export verification are absent. iOS is a supported target, so source review cannot clear this release gate. |
| AUD-002 | High | Open | Android native touch routing, multi-touch cancellation, lifecycle recovery, and stylus/palm behavior have no clean-device evidence. `Pixel_8` exists but no disposable device was running; it was not modified. |
| AUD-003 | High | Open | No visual export test proves page geometry, crop/rotation handling, font embedding, Arabic/mixed RTL-LTR rendering, or inspection in two independent viewers. The Node export test proves PDF parseability only. |
| AUD-004 | High | Open | Canonical journal, legacy IndexedDB-to-native migration, interruption recovery, and durable undo/redo have not been exercised in an actual native app sandbox. Existing tests use Node/mock storage. |
| AUD-005 | Medium | Open | There is no CI workflow to select Java 21, compile Android, build iOS, or run the PDF checks. Default Java 17 fails Android compilation with `invalid source release: 21`; JBR 21 succeeds. |
| AUD-006 | Low | Open | `scripts/pdfSearchAndTheme.test.ts` fails because it asserts the obsolete identifier `isAnyDrawerOpen`. The current source includes `searchOpen` in the renamed `isAnyWebOverlayOpen` condition, so this is a stale static test rather than demonstrated runtime failure. |
| AUD-007 | Low | Open | `git diff --check` reports a blank line at EOF in `src/vite-env.d.ts`. |
| AUD-008 | Informational | Open | All Vite builds warn that guarded dynamic Node `fs`/`path` imports in `pdfExportService` are externalized for browser compatibility. The browser branch is not executed by current evidence; verify it during real web/native export testing. |

## Required closure evidence

1. On macOS/Xcode, compile the frozen iOS candidate and run the complete reader matrix on a clean simulator/device; include Apple Pencil evidence where supported.
2. Create a clean Android AVD, install the freshly built Debug APK, and capture UI/video plus `logcat` for read/annotate tools, zoom/pan, multi-touch, rapid mode changes, open/close, and background/foreground recovery.
3. Use disposable fixture PDFs covering page orientation, rotation, crop/media boxes, long documents, raster/vector pages, invalid input, Arabic, and mixed RTL/LTR. Export each and compare original/export metadata; rasterize and inspect in two independent viewers.
4. Run migration, duplicate/out-of-order operations, forced-close recovery, journal idempotency, autosave, and undo/redo against real platform storage. Preserve before/after storage snapshots only from disposable sandboxes.
5. Repeat heavy-document scenarios three times per platform and collect memory, jank/frame, crash/ANR, and privacy-log evidence. Add these checks to CI with Java 21 and a macOS iOS job.

Only after all High findings are closed may this candidate be reassessed for production readiness.
