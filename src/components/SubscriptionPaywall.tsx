import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Crown, Sparkles, Shield, Clock } from 'lucide-react';
import { Language, TRANSLATIONS, PLAN_CONFIG, planAnchorPrice, SubscriptionPlan } from '../types';
import { IS_STORE_BUILD } from '../lib/platform';

interface SubscriptionPaywallProps {
  lang: Language;
  onClose: () => void;
  onSubscribe: () => void;
}

export default function SubscriptionPaywall({ lang, onClose, onSubscribe }: SubscriptionPaywallProps) {
  const isRtl = lang === 'ar';
  const t = TRANSLATIONS[lang];

  const plans: { key: SubscriptionPlan; badge?: string; highlight?: boolean }[] = [
    { key: 'monthly' },
    { key: 'seasonal', badge: t.popular, highlight: true },
    { key: 'semi_annual' },
    { key: 'annual', badge: t.bestValue },
  ];

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
        onClick={onClose}
      >
        {/* Backdrop */}
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

        {/* Modal */}
        <motion.div
          initial={{ opacity: 0, scale: 0.9, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.9, y: 20 }}
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          onClick={(e) => e.stopPropagation()}
          className="relative w-full max-w-lg bg-white dark:bg-zinc-900 rounded-3xl shadow-2xl overflow-hidden"
          dir={isRtl ? 'rtl' : 'ltr'}
        >
          {/* Gradient Header */}
          <div className="relative px-6 pt-8 pb-12 bg-gradient-to-br from-amber-500 via-orange-500 to-rose-500 text-white overflow-hidden">
            {/* Decorative circles */}
            <div className="absolute -top-10 -right-10 w-40 h-40 bg-white/10 rounded-full" />
            <div className="absolute -bottom-8 -left-8 w-32 h-32 bg-white/10 rounded-full" />
            
            <button
              onClick={onClose}
              className="absolute top-4 left-4 rtl:left-auto rtl:right-4 p-2 rounded-full bg-white/20 hover:bg-white/30 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="relative z-10 text-center">
              <motion.div
                animate={{ rotate: [0, 10, -10, 0] }}
                transition={{ repeat: Infinity, duration: 3, ease: 'easeInOut' }}
                className="inline-flex p-3 rounded-2xl bg-white/20 mb-4"
              >
                <Crown className="w-8 h-8" />
              </motion.div>
              <h2 className="text-2xl font-bold mb-2">{t.subscriptionRequired}</h2>
              <p className="text-white/90 text-sm">{t.mcqRequiresSubscription}</p>
            </div>
          </div>

          {/* Content */}
          <div className="px-6 -mt-6 relative z-10">
            {/* Plan Cards */}
            <div className="space-y-3">
              {plans.map((plan, index) => {
                const config = PLAN_CONFIG[plan.key];
                const label = isRtl ? config.labelAr : config.labelEn;
                const anchor = planAnchorPrice(plan.key);
                
                return (
                  <motion.div
                    key={plan.key}
                    initial={{ opacity: 0, x: isRtl ? 20 : -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.1 * index }}
                    className={`relative p-4 rounded-2xl border-2 transition-all ${
                      plan.highlight
                        ? 'border-orange-400 bg-orange-50 dark:bg-orange-950/30 dark:border-orange-600 shadow-lg shadow-orange-500/10'
                        : 'border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800'
                    }`}
                  >
                    {plan.badge && (
                      <span className={`absolute -top-2.5 ${isRtl ? 'right-4' : 'left-4'} px-3 py-0.5 rounded-full text-xs font-bold text-white ${
                        plan.highlight ? 'bg-gradient-to-r from-orange-500 to-rose-500' : 'bg-gradient-to-r from-emerald-500 to-teal-500'
                      }`}>
                        {plan.badge}
                      </span>
                    )}
                    
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="font-bold text-lg text-slate-900 dark:text-white">{label}</h3>
                        <div className="flex items-center gap-1.5 mt-1 text-slate-500 dark:text-slate-400 text-sm">
                          <Clock className="w-3.5 h-3.5" />
                          <span>{config.days} {t.days}</span>
                        </div>
                      </div>
                      <div className="text-left rtl:text-right">
                        {anchor > config.price && (
                          <div className="text-xs text-slate-400 dark:text-slate-500 line-through leading-none mb-0.5">
                            {anchor.toLocaleString()}
                          </div>
                        )}
                        <span className="text-2xl font-extrabold text-slate-900 dark:text-white">
                          {config.price.toLocaleString()}
                        </span>
                        <span className="text-sm text-slate-500 dark:text-slate-400 mr-1 rtl:ml-1"> {t.iqd}</span>
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>

            {/* Features */}
            <div className="mt-5 space-y-2.5">
              {[
                { icon: Sparkles, text: isRtl ? 'وصول كامل لجميع أسئلة MCQ' : 'Full access to all MCQ questions' },
                { icon: Shield, text: isRtl ? 'بنك أسئلة شامل' : 'Comprehensive question bank' },
              ].map(({ icon: Icon, text }, i) => (
                <div key={i} className="flex items-center gap-3 text-sm text-slate-600 dark:text-slate-300">
                  <div className="flex-shrink-0 w-8 h-8 rounded-xl bg-gradient-to-br from-amber-100 to-orange-100 dark:from-amber-900/30 dark:to-orange-900/30 flex items-center justify-center">
                    <Icon className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                  </div>
                  <span>{text}</span>
                </div>
              ))}
            </div>
          </div>

          {/* CTA */}
          <div className="px-6 pb-6 pt-5">
            {IS_STORE_BUILD ? (
              // Native build: no payment links
              <div className="text-center py-4 px-6 rounded-2xl bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-slate-300 text-sm">
                <Shield className="w-5 h-5 mx-auto mb-2 text-slate-400" />
                {t.askRepresentative}
              </div>
            ) : (
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={onSubscribe}
                className="w-full py-4 rounded-2xl bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500 text-white font-bold text-lg shadow-lg shadow-orange-500/30 hover:shadow-orange-500/50 transition-shadow"
              >
                {t.subscribNow}
              </motion.button>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
