/**
 * Renders the real iOS paywall for a screenshot.
 *
 * App Store Connect requires a "Review Information" screenshot per
 * auto-renewable subscription, showing where the purchase appears in the app.
 * Building an .ipa to take one needs a Mac; this does not, and - more
 * importantly - it renders src/ios/SubscriptionScreen.ios.tsx itself, so the
 * screenshot cannot drift from what actually ships. Only the store boundary is
 * mocked (scripts/paywallPreview/iapMock.ts).
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import SubscriptionScreen from '../../src/ios/SubscriptionScreen.ios';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : 'ar';
document.documentElement.setAttribute('data-preview-lang', lang);
document.documentElement.setAttribute('lang', lang);
document.documentElement.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark');

// A student, mid-term, with no live subscription - which is the state the
// paywall is FOR, and the one a reviewer needs to see.
const user: any = {
  uid: 'preview',
  name: 'Preview',
  email: 'preview@example.com',
  role: 'student',
  isSubscribed: false,
  subscriptionEnd: undefined,
  subscriptionPlan: undefined,
};

createRoot(document.getElementById('root')!).render(
  <div className="min-h-screen bg-slate-50 dark:bg-black py-6">
    <SubscriptionScreen user={user} lang={lang as any} />
  </div>,
);
