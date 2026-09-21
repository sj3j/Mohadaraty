// Fail the native build if a real-money purchase surface survived into it.
//
// WHY A BUILD STEP AND NOT A CHECKLIST
//
// Both stores enforce the payments policy by scanning the uploaded artefact, not
// by clicking through the app. A runtime guard like `if (!isNativePlatform())`
// hides a button but leaves the strings, the prices and the payment-provider
// button images sitting in the binary for a static scan to find.
//
// Runtime hiding also rots. The gate is one refactor away from being bypassed,
// and nobody notices until a reviewer does. A build assertion cannot rot: the
// build fails.
//
// Pair this with COMPILE-TIME exclusion (a bundler `define` that folds the
// branch away, so the module is never emitted) rather than a runtime boolean.
// This script is what proves the exclusion actually worked.
//
// USAGE
//   node scripts/assert-no-payment-surface.mjs [distDir]
// Run it as the last step of the native build, after any prune step:
//   "build:native": "vite build --mode native && node scripts/prune-native-assets.mjs && node scripts/assert-no-payment-surface.mjs"
// (prune-native-assets.mjs is your own project step, if you have one -- this
//  script only needs to run last, against the final native output.)
//
// ADAPT THE PATTERNS BELOW. They are the point of the file.
import fs from 'fs';
import path from 'path';

const DIST = path.resolve(process.argv[2] || 'dist');

// Matched against file CONTENTS.
//
// Narrow these to REAL-MONEY indicators. Over-broad patterns cost you working
// product for no policy gain, and a check that cries wolf gets deleted.
//
// Worth flagging: your payment provider's name, your currency code, a
// real-money order field, a cash-payout screen, contact-to-buy links.
//
// NOT worth flagging, usually:
//   - "Subscribe" / "Upgrade" where the purchase is made with in-game currency.
//     Selling in-app goods for in-app currency is not a real-money transaction;
//     what the stores forbid is taking real money outside their billing.
//   - "price" in an app that also has non-monetary prices.
//   - A support contact link that is not a contact-to-buy flow.
// Chunks exempt from a content rule.
//
// Privacy policy and terms pages legitimately NAME payment processors: an
// accurate privacy policy has to disclose who processes payments on your
// website, and terms correctly state that store purchases follow the store's
// own refund rules. The stores penalise a purchase FLOW inside the app, not a
// truthful disclosure about one elsewhere.
//
// Pin those pages into their own chunk (a bundler `manualChunks` entry) so this
// exemption stays honest and nothing else can hide behind it.
const LEGAL_CHUNK = [/^assets\/legal-/];

// The RevenueCat SDK, which ships only in the iOS bundle. It enumerates every
// store it supports - Stripe among them - so it trips the gateway-name rule
// legitimately, and ONLY that rule: it is exempted per-RULE, not per-file, so a
// currency code or provider-named asset inside it would still fail.
// vite.config.ts pins it into its own chunk for exactly this reason.
const REVENUECAT_CHUNK = [/^assets\/revenuecat-/];

// The support desk's own Telegram and WhatsApp (src/lib/support.ts). The
// comment at the top of this file already names "a support contact link that is
// not a contact-to-buy flow" as a false positive to avoid, and this is it - but
// it is spelled with the same t.me/ and wa.me/ literals the SELLER's payment
// contact uses (src/lib/paymentContact.ts builds `https://wa.me/${digits}` and
// `https://t.me/${username}` from settings/payment_contact), so no pattern can
// separate them. vite.config.ts pins support.ts into its own chunk; the rule
// keeps its teeth everywhere else.
const SUPPORT_CHUNK = [/^assets\/support-contact-/];

