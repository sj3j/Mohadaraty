import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  X, Crown, Sparkles, FileText, Target, Bot,
  Palette, Zap, CheckCircle2, Star, ShieldCheck
} from 'lucide-react';
import { Language } from '../../types';

interface SubscriptionPerksModalProps {
  isOpen: boolean;
  onClose: () => void;
  lang: Language;
}

interface PerkItem {
  id: string;
  icon: React.ElementType;
  badgeAr: string;
  badgeEn: string;
  titleAr: string;
  titleEn: string;
  descAr: string;
  descEn: string;
  gradient: string;
  borderGlow: string;
  iconColor: string;
}

const PERKS: PerkItem[] = [
  {
    id: 'attachments',
    icon: FileText,
    badgeAr: 'حصري للمشتركين',
    badgeEn: 'VIP Exclusive',
    titleAr: 'فتح كامل ملحقات المحاضرات',
    titleEn: 'Unlock All Lecture Attachments',
    descAr: 'إزالة التعتيم فورياً والوصول الكامل لجميع المرفقات، المخططات، الرسوم التوضيحية، والملخصات المرفقة مع كل محاضرة بأعلى جودة.',
    descEn: 'Instant blur removal and full unrestricted access to all lecture diagrams, high-resolution attachments, and study notes.',
    gradient: 'from-amber-500/10 via-yellow-500/5 to-transparent',
    borderGlow: 'border-amber-500/30 dark:border-amber-400/20',
    iconColor: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  },
  {
    id: 'mcq_bank',
    icon: Target,
    badgeAr: 'تدريب غير محدود',
    badgeEn: 'Unlimited Practice',
    titleAr: 'بنك الأسئلة والاختبارات التفاعلية',
    titleEn: 'Comprehensive MCQ Question Bank',
    descAr: 'تدريب تفاعلي غير محدود على آلاف الأسئلة الوزارية والشاملة مع نظام احتساب الستريك، إحصائيات الدقة، ومراجعة الأخطاء.',
    descEn: 'Unlimited interactive practice on thousands of MCQs with streak counting, accuracy tracking, and mistake reviews.',
    gradient: 'from-sky-500/10 via-blue-500/5 to-transparent',
    borderGlow: 'border-sky-500/30 dark:border-sky-400/20',
    iconColor: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  },
  {
    id: 'simosan_ai',
    icon: Bot,
    badgeAr: 'ذكاء اصطناعي',
    badgeEn: 'AI Powered',
    titleAr: 'المعلم الذكي سيموسان (Simosan AI)',
    titleEn: 'Simosan AI Smart Tutor',
    descAr: 'مساعد دراسي ذكي يرافقك خطوة بخطوة لشرح النقاط الغامضة، تلخيص الأفكار المعقدة، والإجابة على أي تساؤل دراسي على مدار الساعة.',
    descEn: 'Your intelligent 24/7 study companion to explain difficult lecture points, summarize concepts, and answer queries.',
    gradient: 'from-indigo-500/10 via-purple-500/5 to-transparent',
    borderGlow: 'border-indigo-500/30 dark:border-indigo-400/20',
    iconColor: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400',
  },
  {
    id: 'leaderboard_vip',
    icon: Crown,
    badgeAr: 'تميز فريد',
    badgeEn: 'Royal Distinction',
    titleAr: 'شارة وهالة VIP في لوحة الصدارة',
    titleEn: 'VIP Leaderboard Distinction & Halo',
    descAr: 'تميز مرئي فاخر في قائمة المتصدرين ومنصة التتويج مع هالة مشعة، وشارة VIP الملكية، وشعاع لمعان يعكس مكانتك المتقدمة أمام الجميع.',
    descEn: 'Prestigious visual ranking in leaderboard and podium featuring a radiant aura, royal VIP badge, and shimmer beam.',
    gradient: 'from-yellow-500/10 via-amber-500/5 to-transparent',
    borderGlow: 'border-yellow-500/30 dark:border-yellow-400/20',
    iconColor: 'bg-yellow-500/15 text-yellow-600 dark:text-yellow-400',
  },
  {
    id: 'banner_themes',
    icon: Palette,
    badgeAr: '4 ألوان حصرية',
    badgeEn: '4 Exclusive Themes',
    titleAr: 'تخصيص الثيم بـ 4 ألوان ملكية',
    titleEn: 'Custom 4-Color VIP Themes',
    descAr: 'اختر مظهر بطاقتك وتأثيرك في لوحة الصدارة بحرية من بين 4 ألوان راقية (الذهبي الملكي، الوردي الفاخر، الأسود الحالك، والأبيض اللؤلؤي) يراها كافة الطلاب فورياً.',
    descEn: 'Personalize your subscriber card and leaderboard appearance across 4 themes (Royal Gold, Rose Pink, Obsidian Black, Frost Pearl) synced live for all users.',
    gradient: 'from-pink-500/10 via-rose-500/5 to-transparent',
    borderGlow: 'border-pink-500/30 dark:border-pink-400/20',
    iconColor: 'bg-pink-500/15 text-pink-600 dark:text-pink-400',
  },
  {
    id: 'unlimited_access',
    icon: Zap,
    badgeAr: 'أولوية قصوى',
    badgeEn: 'Priority & Future Updates',
    titleAr: 'أولوية الوصول والتحديثات المستقبلية',
    titleEn: 'Priority Access & Future Updates',
    descAr: 'وصول أولي ومباشر لكافة الميزات والتحديثات الجديدة فور صدورها، مع دعم فني ذو أولوية وتجربة دراسية سلسة بلا انقطاع.',
    descEn: 'First-look access to upcoming platform releases, premium priority support, and seamless learning with zero limits.',
    gradient: 'from-emerald-500/10 via-teal-500/5 to-transparent',
    borderGlow: 'border-emerald-500/30 dark:border-emerald-400/20',
    iconColor: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  },
];

