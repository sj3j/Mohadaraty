import React, { useState } from 'react';
import { motion } from 'motion/react';
import {
  Crown, Sparkles, CheckCircle2, Clock,
  ShieldCheck, ChevronRight, ChevronLeft
} from 'lucide-react';
import { Language, TRANSLATIONS, UserProfile } from '../types';
import { hasSubscriptionAccess } from '../../shared/subscriptionAccess';
import SubscriptionPerksModal, { PERKS } from '../components/subscription/SubscriptionPerksModal';

/**
 * Native replacement for src/components/SubscriptionScreen.tsx for Android (Google Play build).
 *
 * Compliant with Google Play Developer Policies:
 * - Highlights all VIP features (translation support, attachments, MCQ bank, AI, discounts, themes).
 * - Avoids any steering, external payment links, or mentions of third-party / stage representative activation.
 * - Displays truthful account tier status and educational benefits.
 */
export default function SubscriptionScreen({ user, lang }: { user: UserProfile | null; lang: Language }) {
  const t = TRANSLATIONS[lang];
  const isRtl = lang === 'ar';
  const [showPerksModal, setShowPerksModal] = useState(false);
  const ChevronIcon = isRtl ? ChevronLeft : ChevronRight;

  const active = hasSubscriptionAccess(user);

  const until = (() => {
    const raw = user?.subscriptionEnd;
    if (!active || !raw) return null;
    try {
      const d = raw?.toDate ? raw.toDate() : new Date(raw);
      if (Number.isNaN(d.getTime())) return null;
      return d.toLocaleDateString(isRtl ? 'ar-IQ' : 'en-GB', {
        year: 'numeric', month: 'long', day: 'numeric',
      });
    } catch {
      return null;
    }
  })();

  return (
    <div className="max-w-5xl w-full mx-auto px-4 sm:px-6 lg:px-8 pt-4 pb-16" dir={isRtl ? 'rtl' : 'ltr'}>
      {/* Top Header Bar */}
      <div className="flex items-center justify-between mb-5 pb-3 border-b border-slate-100 dark:border-zinc-800">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-amber-500 to-yellow-400 flex items-center justify-center text-white shadow-md shadow-amber-500/20 ring-2 ring-amber-300/40">
            <Crown className="w-5 h-5 drop-shadow-xs" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base sm:text-lg font-black text-slate-900 dark:text-white leading-tight">
                {isRtl ? 'الاشتراك المميز VIP' : 'VIP Membership'}
              </h1>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30">
                <Sparkles className="w-2.5 h-2.5" />
                VIP
              </span>
            </div>
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400 mt-0.5">
              {isRtl ? 'تفوق بلا حدود وميزات تعليمية متكاملة' : 'Unlimited learning & full academic potential'}
            </p>
          </div>
        </div>

        {/* Circular Perks Button */}
        <button
          type="button"
          onClick={() => setShowPerksModal(true)}
          title={isRtl ? 'استعراض كامل ميزات الاشتراك' : 'View all subscription perks'}
          aria-label={isRtl ? 'استعراض كامل ميزات الاشتراك' : 'View all subscription perks'}
          className="relative group w-10 h-10 rounded-full flex items-center justify-center bg-gradient-to-tr from-amber-500 via-yellow-400 to-amber-600 text-white shadow-md shadow-amber-500/30 hover:shadow-lg hover:shadow-amber-500/40 hover:scale-105 active:scale-95 transition-all ring-2 ring-amber-300/50 dark:ring-amber-400/40 shrink-0"
        >
          <Crown className="w-5 h-5 drop-shadow-xs" />
          <span className="absolute -top-0.5 -end-0.5 w-3 h-3 bg-red-500 rounded-full border-2 border-white dark:border-zinc-900 animate-pulse" />
        </button>
      </div>

      {/* Account Status Card */}
      {active ? (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative overflow-hidden mb-6 p-5 rounded-3xl bg-gradient-to-br from-amber-500 via-orange-500 to-rose-500 text-white shadow-xl shadow-orange-500/20 border-2 border-amber-300/40"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3.5">
              <div className="w-12 h-12 rounded-2xl bg-white/20 flex items-center justify-center text-white backdrop-blur-sm">
                <Crown className="w-6 h-6" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-black text-lg leading-snug">{t.accessActive}</h3>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-white/25 text-white">
                    <CheckCircle2 className="w-3 h-3" />
                    VIP
                  </span>
                </div>
                {until && (
                  <p className="text-xs font-medium text-white/90 mt-0.5 flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 opacity-80" />
                    <span>{t.expiresOn}: {until}</span>
                  </p>
                )}
              </div>
            </div>
          </div>
        </motion.div>
      ) : (
        <div className="mb-6 p-4 sm:p-5 rounded-3xl bg-slate-50 dark:bg-zinc-800/60 border border-slate-200 dark:border-zinc-700/80 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="w-11 h-11 rounded-2xl bg-slate-200 dark:bg-zinc-700 flex items-center justify-center text-slate-500 dark:text-slate-400 shrink-0">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-slate-900 dark:text-white">
                {isRtl ? 'الحساب الأساسي (المجاني)' : 'Basic Free Academic Tier'}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                {isRtl
                  ? 'استكشف الميزات المتقدمة المتاحة مع عضوية محاضراتي VIP أدناه.'
                  : 'Explore all the advanced features available with Mohadaraty VIP below.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowPerksModal(true)}
            className="px-3.5 py-2 rounded-xl text-xs font-bold text-amber-700 dark:text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 transition-all shrink-0 active:scale-95"
          >
            {isRtl ? 'استعراض' : 'Explore'}
          </button>
        </div>
      )}

      {/* VIP Features Showcase Grid */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-3.5 px-1">
          <div>
            <h2 className="text-sm sm:text-base font-black text-slate-900 dark:text-white">
              {isRtl ? 'ميزات وامتيازات العضوية' : 'Membership Perks & Features'}
            </h2>
            <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
              {isRtl ? 'تشمل جميع الأدوات المصممة لتسهيل دراستك الجامعية' : 'All tools tailored to power your academic journey'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowPerksModal(true)}
            className="text-xs font-bold text-amber-600 dark:text-amber-400 hover:underline flex items-center gap-1"
          >
            <span>{isRtl ? 'التفاصيل كاملة' : 'All Details'}</span>
            <ChevronIcon className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {PERKS.map((perk) => {
            const IconComponent = perk.icon;
            return (
              <motion.div
                key={perk.id}
                whileHover={{ y: -2 }}
                onClick={() => setShowPerksModal(true)}
                className={`cursor-pointer p-4 rounded-2xl border transition-all duration-200 bg-gradient-to-r ${perk.gradient} ${perk.borderGlow} flex flex-col justify-between`}
              >
                <div>
                  <div className="flex items-center justify-between gap-2 mb-2.5">
                    <div className={`p-2.5 rounded-xl ${perk.iconColor}`}>
                      <IconComponent className="w-4.5 h-4.5" />
                    </div>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-white/80 dark:bg-zinc-800/80 text-slate-600 dark:text-slate-300 border border-slate-200/60 dark:border-zinc-700/60">
                      {isRtl ? perk.badgeAr : perk.badgeEn}
                    </span>
                  </div>
                  <h3 className="font-bold text-xs sm:text-sm text-slate-900 dark:text-white mb-1 leading-snug">
                    {isRtl ? perk.titleAr : perk.titleEn}
                  </h3>
                  <p className="text-[11px] leading-relaxed text-slate-600 dark:text-slate-300 line-clamp-2">
                    {isRtl ? perk.descAr : perk.descEn}
                  </p>
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>

      {/* Bottom Guarantee Badge */}
      <div className="p-4 rounded-2xl bg-amber-50/70 dark:bg-amber-950/20 border border-amber-200/60 dark:border-amber-800/40 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <ShieldCheck className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0" />
          <p className="text-xs font-semibold text-amber-800 dark:text-amber-300 leading-snug">
            {isRtl
              ? 'تتيح العضوية الوصول الكامل إلى جميع الأدوات والميزات الحالية والمستقبلية بلا انقطاع.'
              : 'VIP Membership grants full access to all current and upcoming academic tools.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowPerksModal(true)}
          className="px-3.5 py-1.5 rounded-xl text-xs font-bold bg-gradient-to-r from-amber-500 to-yellow-500 text-white shadow-xs hover:from-amber-600 hover:to-yellow-600 transition-all shrink-0 active:scale-95"
        >
          {isRtl ? 'عرض الميزات' : 'View Perks'}
        </button>
      </div>

      {/* Perks Modal */}
      <SubscriptionPerksModal
        isOpen={showPerksModal}
        onClose={() => setShowPerksModal(false)}
        lang={lang}
      />
    </div>
  );
}
