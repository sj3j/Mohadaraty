import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

/**
 * A one-page build whose only job is to render the iOS paywall for the
 * App Store Connect review screenshot. See main.tsx.
 *
 * Separate from the app's vite.config.ts on purpose: it has no PWA plugin, no
 * service worker and no payment-surface chunking, because none of that affects
 * a screenshot and all of it would slow the build down. What it DOES share is
 * the component and the iOS vocabulary, which is the whole point.
 *
 *   npm run preview:paywall            # dev server, any browser's device mode
 *   npm run preview:paywall -- --build # static output in dist-paywall/
 *
 * PRICES ARE NOT IN THIS REPO. They live in App Store Connect, and a copy here
 * would be wrong the first time a tier changed. Pass them in:
 *
 *   PAYWALL_PRICES='{"com.mohadaraty.app.1month":"$1.99", ...}' npm run preview:paywall
 */
/** The App Store Connect tiers as of the first submission. Override with
 *  PAYWALL_PRICES rather than editing these, and update them here only when the
 *  tiers themselves change - a stale default is worse than an obvious one. */
const DEFAULT_PRICES: Record<string, string> = {
  'com.mohadaraty.app.1month': '$1.99',
  'com.mohadaraty.app.3months': '$4.99',
  'com.mohadaraty.app.6months': '$7.99',
  'com.mohadaraty.app.1year': '$9.99',
};

const prices = process.env.PAYWALL_PRICES
  ? { ...DEFAULT_PRICES, ...JSON.parse(process.env.PAYWALL_PRICES) }
  : DEFAULT_PRICES;

const root = path.resolve(__dirname);
const repo = path.resolve(__dirname, '../..');

export default defineConfig({
  // Root is the REPO, not this folder, and that is load-bearing. Tailwind v4
  // auto-detects which files to scan for class names relative to the Vite root:
  // rooted here it scanned scripts/paywallPreview/ only, found none of the
  // classes that live in src/ios/, and emitted a 13KB stylesheet that styled
  // nothing - the screenshot came out as unstyled HTML. publicDir then also
  // resolves to the app's own public/, which is where src/index.css loads
  // Tajawal from; a screenshot in a fallback face is not a screenshot of this
  // app either.
  root: repo,
  base: './',
  build: {
    outDir: path.resolve(repo, 'dist-paywall'),
    emptyOutDir: true,
    rollupOptions: { input: path.resolve(root, 'index.html') },
  },
  plugins: [react(), tailwindcss()],
  define: {
    __PREVIEW_PRICES__: JSON.stringify(prices),
    __PREVIEW_ACTIVE__: JSON.stringify(process.env.PAYWALL_ACTIVE === '1'),
    __IOS_BUILD__: 'true',
    __NATIVE_BUILD__: 'true',
  },
  resolve: {
    alias: [
      // The store boundary, and only that.
      { find: /^.*\/lib\/iap$/, replacement: path.resolve(root, 'iapMock.ts') },
      // The same vocabulary swap the real `--mode ios` build performs, so the
      // screenshot shows the strings the .ipa will show.
      { find: /^.*\/i18n\/payments$/, replacement: path.resolve(repo, 'src/i18n/paymentsIos.ts') },
      { find: '@', replacement: repo },
    ],
  },
});
