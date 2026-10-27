# Apple silicon Mac release of the iPad app

This guide covers only the existing iPad app running on Apple silicon. For a
separate native macOS binary and macOS App Store version, use
[`native-macos-implementation-plan.md`](native-macos-implementation-plan.md).

Mohadaraty uses the existing iOS/iPadOS app (`com.mohadaraty.app`) on Apple
silicon Macs. The repository has an iOS IPA workflow and an iPad target
(`TARGETED_DEVICE_FAMILY = "1,2"`); it does not have a native macOS or
Mac Catalyst target. The separate **macOS App Version 1.0** draft in App Store
Connect is not part of this release. Do not submit that draft or upload a Mac
binary for this route.

## Current evidence and release gates

| Gate | Evidence required | Current status |
| --- | --- | --- |
| iOS 1.0.3 release | Confirm the processed Codemagic `ios-release` IPA, build number, and App Store Connect **Ready for Distribution** status. | Public Iraq storefront lookup on 2026-10-24 still reports **1.0.2**. The last supplied App Store Connect screenshot showed 1.0.3 **Waiting for Review**. |
| Mac compile | Run `ios-mac-qa` and keep its Xcode destination/build log. | Workflow prepared; no Mac build has run in this workspace. |
| Mac runtime | Run **My Mac (Designed for iPad)** on the Codemagic Apple silicon builder and record the checks below. | Unverified. A successful compile is not a runtime pass. |
| iOS screenshots | Inspect the iOS product page for its required iPhone and 13-inch iPad screenshots. | Public storefront lookup reports five iPhone and four iPad images for 1.0.2; the 1.0.3 draft assets and exact screenshot slots remain unverified. |
| Mac availability | Select **Make this app available** in App Store Connect after the gates above pass. | Unverified without App Store Connect access. |
| Mac storefront | Find the approved app under **iPhone & iPad Apps** on an Apple silicon Mac and install it. | Unverified. |

Apple's Mac availability option is **app-wide**, so enabling it while iOS
1.0.2 is still the live version could expose that version on Macs. Wait until
the corrected 1.0.3 build is live and Mac runtime QA passes. The 1.0.2
touch-crash report has not been confirmed against a symbolicated binary.

## Run the Mac QA workflow

1. In Codemagic, start the manual `ios-mac-qa` workflow from the intended
   Git commit and select **Enable SSH/VNC access**. It uses an Apple M2 builder,
   prepares the iOS web/PDF bundle, checks the iPad Mac destination, and
   compiles the same iOS target for that destination. It does not publish.
2. During the build, use **Explore build machine via SSH or VNC/RDP client**.
   Connect with the per-build VNC host, port, username, and password shown by
   Codemagic. The workflow keeps the machine available for 20 minutes after
   compilation. Change `MAC_QA_HOLD_SECONDS` for this run if needed, up to
   1800 seconds. Credentials expire after the build session.
3. In the remote desktop, open `ios/App/App.xcworkspace` in Xcode. Choose
   **My Mac (Designed for iPad)** and run the app. If that destination is
   absent, the workflow will stop and save `destinations.txt`; investigate
   the builder/Xcode configuration before claiming Mac compatibility. If
   local launch requires signing, configure a suitable development profile
   in Codemagic and record that result; the unsigned compile alone is not a
   runtime test.
4. Record the Git commit, Xcode/macOS versions, build number, and each result
   below. Use test accounts and PDF fixtures without private student data.
   Capture a screenshot or a short screen recording for failures.

### Runtime checks

| Area | Expected result | Result / evidence |
| --- | --- | --- |
| Login and session | Empty clicks, fields, buttons, sign-in, and relaunch stay stable; valid session restores. | Pending |
| PDF | Open/close, page navigation, mouse or trackpad zoom, reading, and annotation work. | Pending |
| Local files | Download one and several PDFs, quit/reopen, read offline, share, and save to Files. | Pending |
| Subscriptions | Paywall and existing entitlements load; purchase/restore can complete in an appropriate sandbox account. | Pending |
| Window | Resize, scroll, modal layout, and landscape/portrait content stay usable. | Pending |
| Camera | The QR scanner uses an available Mac camera or presents its manual attendance fallback. | Pending |
| Location | Attendance handles location permission and low precision without a crash; record whether the campus check succeeds. | Pending |
| Notifications | Permission request and delivery behavior are checked; unsupported behavior is clearly reported. | Pending |

The camera and location paths depend on Mac hardware and permission behavior.
PDFKit/PencilKit mouse input and Capacitor share/filesystem behavior also need
the runtime pass. Source review does not establish their Mac compatibility.

If the VNC builder cannot run iOS apps on Mac, use a TestFlight tester with
an Apple silicon Mac instead. Apple lets a TestFlight group enable
**Test iPhone and iPad apps on Apple silicon Macs** separately from public
Mac availability.

## Product page and release

1. In App Store Connect, inspect the **iOS App** record, not the separate
   macOS 1.0 draft. Confirm 1.0.3 has finished processing and is **Ready for
   Distribution**. Match its build number to the Codemagic artifact. Do not
   infer this from a source version string or an old screenshot.
2. In the iOS product page, verify at least one iPhone Dynamic Island
   screenshot and one 13-inch iPad screenshot. The separate macOS draft's
   screenshot slots do not apply to this iPad-app route. If replacement iOS
   images are needed, capture the real app on Codemagic simulators with test
   data and add them to an editable iOS version. A version already
   **Waiting for Review** may require a status change before editing.
3. After the Mac checks pass, open **Pricing and Availability → iPhone and
   iPad Apps on Apple Silicon Mac**. Select **Make this app available**,
   inspect the minimum macOS version and available territories, then save.
   Only select **Verify Compatibility** after a complete runtime pass.
4. On an Apple silicon Mac in an enabled territory, find Mohadaraty under
   **iPhone & iPad Apps**, install it, and repeat login, PDF, offline, and
   sharing smoke tests on the store build. Record the store link and version.
5. If the availability option is missing or disabled because of the separate
   macOS draft or universal-purchase configuration, contact App Store Connect
   support about that record. Preserve the published iOS app record.

## Sources

- [Apple: Manage availability of iPhone and iPad apps on Macs with Apple silicon](https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/manage-availability-of-iphone-and-ipad-apps-on-macs-with-apple-silicon)
- [Apple: Running your iOS apps in macOS](https://developer.apple.com/documentation/apple-silicon/running-your-ios-apps-in-macos)
- [Apple: Test iPhone and iPad apps on Macs with Apple silicon using TestFlight](https://developer.apple.com/help/app-store-connect/test-a-beta-version/test-iphone-and-ipad-apps-on-macs-with-apple-silicon/)
- [Apple: Screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications)
- [Codemagic: Remote access to a build machine](https://docs.codemagic.io/troubleshooting/accessing-builder-machine-via-ssh/)
- [Apple public Iraq storefront lookup for Mohadaraty](https://itunes.apple.com/lookup?id=6814124686&country=iq) (public live listing only; it does not report App Store Connect review state)