const FORBIDDEN_CONTENT = [
  // \b on both sides so a provider name is matched as a WORD. Without it this
  // fired on the xlsx library's Excel fill patterns - "HorzStripe",
  // "ThinVertStripe", "ReverseDiagStripe" - which have nothing to do with
  // Stripe the payment processor. That is the "cries wolf" failure this file
  // warns about two comments up: seven bogus hits on a dependency nobody can
  // change, on the one check standing between a release and a policy strike.
  //
  // Real integrations still match: "stripe.com", "Stripe(", "paypal.me" all
  // have a boundary on each side.
  {
    label: 'payment gateway name',
    re: /\b(stripe|paypal|zaincash|paddle|lemonsqueezy)\b/i,
    exempt: [...LEGAL_CHUNK, ...REVENUECAT_CHUNK],
  },
  { label: 'currency code', re: /\b(IQD|USD|EGP|SAR|AED)\b/, exempt: LEGAL_CHUNK },
  { label: 'real-money order field', re: /finalPrice[A-Z]{3}/, exempt: LEGAL_CHUNK },

  // The three rules below are about STEERING rather than about a gateway, and
  // they apply to BOTH store targets.
  //
  // iOS may sell - through Apple - so the gateway rules above stopped being the
  // whole story the moment an iOS build existed. What neither store permits is
  // pointing a user at a way to pay that is not the store's own: Apple
  // Guideline 3.1.1 and Play's Payments policy say the same thing in different
  // words. The manual Super Qi transfer is exactly that, and so is the seller's
  // WhatsApp/Telegram number, which exists only so a student can arrange one.
  //
  // These pass today because src/i18n/payments.ts, src/lib/paymentContact.ts
  // and src/services/subscriptionService.ts all leave the native graph with the
  // two components that import them. They are written down so that stays true
  // by rule rather than by luck.
  { label: 'manual-transfer wallet', re: /\bsuper\s*qi\b|\bsuperkey\b|سوبر كي/i, exempt: LEGAL_CHUNK },
  { label: 'off-store contact channel', re: /\b(t|wa)\.me\//i, exempt: [...LEGAL_CHUNK, ...SUPPORT_CHUNK] },
  { label: 'payment receipt storage path', re: /payment_receipts/, exempt: LEGAL_CHUNK },
];

// Matched against file NAMES — payment provider button artwork is the classic
// one, because images survive minification untouched and keep their filenames.
//
// Never exempted. A file called stripe-logo.png inside the legal chunk would
// still be a payment button; the honest-exemption argument above is about prose
// naming a processor, not about artwork.
const FORBIDDEN_FILENAMES = [/stripe|paypal|zaincash/i];

// Only text-bearing assets are scanned for content; everything is name-checked.
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.css', '.html', '.json', '.svg', '.txt',
]);

if (!fs.existsSync(DIST)) {
  console.error(`assert-no-payment-surface: ${DIST} does not exist. Build first.`);
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const violations = [];

for (const file of walk(DIST)) {
  const rel = path.relative(DIST, file);
  // Normalised because path.relative yields backslashes on Windows.
  const relPosix = rel.split(path.sep).join('/');

  for (const re of FORBIDDEN_FILENAMES) {
    if (re.test(path.basename(file))) {
      violations.push(`  ${relPosix}\n      filename matches ${re}`);
    }
  }

  if (!TEXT_EXT.has(path.extname(file).toLowerCase())) continue;

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  for (const { label, re, exempt } of FORBIDDEN_CONTENT) {
    // Per-RULE, so exempting the legal pages from "names a processor" does not
    // also exempt them from everything else, and so the RevenueCat chunk is
    // excused only for the one rule it legitimately trips.
    if (exempt?.some((ex) => ex.test(relPosix))) continue;
    const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
    const matches = text.match(new RegExp(re.source, flags));
    if (matches) {
      violations.push(
        `  ${relPosix}\n      ${label} -- ${matches.length} occurrence(s), ` +
          `e.g. ${JSON.stringify(matches[0])}`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error('\nassert-no-payment-surface: FAILED\n');
  console.error('A real-money purchase surface reached the native bundle:\n');
  console.error(violations.join('\n'));
  console.error(
    '\nGate it at COMPILE time, not runtime. A bundler define folds the branch\n' +
      'away so the module is never emitted; a runtime isNativePlatform() check\n' +
      'only hides the UI and leaves the evidence in the binary.\n',
  );
  process.exit(1);
}

console.log(
  'assert-no-payment-surface: clean -- no real-money purchase surface in the native bundle',
);
