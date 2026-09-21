/// <reference types="@capacitor-firebase/authentication" />

import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor wrapping for the Android build.
 *
 * Deliberately NO `server.url`. Pointing the WebView at mohadaraty.vercel.app
 * would make this a remote-URL wrapper, which Apple rejects under Guideline 4.2
 * and which breaks completely whenever the phone is offline. The web build is
 * bundled into the APK instead; only /api/* calls go out to the server.
 *
 * `androidScheme: 'https'` matters beyond cosmetics: it makes the WebView a
 * secure context, which crypto.subtle (used by src/lib/hash.ts for password
 * hashing) and navigator.clipboard both refuse to run without.
 */
const config: CapacitorConfig = {
  appId: 'com.mohadaraty.app',
  appName: 'محاضراتي',
  webDir: 'dist',

  android: {
    // The origin the WebView reports. Must match the CORS allowlist on the API
    // and Firebase Auth's authorized domains.
    allowMixedContent: false,
  },

  ios: {
    // The WebView does not inset its own content; the app shell already
    // handles the safe area itself (App.tsx's root carries
    // paddingTop: env(safe-area-inset-top), and pb-[104px] for the floating
    // nav). Letting WKWebView add its own inset on top would double both.
    contentInset: 'never',
  },

  server: {
    androidScheme: 'https',
    // Same reason as androidScheme above, and it is NOT cosmetic here either:
    // src/lib/hash.ts hashes passwords with crypto.subtle, which refuses to run
    // outside a secure context, so login itself depends on this. Capacitor's
    // default iOS scheme is `capacitor://localhost`; pinning it to https keeps
    // the origin shape identical on both platforms, which also keeps one CORS
    // allowlist and one set of Firebase authorized domains valid for both.
    iosScheme: 'https',
    // Keep top-level navigation inside the app; outward links open in a browser
    // sheet rather than replacing the app shell with a page it cannot leave.
    allowNavigation: [],
  },

  plugins: {
    // WITHOUT this block Google sign-in throws a raw Java NPE at the student:
    // FirebaseAuthentication.java only constructs GoogleAuthProviderHandler
    // when `providers` contains 'google.com', but signInWithGoogle() calls that
    // handler unguarded. An empty provider list therefore fails as
    // "signIn() on a null object reference" rather than anything diagnosable.
    FirebaseAuthentication: {
      // Native sign-in mints a Firebase session that src/lib/googleSignIn.ts
      // immediately signs out of - the custom token from /api/google-login is
      // the only identity that survives. Leave this false so the native SDK
      // (not the JS SDK, which cannot open an OAuth flow inside a WebView)
      // performs the account-picker handshake.
      skipNativeAuth: false,
      providers: ['google.com'],
    },
    SplashScreen: {
      launchShowDuration: 1200,
      backgroundColor: '#ffffff',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
    },
  },
};

export default config;
