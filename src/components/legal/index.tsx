import React from 'react';
import PrivacyPolicy from './PrivacyPolicy';
import AccountDeletion from './AccountDeletion';
import TermsOfUse from './TermsOfUse';

/**
 * The pages Google Play must be able to open without an account.
 *
 * There is no router in this app - App.tsx switches on a `currentTab` state -
 * so these are matched on the pathname instead. vercel.json rewrites every
 * path to index.html, so /privacy and /delete-account already reach the SPA;
 * all that was missing was something to render for them BEFORE the auth gate.
 */
export function resolveLegalPath(pathname: string): React.ReactNode | null {
  const path = pathname.replace(/\/+$/, '').toLowerCase() || '/';

  if (path === '/privacy' || path === '/privacy-policy') return <PrivacyPolicy />;
  if (path === '/delete-account' || path === '/account-deletion') return <AccountDeletion />;
  if (path === '/terms' || path === '/terms-of-use') return <TermsOfUse />;
  return null;
}
