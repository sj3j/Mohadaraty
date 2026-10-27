# Native macOS QA application

This directory contains the separate SwiftUI/AppKit macOS application. It is
not a Catalyst target and is not part of `ios/App/App.xcodeproj`.

## Build flow

1. Run `npm run build:macos`. This creates the Mac Vite bundle, validates it,
   and stages it in the gitignored `MohadaratyMac/Resources/WebApp` directory.
2. On macOS, build `MohadaratyMac.xcodeproj` with the shared
   `MohadaratyMac` scheme. The Milestone 1 CI command disables code signing.
3. In Codemagic, run the manual `macos-qa` workflow. Its artifact is
   `build/macos/Mohadaraty.app.zip`; it does not publish anything.

The application serves the embedded bundle at `capacitor://localhost`, but it
does not initialize Capacitor. Native behavior is exposed only through the
versioned `mohadaraty` WebKit message handler.

Swift/Xcode compilation and the two launch smoke tests require a Mac. Windows
can run the TypeScript, bundle, attendance, isolation, and YAML checks only.

