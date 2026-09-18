import React from 'react';
import { Sparkles } from 'lucide-react';
import { Language } from '../types';

/**
 * Placeholder for the tab the group chat used to occupy.
 *
 * The chat is gone; this slot is reserved for Simosan, which today only exists
 * as a drawer inside the PDF reader (shared/simosanChat.ts, SimosanDrawer.tsx).
 * Deliberately inert: no Firestore listener, no state, no props beyond the
 * language, so nothing here can fail offline or cost a read.
 *
 * It is an ORDINARY screen, not the full-bleed layout the chat used. App.tsx's
 * root supplies the only bottom clearance in the app (pb-[104px], the floating
 * nav's real footprint) and the chat tab used to opt out of it; this one must
 * not, or the card parks under the nav.
 */
export default function SimosanSoonScreen({ lang }: { lang: Language }) {
  const isRtl = lang === 'ar';

  return (
    <div
      className="max-w-2xl w-full mx-auto px-4 pt-10 flex flex-col items-center justify-center min-h-[60vh] text-center"
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      <div className="relative mb-7">
        <div className="absolute inset-0 bg-sky-400/25 blur-2xl rounded-full" aria-hidden />
        {/* The transparent mark, never /icons/icon-*.png - those bake in the
            white launcher plate and read as a white box inside a tinted tile. */}
        <div className="relative w-24 h-24 rounded-3xl bg-sky-50 dark:bg-sky-900/30 border border-sky-100 dark:border-sky-800/40 flex items-center justify-center">
          <img src="/icons/logo-mark.png" alt="" className="w-14 h-14 object-contain" />
        </div>
      </div>

      <div className="inline-flex items-center gap-1.5 px-3 py-1 mb-4 rounded-full bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300 text-xs font-bold">
        <Sparkles className="w-3.5 h-3.5" />
        {isRtl ? 'قريباً' : 'Coming soon'}
      </div>

      {/* Latin inside an RTL block needs its own dir, or bidi reorders it. */}
      <h1 className="text-2xl sm:text-3xl font-black text-slate-900 dark:text-stone-100 mb-3" dir="ltr">
        Simosan Service Soon...
      </h1>

      <p className="text-sm sm:text-base text-slate-500 dark:text-slate-400 max-w-sm leading-relaxed">
        {isRtl
          ? 'هذه الصفحة قيد التحضير. سيموسان سيصل إلى هنا قريباً.'
          : 'This page is being prepared. Simosan is on its way here.'}
      </p>
    </div>
  );
}
