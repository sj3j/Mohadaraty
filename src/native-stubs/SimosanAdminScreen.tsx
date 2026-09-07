import React from 'react';
import type { Language } from '../types';

/**
 * Native replacement for src/components/SimosanAdminScreen.tsx.
 *
 * The real screen reports Simosan's spend against a monthly ceiling, in
 * dollars. Admin-only React still ships inside the Android artefact, and
 * scripts/assert-no-payment-surface.mjs scans that artefact for currency —
 * so the screen is excluded at BUILD time here rather than hidden behind
 * IS_STORE_BUILD, which is exactly the mistake SubscriptionScreen documents:
 * a runtime guard left every price string in the bundle.
 *
 * Nothing is lost operationally. Admins manage the budget from the web app,
 * where subscription management already lives, and the kill switch is a
 * Firestore document (app_settings/simosan) that also fires FCM alerts at
 * 50/80/100% of the ceiling.
 *
 * Rendering null rather than an explanatory panel is deliberate: this screen
 * has no student-facing purpose, so there is no one on a phone who needs to be
 * told why it is absent.
 */
export default function SimosanAdminScreen(_props: {
  isOpen: boolean;
  onClose: () => void;
  lang: Language;
}) {
  return null;
}
