/**
 * Verification test for iOS Paywall Apple App Store Review Guideline 3.1.2 compliance.
 *
 *   npx tsx scripts/iosPaywallCompliance.test.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { PAYMENT_STRINGS, getIosPlanLabel, getIosBillingDescription } from '../src/i18n/paymentsIos';

let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); failed++; }
};

const root = join(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

console.log('\n--- 1. Plan Duration Clarification (Guideline 3.1.2) ---');
check('seasonal plan label is explicitly "فصلي (3 أشهر)" in Arabic',
  getIosPlanLabel('seasonal', 'Quarterly', true) === 'فصلي (3 أشهر)');
check('seasonal plan label is explicitly "Quarterly (3 Months)" in English',
  getIosPlanLabel('seasonal', 'Quarterly', false) === 'Quarterly (3 Months)');
check('annual plan label is "سنوي" in Arabic and "Annual" in English',
  getIosPlanLabel('annual', 'Annual', true) === 'سنوي' &&
  getIosPlanLabel('annual', 'Annual', false) === 'Annual');
check('semi_annual plan label is "نصف سنوي (6 أشهر)" in Arabic',
  getIosPlanLabel('semi_annual', 'Semi-Annual', true) === 'نصف سنوي (6 أشهر)');
check('monthly plan label is "شهري" in Arabic and "Monthly" in English',
  getIosPlanLabel('monthly', 'Monthly', true) === 'شهري' &&
  getIosPlanLabel('monthly', 'Monthly', false) === 'Monthly');

console.log('\n--- 2. Billing Frequency Subtitle (Guideline 3.1.2) ---');
check('annual billing description format (ar)',
  getIosBillingDescription('annual', '$9.99', true) === 'يُدفع سنوياً ($9.99 / سنة)');
check('semi_annual billing description format (ar)',
  getIosBillingDescription('semi_annual', '$7.99', true) === 'يُدفع كل 6 أشهر ($7.99 / 6 أشهر)');
check('seasonal billing description format (ar)',
  getIosBillingDescription('seasonal', '$4.99', true) === 'يُدفع كل 3 أشهر ($4.99 / 3 أشهر)');
check('monthly billing description format (ar)',
  getIosBillingDescription('monthly', '$1.99', true) === 'يُدفع شهرياً ($1.99 / شهر)');

check('annual billing description format (en)',
  getIosBillingDescription('annual', '$9.99', false) === 'Billed annually ($9.99 / year)');
check('semi_annual billing description format (en)',
  getIosBillingDescription('semi_annual', '$7.99', false) === 'Billed every 6 months ($7.99 / 6 months)');
check('seasonal billing description format (en)',
  getIosBillingDescription('seasonal', '$4.99', false) === 'Billed every 3 months ($4.99 / 3 months)');
check('monthly billing description format (en)',
  getIosBillingDescription('monthly', '$1.99', false) === 'Billed monthly ($1.99 / month)');

console.log('\n--- 3. Required Legal Strings & Auto-Renew Terms ---');
check('payTerms exists in ar and en',
  PAYMENT_STRINGS.ar.payTerms === 'شروط الاستخدام' && PAYMENT_STRINGS.en.payTerms === 'Terms of Use');
check('payPrivacy exists in ar and en',
  PAYMENT_STRINGS.ar.payPrivacy === 'سياسة الخصوصية' && PAYMENT_STRINGS.en.payPrivacy === 'Privacy Policy');
check('payAutoRenewNote exists in ar and en',
  Boolean(PAYMENT_STRINGS.ar.payAutoRenewNote) && Boolean(PAYMENT_STRINGS.en.payAutoRenewNote));
check('payBestValue exists in ar and en',
  PAYMENT_STRINGS.ar.payBestValue === 'الأكثر توفيراً' && PAYMENT_STRINGS.en.payBestValue === 'Best Value');

console.log('\n--- 4. SubscriptionScreen.ios.tsx Implementation Checks ---');
const screenSrc = read('src/ios/SubscriptionScreen.ios.tsx');
check('defines Apple Standard EULA URL',
  screenSrc.includes('TERMS_OF_USE_URL') && screenSrc.includes('stdeula'));
check('defines Privacy Policy URL',
  screenSrc.includes('PRIVACY_POLICY_URL') && screenSrc.includes('/privacy'));
check('renders Terms of Use and Privacy Policy separated by bullet',
  screenSrc.includes('{t.payTerms}') && screenSrc.includes('{t.payPrivacy}') && screenSrc.includes('•'));
check('renders Restore Purchases button with onRestore',
  screenSrc.includes('onRestore') && screenSrc.includes('t.payRestore'));
check('centers auto-renew disclaimer',
  screenSrc.includes('text-center') && screenSrc.includes('{t.payAutoRenewNote}'));
check('renders best value badge on annual plan',
  screenSrc.includes('isBestValue') && screenSrc.includes('payBestValue'));

console.log('\n--- 5. Android Isolation (Zero Android Modification) ---');
const androidPaywall = read('src/native-stubs/SubscriptionPaywall.tsx');
const androidScreen = read('src/native-stubs/SubscriptionScreen.tsx');
const androidPayments = read('src/native-stubs/payments.ts');
check('Android stubs do not import RevenueCat purchases',
  !androidPaywall.includes('@revenuecat') && !androidScreen.includes('@revenuecat'));
check('Android payments vocabulary remains empty stub',
  androidPayments.includes('export const PAYMENT_STRINGS = { ar: {}, en: {} };'));

if (failed > 0) {
  console.error(`\nFAILED: ${failed} check(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll iOS paywall compliance checks passed successfully!\n');
}
