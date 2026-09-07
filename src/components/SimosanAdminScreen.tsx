import React, { useCallback, useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Loader2, Power, RefreshCw, Sparkles, X } from 'lucide-react';
import { auth } from '../lib/firebase';
import { apiUrl } from '../lib/apiBase';
import type { Language } from '../types';

/**
 * Simosan spend dashboard.
 *
 * WEB ONLY. vite.config.ts aliases this module to a stub for mode === 'native',
 * the same treatment SubscriptionScreen gets and for the same reason: this file
 * renders currency, and scripts/assert-no-payment-surface.mjs scans the built
 * Android artefact for exactly that. Admin-only React still ships inside the
 * bundle, so hiding it at runtime would not be enough.
 *
 * Never import this from a module that the native build also pulls in without
 * going through the alias - see the note in vite.config.ts.
 */

interface Stats {
  month: string;
  monthUsd: number;
  ceilingUsd: number;
  enabled: boolean;
  model: string;
  dailyUnitBudget: number;
  todayUnits: number;
  todayUsd: number;
  activeUsersToday: number;
  top: Array<{ uid: string; stageId: string; unitsUsed: number; requestCount: number; usd: number }>;
}

export default function SimosanAdminScreen({
  isOpen, onClose, lang,
}: { isOpen: boolean; onClose: () => void; lang: Language }) {
  const isRtl = lang === 'ar';
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error('No auth token');
      const res = await fetch(apiUrl('/api/ai/admin/stats'), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed');
      setStats(await res.json());
    } catch (e: any) {
      setError(e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (isOpen) load(); }, [isOpen, load]);

  const patch = useCallback(async (body: any) => {
    setSaving(true);
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error('No auth token');
      const res = await fetch(apiUrl('/api/ai/admin/settings'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed');
      await load();
    } catch (e: any) {
      setError(e.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [load]);

  if (!isOpen) return null;

  const pct = stats && stats.ceilingUsd > 0
    ? Math.min(100, Math.round((stats.monthUsd / stats.ceilingUsd) * 100))
    : 0;

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      dir={isRtl ? 'rtl' : 'ltr'}
      className="fixed inset-0 z-[200] bg-slate-50 dark:bg-zinc-950 overflow-y-auto"
    >
      <header className="sticky top-[env(safe-area-inset-top)] z-10 bg-white/90 dark:bg-zinc-900/90 backdrop-blur border-b border-slate-100 dark:border-zinc-800 px-4 py-3 flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-violet-500 to-sky-500 flex items-center justify-center">
          <Sparkles className="w-4.5 h-4.5 text-white" strokeWidth={2.5} />
        </div>
        <h1 className="flex-1 text-base font-black text-slate-900 dark:text-stone-100">
          {isRtl ? 'استخدام سيموسان' : 'Simosan usage'}
        </h1>
        <button onClick={load} aria-label="Refresh" className="p-2 rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800">
          <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
        </button>
        <button onClick={onClose} aria-label="Close" className="p-2 rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800">
          <X className="w-5 h-5" />
        </button>
      </header>

      <div className="p-4 max-w-2xl mx-auto space-y-4 pb-12">
        {error && (
          <div className="rounded-2xl bg-red-50 dark:bg-red-950/30 p-3 text-xs font-bold text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {!stats && loading && (
          <div className="py-16 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
        )}

        {stats && (
          <>
            <section className="rounded-3xl bg-white dark:bg-zinc-900 border-2 border-slate-100 dark:border-zinc-800 p-5">
              <div className="flex items-baseline justify-between mb-2">
                <span className="text-xs font-black text-slate-500 dark:text-slate-400">
                  {isRtl ? `إنفاق ${stats.month}` : `${stats.month} spend`}
                </span>
                <span className="text-2xl font-black text-slate-900 dark:text-stone-100">
                  ${stats.monthUsd.toFixed(2)}
                  <span className="text-sm text-slate-400"> / ${stats.ceilingUsd}</span>
                </span>
              </div>
              <div className="h-2 rounded-full bg-slate-100 dark:bg-zinc-800 overflow-hidden">
                <div
                  className={`h-full rounded-full ${pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-gradient-to-r from-violet-500 to-sky-500'}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              {!stats.enabled && (
                <p className="mt-3 text-xs font-bold text-red-600 dark:text-red-400">
                  {isRtl
                    ? 'سيموسان متوقف. لن يتمكن أي طالب من طرح سؤال.'
                    : 'Simosan is off. No student can ask anything.'}
                </p>
              )}
            </section>

            <div className="grid grid-cols-3 gap-3">
              <Tile label={isRtl ? 'اليوم' : 'Today'} value={`$${stats.todayUsd.toFixed(3)}`} />
              <Tile label={isRtl ? 'طلاب اليوم' : 'Users today'} value={String(stats.activeUsersToday)} />
              <Tile label={isRtl ? 'حصة يومية' : 'Daily quota'} value={stats.dailyUnitBudget.toLocaleString()} />
            </div>

            <section className="rounded-3xl bg-white dark:bg-zinc-900 border-2 border-slate-100 dark:border-zinc-800 p-5 space-y-3">
              <h2 className="text-sm font-black text-slate-900 dark:text-stone-100">
                {isRtl ? 'التحكم' : 'Controls'}
              </h2>
              <button
                onClick={() => patch({ enabled: !stats.enabled })}
                disabled={saving}
                className={`w-full h-11 rounded-2xl text-sm font-black flex items-center justify-center gap-2 active:scale-[0.98] transition disabled:opacity-50 ${
                  stats.enabled
                    ? 'bg-red-500 text-white'
                    : 'bg-emerald-500 text-white'
                }`}
              >
                <Power className="w-4 h-4" />
                {stats.enabled
                  ? (isRtl ? 'إيقاف سيموسان' : 'Turn Simosan off')
                  : (isRtl ? 'تشغيل سيموسان' : 'Turn Simosan on')}
              </button>
              <NumberRow
                label={isRtl ? 'سقف الشهر ($)' : 'Monthly ceiling ($)'}
                value={stats.ceilingUsd}
                onSave={(v) => patch({ monthlyCeilingUsd: v })}
                disabled={saving}
              />
              <NumberRow
                label={isRtl ? 'الحصة اليومية للطالب' : 'Daily quota per student'}
                value={stats.dailyUnitBudget}
                onSave={(v) => patch({ dailyUnitBudget: v })}
                disabled={saving}
              />
              <p className="text-[11px] font-bold text-slate-400 leading-relaxed">
                {isRtl
                  ? `النموذج الحالي: ${stats.model}`
                  : `Current model: ${stats.model}`}
              </p>
            </section>

            <section className="rounded-3xl bg-white dark:bg-zinc-900 border-2 border-slate-100 dark:border-zinc-800 p-5">
              <h2 className="text-sm font-black text-slate-900 dark:text-stone-100 mb-3">
                {isRtl ? 'الأكثر استخداماً اليوم' : 'Top usage today'}
              </h2>
              {stats.top.length === 0 ? (
                <p className="text-xs font-bold text-slate-400">{isRtl ? 'لا يوجد استخدام اليوم.' : 'No usage today.'}</p>
              ) : (
                <ul className="space-y-2">
                  {stats.top.map((r) => (
                    <li key={r.uid} className="flex items-center gap-3 text-xs font-bold">
                      <span className="flex-1 truncate text-slate-600 dark:text-slate-300 font-mono text-[11px]">{r.uid}</span>
                      <span className="text-slate-400">{r.requestCount}×</span>
                      <span className="text-slate-900 dark:text-stone-100 tabular-nums">${r.usd.toFixed(4)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </motion.div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-white dark:bg-zinc-900 border-2 border-slate-100 dark:border-zinc-800 p-3 text-center">
      <div className="text-base font-black text-slate-900 dark:text-stone-100 tabular-nums">{value}</div>
      <div className="text-[10px] font-bold text-slate-400 mt-0.5">{label}</div>
    </div>
  );
}

function NumberRow({
  label, value, onSave, disabled,
}: { label: string; value: number; onSave: (v: number) => void; disabled: boolean }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const dirty = draft !== String(value) && Number(draft) > 0;

  return (
    <div className="flex items-center gap-2">
      <label className="flex-1 text-xs font-bold text-slate-500 dark:text-slate-400">{label}</label>
      <input
        type="number"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="w-28 h-9 rounded-xl bg-slate-100 dark:bg-zinc-800 px-3 text-sm font-black text-slate-800 dark:text-stone-100 outline-none focus:ring-2 focus:ring-violet-400 tabular-nums"
      />
      <button
        onClick={() => onSave(Number(draft))}
        disabled={!dirty || disabled}
        className="h-9 px-3 rounded-xl bg-slate-900 dark:bg-stone-100 text-white dark:text-zinc-900 text-xs font-black disabled:opacity-30 active:scale-95 transition"
      >
        ✓
      </button>
    </div>
  );
}
