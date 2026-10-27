import React, { useState } from 'react';
import { Download, RefreshCw, Smartphone } from 'lucide-react';
import { useBackDismiss } from '../hooks/useBackDismiss';
import type { Language } from '../types';
import type { MobileReleaseGate } from '../hooks/useMobileReleaseGate';

export default function ForceUpdateScreen({ gate, lang }: { gate: MobileReleaseGate; lang: Language }) {
  const isRtl = lang === 'ar';
  const [opening, setOpening] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);

  // Keep this layer at the top of the shared Android back stack. Its dismiss
  // callback deliberately does nothing, making the gate non-dismissible.
  useBackDismiss(true, () => undefined, 'force-update');

  const openStore = async () => {
    setOpening(true);
    setOpenFailed(false);
    try {
      const { Browser } = await import('@capacitor/browser');
      await Browser.open({ url: gate.storeUrl });
    } catch (error) {
      console.warn('[mobile-release] could not open store', error);
      setOpenFailed(true);
    } finally {
      setOpening(false);
    }
  };

  return (
    <main
      dir={isRtl ? 'rtl' : 'ltr'}
      className="fixed inset-0 z-[1000] flex min-h-screen items-center justify-center bg-slate-50 px-5 py-[max(1.25rem,env(safe-area-inset-top))] dark:bg-zinc-950"
    >
      <section className="w-full max-w-md rounded-3xl border-2 border-slate-100 bg-white p-6 text-center shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto mb-5 flex h-20 w-20 items-center justify-center rounded-3xl bg-sky-100 text-sky-600 dark:bg-sky-900/30 dark:text-sky-400">
          <Smartphone className="h-10 w-10" strokeWidth={2.2} />
        </div>
        <h1 className="text-2xl font-black text-slate-900 dark:text-white">
          {isRtl ? 'يجب تحديث التطبيق' : 'App update required'}
        </h1>
        <p className="mt-3 text-sm font-semibold leading-7 text-slate-500 dark:text-zinc-400">
          {isRtl
            ? 'يتوفر إصدار جديد ومهم من محاضراتي. حدّث التطبيق للمتابعة والوصول إلى محاضراتك.'
            : 'A new important version of Mohadaraty is available. Update the app to continue to your lectures.'}
        </p>

        <div className="mt-5 rounded-2xl bg-slate-50 px-4 py-3 text-xs font-bold text-slate-500 dark:bg-zinc-800 dark:text-zinc-400">
          {isRtl
            ? `الإصدار المثبت: ${gate.installedBuild ?? '—'} · الحد الأدنى: ${gate.minBuild ?? '—'}`
            : `Installed build: ${gate.installedBuild ?? '—'} · Minimum build: ${gate.minBuild ?? '—'}`}
        </div>

        {openFailed && (
          <p role="alert" className="mt-4 text-sm font-bold text-rose-600 dark:text-rose-400">
            {isRtl ? 'تعذر فتح المتجر. تحقق من اتصالك ثم حاول مرة أخرى.' : 'Could not open the store. Check your connection and try again.'}
          </p>
        )}

        <div className="mt-6 grid gap-3">
          <button
            type="button"
            onClick={() => void openStore()}
            disabled={opening}
            className="flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-sky-600 px-5 py-3 font-black text-white transition-colors hover:bg-sky-700 disabled:opacity-60"
          >
            <Download className="h-5 w-5" />
            {opening ? (isRtl ? 'جاري فتح المتجر…' : 'Opening store…') : (isRtl ? 'تحديث الآن' : 'Update now')}
          </button>
          <button
            type="button"
            onClick={gate.retry}
            className="flex min-h-12 items-center justify-center gap-2 rounded-2xl border-2 border-slate-200 px-5 py-3 font-black text-slate-700 transition-colors hover:bg-slate-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <RefreshCw className="h-5 w-5" />
            {isRtl ? 'تحقق مرة أخرى' : 'Check again'}
          </button>
        </div>
      </section>
    </main>
  );
}
