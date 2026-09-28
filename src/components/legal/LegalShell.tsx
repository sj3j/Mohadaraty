import React, { useState } from 'react';
import { GraduationCap, Languages } from 'lucide-react';

/**
 * Chrome for the public legal pages.
 *
 * These render BEFORE the auth gate in App.tsx: Google Play requires the
 * privacy policy and the account-deletion instructions to be reachable at a
 * plain URL by a reviewer who has no account, and an app that answers those
 * URLs with a login screen fails review.
 *
 * Deliberately self-contained - its own language toggle, no contexts, no app
 * state - so it renders correctly with nothing else initialised.
 */

export type LegalLang = 'ar' | 'en';

export function LegalShell({
  lang, setLang, title, updated, children,
}: {
  lang: LegalLang;
  setLang: (l: LegalLang) => void;
  title: string;
  updated: string;
  children: React.ReactNode;
}) {
  const isRtl = lang === 'ar';

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-zinc-950" dir={isRtl ? 'rtl' : 'ltr'}>
      <header className="bg-sky-600 text-white">
        <div className="max-w-3xl mx-auto px-5 py-5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <GraduationCap className="w-6 h-6 shrink-0" />
            <span className="font-black text-lg truncate">
              {isRtl ? 'محاضراتي' : 'MyLecture'}
            </span>
          </div>
          <button
            onClick={() => setLang(isRtl ? 'en' : 'ar')}
            className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 text-sm font-bold transition-colors"
          >
            <Languages className="w-4 h-4" />
            {isRtl ? 'English' : 'العربية'}
          </button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-5 py-8">
        <h1 className="text-2xl sm:text-3xl font-black text-slate-900 dark:text-stone-100 mb-1">
          {title}
        </h1>
        <p className="text-xs font-bold text-slate-400 mb-8">{updated}</p>

        <div className="space-y-7 text-slate-700 dark:text-slate-300 leading-relaxed">
          {children}
        </div>

        <footer className="mt-12 pt-6 border-t border-slate-200 dark:border-zinc-800 text-xs font-bold text-slate-400 space-y-1.5">
          <p>{isRtl ? 'محاضراتي — المنصة الطلابية للمحاضرات الجامعية' : 'MyLecture — University Student Platform'}</p>
          <p dir="ltr">
            <a href="mailto:support@myvarmacy.com" className="text-sky-600 dark:text-sky-400 hover:underline">
              support@myvarmacy.com
            </a>
          </p>
          <p className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
            <a href="/privacy" className="text-sky-600 dark:text-sky-400 hover:underline">
              {isRtl ? 'سياسة الخصوصية' : 'Privacy policy'}
            </a>
            <a href="/terms" className="text-sky-600 dark:text-sky-400 hover:underline">
              {isRtl ? 'شروط الاستخدام' : 'Terms of use'}
            </a>
            <a href="/delete-account" className="text-sky-600 dark:text-sky-400 hover:underline">
              {isRtl ? 'حذف الحساب' : 'Delete account'}
            </a>
            <a href="/support" className="text-sky-600 dark:text-sky-400 hover:underline">
              {isRtl ? 'مركز الدعم' : 'Support'}
            </a>
          </p>
        </footer>
      </main>
    </div>
  );
}

/** A titled block. Keeps the two pages visually identical without a framework. */
export function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-base font-black text-slate-900 dark:text-stone-100 mb-2">{heading}</h2>
      <div className="space-y-2 text-[15px]">{children}</div>
    </section>
  );
}

export function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1.5 ps-5 list-disc marker:text-slate-300">
      {items.map((item, i) => <li key={i} className="text-[15px]">{item}</li>)}
    </ul>
  );
}

/** Shared language state so both pages open in Arabic and remember a switch. */
export function useLegalLang(): [LegalLang, (l: LegalLang) => void] {
  const [lang, setLang] = useState<LegalLang>(() => {
    try {
      const stored = localStorage.getItem('lang');
      if (stored === 'en' || stored === 'ar') return stored;
    } catch {
      // Private mode. Arabic is the right default for this audience anyway.
    }
    return 'ar';
  });

  return [lang, (l: LegalLang) => {
    setLang(l);
    try { localStorage.setItem('lang', l); } catch { /* not worth failing over */ }
  }];
}
