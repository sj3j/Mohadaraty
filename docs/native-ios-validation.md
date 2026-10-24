# Native iOS validation

## Touch-crash patch release (1.0.3)

The affected App Store install is 1.0.2 (31) on an iPhone 14 Pro Max running
iOS 26.5. A tap anywhere on the login screen closes the app. To confirm its
cause, share the latest app `.ips` report from Settings > Privacy & Security >
Analytics & Improvements > Analytics Data. Match its bundle version and binary
UUID to the 1.0.2 (31) Codemagic archive and dSYM, then symbolicate it in Xcode.
Check whether the terminating stack enters the PDF plugin's old `hitTest`
method swap. Keep the original report: a source-level match is not a substitute
for the installed binary's crash evidence.

Build 1.0.3 with build number greater than 31 on macOS. Before distribution,
confirm the `.ipa` contains `public/index.html`, `public/sw.js`, the PDF worker,
PDF standard fonts, and CMaps. Install it over the affected build so the test
also covers an update without clearing downloaded lectures or local annotations.

On the affected iPhone, tap empty space, each login field, the student/lecturer
switch, and sign in. The app must remain open. Then open and close a PDF; test
scroll, pinch zoom, page navigation, annotation tools, and a downloaded PDF in
airplane mode. Repeat the login and PDF checks on iOS 15 and iOS 16+ simulators;
the iOS 15 reader should allow reading/navigation and show the existing ink
availability notice. After release, check App Store crash reports for the same
signature on 1.0.3.

Build a diagnostic IPA only when investigating an affected device:

```powershell
$env:VITE_NATIVE_DIAGNOSTICS = 'true'
npm run ios:sync
```

Open `ios/App/App.xcworkspace` on macOS, archive the build, and install it on the affected iPhone. Diagnostics stay on that device in `localStorage.native_diagnostics_v1`; inspect or clear them through Safari Web Inspector. They contain only timestamps, phase, outcome, error code, authentication state, cache source, and lecture count.

Validate with the same student account on the website and iPhone:

1. Sign in with the student identifier and password.
2. Open Lectures and confirm the expected count appears.
3. Download a lecture with “تنزيل المحاضرة للقراءة”, restart the app, and read it with airplane mode enabled.
4. Disconnect and reconnect the network while on the Lectures tab; the retry control should recover a failed refresh without clearing existing results.
5. Repeat the download check on Android.

Do not ship `VITE_NATIVE_DIAGNOSTICS=true` in a production build.
