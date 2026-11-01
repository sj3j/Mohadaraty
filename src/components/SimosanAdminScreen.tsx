import React, { useCallback, useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Check, CheckCircle2, Cpu, Loader2, Power, RefreshCw, Sparkles, X, Zap } from 'lucide-react';
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

export interface ModelPricingMeta {
  id: string;
  name: string;
  nameAr: string;
  uncachedInputUsdPer1M: number;
  cachedInputUsdPer1M: number;
  outputUsdPer1M: number;
  unitWeightUncachedInput: number;
  unitWeightCachedInput: number;
  unitWeightOutput: number;
  usdPerUnit: number;
  weeklyBudgetUnits: number;
  monthlyBudgetUnits: number;
  tagAr: string;
  tagEn: string;
}

const FALLBACK_MODELS: ModelPricingMeta[] = [
  {
    id: 'gemini-3.1-flash-lite',
    name: 'Gemini 3.1 Flash-Lite',
    nameAr: 'جيميني 3.1 فلاش لايت',
    uncachedInputUsdPer1M: 0.25,
    cachedInputUsdPer1M: 0.0625,
    outputUsdPer1M: 1.50,
    unitWeightUncachedInput: 1,
    unitWeightCachedInput: 0.25,
    unitWeightOutput: 6,
    usdPerUnit: 0.25 / 1_000_000,
    weeklyBudgetUnits: 800_000,
    monthlyBudgetUnits: 4_000_000,
    tagAr: 'النموذج الافتراضي الموصى به — استجابة فائقة السرعة وموفرة',
    tagEn: 'Recommended Default — Fast, cost-efficient, 6x output ratio',
  },
  {
    id: 'gemini-3.5-flash-lite',
    name: 'Gemini 3.5 Flash-Lite',
    nameAr: 'جيميني 3.5 فلاش لايت',
    uncachedInputUsdPer1M: 0.30,
    cachedInputUsdPer1M: 0.03,
    outputUsdPer1M: 2.50,
    unitWeightUncachedInput: 1,
    unitWeightCachedInput: 0.10,
    unitWeightOutput: 25 / 3,
    usdPerUnit: 0.30 / 1_000_000,
    weeklyBudgetUnits: 666_667,
    monthlyBudgetUnits: 3_333_333,
    tagAr: 'تكلفة كاش منخفضة للمحاضرات الطويلة ذات الأسئلة المتكررة',
    tagEn: 'Ultra-low cached input rate for long lectures with frequent follow-ups',
  },
];

interface Stats {
  month: string;
  monthUsd: number;
  ceilingUsd: number;
  enabled: boolean;
  model: string;
  supportedModels?: ModelPricingMeta[];
  weeklyUnitBudget?: number;
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
  const [syncQuotaOnSwitch, setSyncQuotaOnSwitch] = useState(true);

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
              <Tile label={isRtl ? 'حصة أسبوعية' : 'Weekly quota'} value={(stats.weeklyUnitBudget || stats.dailyUnitBudget).toLocaleString()} />
            </div>

