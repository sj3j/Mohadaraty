# Native iOS validation

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
