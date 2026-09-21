import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');

  // Three targets, not two.
  //
  //   mode 'native'  -> the Android APK/AAB. Sells NOTHING: Play forbids taking
  //                     real money outside its own billing AND forbids steering
  //                     users elsewhere, so the whole purchase surface is
  //                     aliased away.
  //   mode 'ios'     -> the App Store .ipa. Sells through APPLE's billing via
  //                     RevenueCat, which Apple requires. So it keeps a paywall
  //                     - just not the web one: ZainCash, Super Qi, the receipt
  //                     upload and the seller's WhatsApp/Telegram number are
  //                     Guideline 3.1.1 violations in an iOS binary for exactly
  //                     the reason they are Play violations in the APK.
  //   default        -> the web build, bound by neither.
  //
  // `isBundled` is "inside an app binary", which is what the store scanners
  // read and what IS_STORE_BUILD has always meant. `isIos` is the narrower
  // "may sell, through Apple".
  const isIos = mode === 'ios';
  const isBundled = mode === 'native' || isIos;

  return {
    base: './',
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      rollupOptions: {
        output: {
          // The legal pages get their own chunk, named so that
          // scripts/assert-no-payment-surface.mjs recognises it.
          //
          // That check exempts /^assets\/legal-/ because a privacy policy has
          // to name the payment processor truthfully - the stores penalise a
          // purchase FLOW in the binary, not an accurate disclosure about one
          // on the website. Pinning the pages into a dedicated chunk is what
          // keeps the exemption honest: nothing else can hide behind it.
          manualChunks(id) {
            if (id.includes('/src/components/legal/')) return 'legal-pages';
            // Same device, same reason. RevenueCat's SDK enumerates every store
            // it supports - Stripe among them - so it trips the scanner's
            // payment-gateway-name rule legitimately. Pinning it into its own
            // chunk is what lets that one rule be exempted for this one chunk
            // without opening a hole anything else could hide in. The currency
            // and filename rules still apply to it.
            //
            // Guarded on isIos, and that guard is the honest part. The SDK is
            // tree-shaken out of the web and Android graphs entirely (verified:
            // zero hits for RevenueCat, getOfferings or PURCHASES_ERROR_CODE in
            // a native build), which left this rule naming an EMPTY chunk that
            // Rollup then filled with Vite's shared preload helper - so the
            // scanner's exemption would have been attached to 9KB of unrelated
            // runtime on the one target that may not sell at all. Now the chunk
            // exists only where the SDK does.
            if (isIos && id.includes('node_modules/@revenuecat/')) return 'revenuecat';
            // The support desk's own Telegram and WhatsApp. A support contact
            // link is not a contact-to-BUY flow and both stores allow it, but
            // it is written with the same `t.me/` / `wa.me/` literals the
            // seller's payment contact uses (src/lib/paymentContact.ts) - so
            // the scanner cannot tell them apart by pattern. Pinning it into
            // its own chunk is what lets that one rule be exempted here
            // without also excusing the payment rail.
            if (id.includes('/src/lib/support.ts')) return 'support-contact';
            return undefined;
          },
        }
      }
    },
    plugins: [
      react(), 
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        injectRegister: 'script',
        // The APK already carries every asset locally, so precaching buys nothing
        // there - and actively harms: a Workbox SW registered by an older build
        // keeps serving its cached shell after the user installs a new APK, so
        // app updates silently never take effect. selfDestroying emits a worker
        // that unregisters itself and deletes every cache instead, which also
        // rescues devices already stuck on the old precaching SW.
        selfDestroying: isBundled,
        workbox: {
          inlineWorkboxRuntime: true,
          importScripts: ['/firebase-messaging-sw.js'],
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
          // The announcement composer's editor (Tiptap/ProseMirror, ~128KB
          // gzipped) is lazy-loaded and only ever mounted by admins and
          // moderators. Precaching it would hand that download to every student
          // in the background, which is exactly what the React.lazy() boundary
          // in Composer.tsx exists to avoid - globPatterns above sweeps up every
          // emitted .js chunk regardless of who can reach it.
          //
          // The trade: an admin who opens the composer while offline gets the
          // loading state instead of an editor. Acceptable, because publishing
          // needs the network anyway - attachment uploads cannot queue.
          globIgnores: ['**/ComposerEditor-*.js'],
          maximumFileSizeToCacheInBytes: 5000000,
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'google-fonts-cache',
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365 // <== 365 days
                },
                cacheableResponse: {
                  statuses: [0, 200]
                }
              }
            },
            {
              urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'gstatic-fonts-cache',
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365 // <== 365 days
                },
                cacheableResponse: {
                  statuses: [0, 200]
                }
              }
            },
            {
              urlPattern: /^https:\/\/lh3\.googleusercontent\.com\/.*/i,
              handler: 'StaleWhileRevalidate',
              options: {
                cacheName: 'google-avatars',
                expiration: {
                  maxEntries: 50,
                  maxAgeSeconds: 60 * 60 * 24 * 30 // 30 days
                }
              }
            }
          ]
        },
        manifest: {
          id: '/',
          name: 'محاضراتي',
          short_name: 'محاضراتي',
          description: 'Lecture management and offline viewing',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          orientation: 'portrait',
          theme_color: '#0284c7',
          background_color: '#ffffff',
          lang: 'ar',
          dir: 'rtl',
          categories: ['education'],
          icons: [
            {
              src: '/icons/icon-192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any'
            },
            {
              src: '/icons/icon-maskable-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any maskable'
            }
          ],
          // No `screenshots` key. It used to advertise /screenshot-mobile.png and
          // /screenshot-desktop.png, both of which were committed CORRUPT -- their
          // leading PNG signature byte had been replaced by a UTF-8 replacement
          // sequence, so no decoder would touch them. Real captures belong here
          // eventually; a broken reference is worse than none.
          shortcuts: [
            { name: 'محاضرات', url: '/lectures', icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }] },
            { name: 'واجبات', url: '/homeworks', icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }] },
            { name: 'إعلانات', url: '/announcements', icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }] }
          ],
          share_target: {
            action: '/share',
            method: 'POST',
            enctype: 'multipart/form-data',
            params: { title: 'title', text: 'text', url: 'url' }
          },
          display_override: ['window-controls-overlay', 'standalone'],
          prefer_related_applications: false,
          iarc_rating_id: 'e84b072d-71b3-4d3e-86ae-31a8ce4e53b7',
          scope_extensions: [
            { origin: 'https://mohadaraty.vercel.app' }
          ]
        }
      })
    ],
    define: {
      // GEMINI_API_KEY is deliberately NOT defined here any more.
      //
      // It used to inline the key into the client bundle, where anyone could
      // read it. It never even worked: the only consumer guarded the read with
      // `typeof process !== 'undefined'`, which is false in a browser, so the
      // substituted literal was never reached and only VITE_GEMINI_API_KEY ever
      // supplied a key. Both Gemini pipelines are server-side now, so no key
      // belongs in this bundle - and re-adding a define here would silently
      // publish it again.
      // True for BOTH bundled targets. This is what src/lib/platform.ts reads as
      // IS_STORE_BUILD and what src/lib/apiBase.ts keys the absolute API base
      // off - both of which are about "running inside an app binary", which iOS
      // is. What iOS is NOT is "cannot sell"; that distinction is CAN_SELL,
      // derived from the flag below.
      '__NATIVE_BUILD__': JSON.stringify(isBundled),
      '__IOS_BUILD__': JSON.stringify(isIos),
    },
    resolve: {
      // Array form so the native entries can match on a REGEX. Vite resolves
      // aliases against the import SPECIFIER, not the file it resolves to, and
      // App.tsx imports './components/SubscriptionScreen' - so an absolute-path
      // key never matches and the alias silently does nothing.
      // Anchored to consume the ENTIRE specifier. A regex matching only the
      // tail leaves the leading "./" in place, because String.replace swaps
      // just the matched span - the resolved path comes out as ".C:/..." and
      // the build fails inside the PWA plugin with no useful message.
      alias: [
        { find: '@', replacement: path.resolve(__dirname, '.') },

        // Compile-time swapping of the real-money purchase surface.
        //
        // Both stores enforce their payments policy by scanning the uploaded
        // artefact. IS_STORE_BUILD only ever hid the UI at runtime, so the
        // native bundle still carried "ZainCash", "Pay with ZainCash" and
        // "IQD" - scripts/assert-no-payment-surface.mjs failed on exactly
        // that, with 21 hits.
        //
        // Three groups below, because the two stores want opposite things.
        // Play: do not sell here at all. Apple: sell here, through us. So the
        // same three specifiers resolve to inert stubs on Android and to an
        // Apple-native paywall on iOS, while the admin surfaces go to stubs on
        // both.
        //
        // -- BOTH bundled targets: the admin/dollar surfaces ----------------
        //
        // These are excluded from iOS for the same reason as Android and NOT
        // for the payments-policy reason: they are an admin ledger of real
        // transactions and a spend dashboard denominated in dollars. Neither
        // has any business in a student's phone on either platform, and
        // SimosanAdminScreen in particular is what the currency rule catches.
        ...(isBundled ? [
          {
            find: /^.*\/components\/SubscriptionManagement$/,
            replacement: path.resolve(__dirname, 'src/native-stubs/SubscriptionManagement.tsx'),
          },
          {
            find: /^.*\/components\/SimosanAdminScreen$/,
            replacement: path.resolve(__dirname, 'src/native-stubs/SimosanAdminScreen.tsx'),
          },
        ] : []),

        // -- ANDROID ONLY: no purchase surface at all -----------------------
        //
        // src/services/subscriptionService.ts is deliberately not listed:
        // these two components are its only importers, so replacing them
        // drops the service from the graph on its own.
        ...(mode === 'native' ? [
          {
            find: /^.*\/components\/SubscriptionScreen$/,
            replacement: path.resolve(__dirname, 'src/native-stubs/SubscriptionScreen.tsx'),
          },
          {
            find: /^.*\/components\/SubscriptionPaywall$/,
            replacement: path.resolve(__dirname, 'src/native-stubs/SubscriptionPaywall.tsx'),
          },
          {
            find: /^.*\/i18n\/payments$/,
            replacement: path.resolve(__dirname, 'src/native-stubs/payments.ts'),
          },
        ] : []),

        // -- iOS ONLY: an APPLE purchase surface ----------------------------
        //
        // Same three specifiers, different destinations. The iOS components
        // live under src/ios/ and are reachable ONLY through these aliases, so
        // the web and Android graphs never see them - the same mechanism that
        // already drops subscriptionService.ts above.
        //
        // The iOS components must never import src/services/subscriptionService
        // or src/lib/paymentContact: doing so pulls ZainCash, the receipt
        // upload and the seller's WhatsApp/Telegram number straight back into
        // the .ipa. scripts/assert-no-payment-surface.mjs is the backstop.
        ...(isIos ? [
          {
            find: /^.*\/components\/SubscriptionScreen$/,
            replacement: path.resolve(__dirname, 'src/ios/SubscriptionScreen.ios.tsx'),
          },
          {
            find: /^.*\/components\/SubscriptionPaywall$/,
            replacement: path.resolve(__dirname, 'src/ios/SubscriptionPaywall.ios.tsx'),
          },
          {
            find: /^.*\/i18n\/payments$/,
            replacement: path.resolve(__dirname, 'src/i18n/paymentsIos.ts'),
          },
        ] : []),
      ],
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
