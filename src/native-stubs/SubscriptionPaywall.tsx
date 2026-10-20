import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Crown, Sparkles, X, ChevronLeft, ChevronRight,
  Languages, FileText, Target, Bot
} from 'lucide-react';
import { Language } from '../types';
import SubscriptionPerksModal from '../components/subscription/SubscriptionPerksModal';

/**
 * Native replacement for src/components/SubscriptionPaywall.tsx for Android (Google Play build).
 *
 * Compliant with Google Play Developer Policies:
 * - Highlights the VIP features and educational benefits of the subscription (translation support, attachments, MCQ bank, AI).
 * - Avoids any steering or mention of third-party / stage representative activation.
 * - Provides an interactive perks browser with zero external payment rails.
 */
export default function SubscriptionPaywall({
  lang,
  onClose,
}: {
  lang: Language;
  onClose: () => void;
  onSubscribe?: () => void;
}) {
  const isRtl = lang === 'ar';
  const [showPerksModal, setShowPerksModal] = useState(false);
  const ChevronIcon = isRtl ? ChevronLeft : ChevronRight;

  const quickPerks = [
    {
      icon: Languages,
      titleAr: 'ترجمة فورية للمحاضرات وPDF',
      titleEn: 'Instant Lecture & PDF Translation',
      iconColor: 'bg-cyan-500/15 text-cyan-600 dark:text-cyan-400',
    },
    {
      icon: FileText,
      titleAr: 'فتح كامل ملحقات المحاضرات',
      titleEn: 'Full Lecture Attachments Access',
      iconColor: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    },
    {
      icon: Target,
      titleAr: 'بنك الأسئلة والاختبارات التفاعلية',
      titleEn: 'Interactive MCQ Question Bank',
      iconColor: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
    },
    {
      icon: Bot,
      titleAr: 'المعلم الذكي سيموسان (AI)',
      titleEn: 'Simosan AI Smart Tutor',
      iconColor: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400',
    },
  ];

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[120] flex items-center justify-center p-4"
        dir={isRtl ? 'rtl' : 'ltr'}
        onClick={onClose}
      >
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

        <motion.div
          initial={{ opacity: 0, scale: 0.92, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 15 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          onClick={(e) => e.stopPropagation()}
          className="relative w-full max-w-sm sm:max-w-md max-h-[90vh] flex flex-col bg-white dark:bg-zinc-900 rounded-3xl shadow-2xl overflow-hidden border border-slate-100 dark:border-zinc-800"
        >
          {/* Header Banner */}
          <div className="relative shrink-0 px-6 pt-7 pb-6 bg-gradient-to-br from-amber-500 via-orange-500 to-rose-500 text-white overflow-hidden text-center">
            <div className="absolute -top-10 -right-10 w-36 h-36 bg-white/10 rounded-full" />
            <div className="absolute -bottom-8 -left-8 w-28 h-28 bg-white/10 rounded-full" />

            <button
              onClick={onClose}
              className="absolute top-3.5 left-3.5 rtl:left-auto rtl:right-3.5 p-2 rounded-full bg-white/20 hover:bg-white/30 transition-colors"
              aria-label={isRtl ? 'إغلاق' : 'Close'}
            >
              <X className="w-4 h-4" />
            </button>

            <motion.div
              animate={{ rotate: [0, 8, -8, 0] }}
              transition={{ repeat: Infinity, duration: 4, ease: 'easeInOut' }}
              className="inline-flex p-3 rounded-2xl bg-white/20 mb-2 shadow-inner"
            >
              <Crown className="w-7 h-7 text-white" />
            </motion.div>
            <h2 className="text-lg font-black leading-tight">
              {isRtl ? 'ميزة حصرية للمشتركين VIP' : 'VIP Exclusive Feature'}
            </h2>
            <p className="text-white/90 text-xs mt-1">
              {isRtl ? 'هذه الميزة متاحة ضمن باقة اشتراك محاضراتي المميز' : 'This feature is part of the Mohadaraty VIP Membership'}
            </p>
          </div>

          {/* Features Showcase Body */}
          <div className="p-5 space-y-3 flex-1 overflow-y-auto">
            <div className="space-y-2">
              {quickPerks.map((perk, i) => {
                const IconComponent = perk.icon;
                return (
                  <div
                    key={i}
                    className="flex items-center gap-3 p-2.5 rounded-2xl bg-slate-50 dark:bg-zinc-800/60 border border-slate-100 dark:border-zinc-800"
                  >
                    <div className={`p-2 rounded-xl shrink-0 ${perk.iconColor}`}>
                      <IconComponent className="w-4 h-4" />
                    </div>
                    <span className="text-xs font-bold text-slate-800 dark:text-slate-200">
                      {isRtl ? perk.titleAr : perk.titleEn}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* View Full Perks Button */}
            <button
              type="button"
              onClick={() => setShowPerksModal(true)}
              className="w-full flex items-center justify-between p-3 rounded-2xl bg-gradient-to-r from-amber-500/10 via-orange-500/10 to-amber-500/5 dark:from-amber-400/15 dark:via-orange-400/10 dark:to-transparent border border-amber-400/30 text-amber-950 dark:text-amber-200 hover:border-amber-500/50 hover:bg-amber-500/15 transition-all text-start"
            >
              <div className="flex items-center gap-2.5">
                <Sparkles className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
                <span className="text-xs font-black text-slate-900 dark:text-white">
                  {isRtl ? 'استعراض كامل ميزات الاشتراك (8 ميزات)' : 'Explore all subscription perks (8 features)'}
                </span>
              </div>
              <ChevronIcon className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
            </button>

            {/* Close / Action Button */}
            <button
              onClick={onClose}
              className="w-full mt-2 rounded-2xl px-5 py-3 text-xs font-black bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500 hover:from-amber-600 hover:via-orange-600 hover:to-rose-600 text-white shadow-md shadow-orange-500/20 active:scale-[0.99] transition-all"
            >
              {isRtl ? 'فهمت ذلك' : 'Got it'}
            </button>
          </div>
        </motion.div>

        {/* Perks Modal */}
        <SubscriptionPerksModal
          isOpen={showPerksModal}
          onClose={() => setShowPerksModal(false)}
          lang={lang}
        />
      </motion.div>
    </AnimatePresence>
  );
}
