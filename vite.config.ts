import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
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
        selfDestroying: mode === 'native',
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
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      '__NATIVE_BUILD__': JSON.stringify(mode === 'native'),
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

        // Compile-time removal of the real-money purchase surface.
        //
        // Both stores enforce their payments policy by scanning the uploaded
        // artefact. IS_STORE_BUILD only ever hid the UI at runtime, so the
        // native bundle still carried "ZainCash", "Pay with ZainCash" and
        // "IQD" - scripts/assert-no-payment-surface.mjs failed on exactly
        // that, with 21 hits.
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
            find: /^.*\/components\/SubscriptionManagement$/,
            replacement: path.resolve(__dirname, 'src/native-stubs/SubscriptionManagement.tsx'),
          },
          {
            find: /^.*\/components\/SubscriptionPaywall$/,
            replacement: path.resolve(__dirname, 'src/native-stubs/SubscriptionPaywall.tsx'),
          },
          {
            find: /^.*\/i18n\/payments$/,
            replacement: path.resolve(__dirname, 'src/native-stubs/payments.ts'),
          },
          // Simosan's spend dashboard reports dollars against a monthly
          // ceiling. Same hazard as the screens above: admin-only React is
          // still in the artefact the scanner reads.
          {
            find: /^.*\/components\/SimosanAdminScreen$/,
            replacement: path.resolve(__dirname, 'src/native-stubs/SimosanAdminScreen.tsx'),
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
