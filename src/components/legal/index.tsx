import React from 'react';
import PrivacyPolicy from './PrivacyPolicy';
import AccountDeletion from './AccountDeletion';
import TermsOfUse from './TermsOfUse';
import SupportPage from '../../pages/SupportPage';

/**
 * The pages Google Play and Apple App Store must be able to open without an account.
 *
 * There is no router in this app - App.tsx switches on a `currentTab` state -
 * so these are matched on the pathname instead. vercel.json rewrites every
 * path to index.html, so /privacy, /delete-account, /terms, and /support
 * reach the SPA cleanly; all that was missing was something to render for
 * them BEFORE the auth gate.
 */
export function resolveLegalPath(pathname: string): React.ReactNode | null {
  const path = pathname.replace(/\/+$/, '').toLowerCase() || '/';

  if (path === '/privacy' || path === '/privacy-policy') return <PrivacyPolicy />;
  if (path === '/delete-account' || path === '/account-deletion') return <AccountDeletion />;
  if (path === '/terms' || path === '/terms-of-use') return <TermsOfUse />;
  if (path === '/support' || path === '/support-center' || path === '/help') return <SupportPage />;
  return null;
}