            <section className="rounded-3xl bg-white dark:bg-zinc-900 border-2 border-slate-100 dark:border-zinc-800 p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-xl bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center text-violet-600 dark:text-violet-400">
                    <Cpu className="w-4 h-4" />
                  </div>
                  <h2 className="text-sm font-black text-slate-900 dark:text-stone-100">
                    {isRtl ? 'نموذج الذكاء الاصطناعي والأسعار التقديرية' : 'AI Model & Estimated Pricing'}
                  </h2>
                </div>
                <span className="text-[10px] font-black font-mono text-violet-600 dark:text-violet-400 bg-violet-50 dark:bg-violet-950/50 border border-violet-200 dark:border-violet-800/40 px-2.5 py-1 rounded-full">
                  {stats.model}
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                {(stats.supportedModels && stats.supportedModels.length > 0 ? stats.supportedModels : FALLBACK_MODELS).map((m) => {
                  const isSelected = stats.model === m.id;
                  return (
                    <div
                      key={m.id}
                      className={`relative rounded-2xl p-4 transition-all border-2 flex flex-col justify-between gap-3 ${isSelected
                          ? 'border-violet-500 bg-violet-50/50 dark:bg-violet-950/20 shadow-sm'
                          : 'border-slate-100 dark:border-zinc-800/80 bg-slate-50/50 dark:bg-zinc-900/50 hover:border-slate-200 dark:hover:border-zinc-700'
                        }`}
                    >
                      <div>
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <div>
                            <h3 className="text-xs font-black text-slate-900 dark:text-stone-100 flex items-center gap-1.5">
                              {isRtl ? m.nameAr : m.name}
                              {m.id === 'gemini-3.1-flash-lite' && (
                                <span className="text-[9px] font-black px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300">
                                  {isRtl ? 'الافتراضي' : 'Default'}
                                </span>
                              )}
                            </h3>
                            <p className="text-[10px] font-bold text-slate-400 font-mono mt-0.5">{m.id}</p>
                          </div>
                          {isSelected ? (
                            <span className="flex items-center gap-1 text-[10px] font-black text-violet-600 dark:text-violet-400 bg-violet-100 dark:bg-violet-900/40 px-2 py-0.5 rounded-full shrink-0">
                              <CheckCircle2 className="w-3 h-3" />
                              {isRtl ? 'المفعل' : 'Active'}
                            </span>
                          ) : null}
                        </div>

                        <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400 mt-2 mb-3 leading-snug">
                          {isRtl ? m.tagAr : m.tagEn}
                        </p>

                        <div className="rounded-xl bg-white dark:bg-zinc-950/60 p-2.5 border border-slate-100 dark:border-zinc-800 space-y-1.5 text-[11px]">
                          <div className="flex justify-between items-center text-slate-600 dark:text-slate-300">
                            <span className="text-slate-400 font-medium">{isRtl ? 'مدخلات جديدة:' : 'Uncached input:'}</span>
                            <span className="font-mono font-bold">${m.uncachedInputUsdPer1M.toFixed(2)} / 1M</span>
                          </div>
                          <div className="flex justify-between items-center text-slate-600 dark:text-slate-300">
                            <span className="text-slate-400 font-medium">{isRtl ? 'مدخلات كاش (مخزنة):' : 'Cached input:'}</span>
                            <span className="font-mono font-bold">${m.cachedInputUsdPer1M.toFixed(4)} / 1M</span>
                          </div>
                          <div className="flex justify-between items-center text-slate-600 dark:text-slate-300">
                            <span className="text-slate-400 font-medium">{isRtl ? 'مخرجات وتفكير:' : 'Output tokens:'}</span>
                            <span className="font-mono font-bold">${m.outputUsdPer1M.toFixed(2)} / 1M</span>
                          </div>
                          <div className="pt-1.5 mt-1 border-t border-slate-100 dark:border-zinc-800 flex justify-between items-center">
                            <span className="text-slate-500 dark:text-slate-400 font-bold">{isRtl ? 'حصة الأسبوع ($0.20):' : 'Weekly quota ($0.20):'}</span>
                            <span className="font-black text-violet-600 dark:text-violet-400 tabular-nums">
                              {m.weeklyBudgetUnits.toLocaleString()} {isRtl ? 'وحدة' : 'units'}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="pt-1">
                        {isSelected ? (
                          <div className="w-full py-2 rounded-xl text-center text-xs font-black text-violet-700 dark:text-violet-300 bg-violet-100/70 dark:bg-violet-900/30 flex items-center justify-center gap-1.5">
                            <Check className="w-3.5 h-3.5" />
                            {isRtl ? 'يعمل حالياً' : 'Currently Active'}
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => patch({ model: m.id, syncBudgetWithModel: syncQuotaOnSwitch })}
                            disabled={saving}
                            className="w-full py-2 px-3 rounded-xl text-xs font-black bg-slate-900 hover:bg-slate-800 dark:bg-stone-100 dark:hover:bg-white text-white dark:text-zinc-900 transition active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-1.5 shadow-sm"
                          >
                            <Zap className="w-3.5 h-3.5 text-amber-400" />
                            {isRtl ? `تفعيل ${m.nameAr}` : `Activate ${m.name}`}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <label className="flex items-center gap-2.5 pt-1 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={syncQuotaOnSwitch}
                  onChange={(e) => setSyncQuotaOnSwitch(e.target.checked)}
                  className="w-4 h-4 rounded text-violet-600 focus:ring-violet-500 border-slate-300 dark:border-zinc-700 bg-slate-100 dark:bg-zinc-800"
                />
                <span className="text-xs font-bold text-slate-600 dark:text-slate-300">
                  {isRtl
                    ? 'مزامنة الحصة الأسبوعية للطالب تلقائياً مع الحصة القياسية للنموذج عند التبديل'
                    : 'Auto-sync weekly student quota to model standard allowance on switch'}
                </span>
              </label>
            </section>

            <section className="rounded-3xl bg-white dark:bg-zinc-900 border-2 border-slate-100 dark:border-zinc-800 p-5 space-y-3">
              <h2 className="text-sm font-black text-slate-900 dark:text-stone-100">
                {isRtl ? 'التحكم' : 'Controls'}
              </h2>
              <button
                onClick={() => patch({ enabled: !stats.enabled })}
                disabled={saving}
                className={`w-full h-11 rounded-2xl text-sm font-black flex items-center justify-center gap-2 active:scale-[0.98] transition disabled:opacity-50 ${stats.enabled
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
                label={isRtl ? 'الحصة الأسبوعية للطالب' : 'Weekly quota per student'}
                value={stats.weeklyUnitBudget || stats.dailyUnitBudget}
                onSave={(v) => patch({ weeklyUnitBudget: v, dailyUnitBudget: v })}
                disabled={saving}
              />
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