export default function SubscriptionPerksModal({ isOpen, onClose, lang }: SubscriptionPerksModalProps) {
  const isRtl = lang === 'ar';

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/60 backdrop-blur-md transition-opacity"
          />

          {/* Modal Container */}
          <motion.div
            initial={{ opacity: 0, scale: 0.92, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 15 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="relative w-full max-w-xl max-h-[90vh] flex flex-col bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl rounded-3xl shadow-2xl border border-amber-300/40 dark:border-amber-500/30 overflow-hidden my-auto"
            dir={isRtl ? 'rtl' : 'ltr'}
          >
            {/* Header Ambient Glow */}
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-3/4 h-28 bg-gradient-to-b from-amber-400/20 to-transparent blur-2xl pointer-events-none" />

            {/* Modal Header */}
            <div className="relative z-10 px-6 pt-6 pb-4 flex items-start justify-between border-b border-slate-100 dark:border-zinc-800">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-amber-500 to-yellow-400 flex items-center justify-center text-white shadow-lg shadow-amber-500/25 ring-2 ring-amber-300/50">
                  <Crown className="w-6 h-6 drop-shadow-xs" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-xl font-black text-slate-900 dark:text-white">
                      {isRtl ? 'ميزات الاشتراك الحصري' : 'Full Subscription Perks'}
                    </h2>
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30">
                      <Sparkles className="w-2.5 h-2.5" />
                      VIP
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    {isRtl ? 'كل ما يمنحه لك الاشتراك لتحقيق التفوق الأكاديمي' : 'Everything unlocked to power your academic excellence'}
                  </p>
                </div>
              </div>

              {/* Close Button */}
              <button
                onClick={onClose}
                className="p-2 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Perks Content Scrollable List */}
            <div className="relative z-10 flex-1 overflow-y-auto px-5 py-4 space-y-3 max-h-[calc(90vh-140px)]">
              {PERKS.map((perk, index) => {
                const IconComponent = perk.icon;
                return (
                  <motion.div
                    key={perk.id}
                    initial={{ opacity: 0, y: 15 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: index * 0.05 }}
                    className={`relative p-4 rounded-2xl border transition-all duration-200 bg-gradient-to-r ${perk.gradient} ${perk.borderGlow} hover:shadow-md hover:scale-[1.01]`}
                  >
                    <div className="flex items-start gap-3.5">
                      {/* Icon */}
                      <div className={`p-2.5 rounded-xl shrink-0 ${perk.iconColor} shadow-xs`}>
                        <IconComponent className="w-5 h-5" />
                      </div>

                      {/* Text */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <h3 className="font-bold text-sm text-slate-900 dark:text-white">
                            {isRtl ? perk.titleAr : perk.titleEn}
                          </h3>
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-white/80 dark:bg-zinc-800/80 text-slate-600 dark:text-slate-300 border border-slate-200/60 dark:border-zinc-700/60 shrink-0">
                            {isRtl ? perk.badgeAr : perk.badgeEn}
                          </span>
                        </div>
                        <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                          {isRtl ? perk.descAr : perk.descEn}
                        </p>
                      </div>
                    </div>
                  </motion.div>
                );
              })}

              {/* Bottom Guarantee Note */}
              <div className="mt-4 p-3.5 rounded-2xl bg-amber-50/70 dark:bg-amber-950/20 border border-amber-200/60 dark:border-amber-800/40 flex items-center gap-3">
                <ShieldCheck className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0" />
                <p className="text-[11px] font-semibold text-amber-800 dark:text-amber-300 leading-snug">
                  {isRtl
                    ? 'اشتراكك يفعّل جميع الميزات المذكورة على حسابك فورياً بدون أي قيود أو شروط خفية.'
                    : 'Your active subscription grants instant unlimited access to all features above with zero restrictions.'}
                </p>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="relative z-10 px-6 py-3.5 border-t border-slate-100 dark:border-zinc-800 bg-slate-50/50 dark:bg-zinc-900/50 flex justify-end">
              <button
                onClick={onClose}
                className="px-5 py-2 rounded-xl text-xs font-bold bg-gradient-to-r from-amber-500 to-yellow-500 text-white shadow-sm shadow-amber-500/20 hover:from-amber-600 hover:to-yellow-600 active:scale-95 transition-all"
              >
                {isRtl ? 'فهمت ذلك' : 'Got it'}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
