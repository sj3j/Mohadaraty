import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Languages, HelpCircle, Check, Sparkles } from 'lucide-react';
import type { SimosanLanguageMode } from '../../services/simosanService';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  isRtl: boolean;
  languageMode: SimosanLanguageMode;
  onLanguageModeChange: (mode: SimosanLanguageMode) => void;
  autoQuiz: boolean;
  onAutoQuizChange: (enabled: boolean) => void;
}

export default function SimosanSettingsModal({
  isOpen,
  onClose,
  isRtl,
  languageMode,
  onLanguageModeChange,
  autoQuiz,
  onAutoQuizChange,
}: Props) {
  if (!isOpen) return null;

  const langOptions: Array<{
    id: SimosanLanguageMode;
    title: string;
    desc: string;
    tag: string;
  }> = [
    {
      id: 'ar',
      title: isRtl ? 'عربي (مع المصطلحات الإنجليزية)' : 'Arabic (with English terms)',
      desc: isRtl
        ? 'شرح مفهوم بالعربية المبسطة مع إبقاء أسماء الأدوية والآليات بالإنجليزية كما في السلايدات.'
        : 'Simplified Arabic explanations keeping raw English drug names & mechanisms.',
      tag: isRtl ? 'الموصى به' : 'Recommended',
    },
    {
      id: 'en',
      title: isRtl ? 'إنكليزي (English)' : 'English Only',
      desc: isRtl
        ? 'شرح أكاديمي كامل باللغة الإنجليزية الطبية المناسبة لطلبة الصيدلة.'
        : 'Full academic English explanations suitable for medical/pharmacy studies.',
      tag: 'English',
    },
    {
      id: 'bilingual',
      title: isRtl ? 'اللغتين معًا (مقتبس + شرح)' : 'Bilingual (Quote + Summary)',
      desc: isRtl
        ? 'إرسال النص الإنجليزي المقتبس من الملزمة مع رقم الصفحة، يليه شرح ملخص ومكثف بالعربي.'
        : 'Quotes exact English lecture excerpts with [[p:X]] citations, followed by a concise Arabic clinical summary.',
      tag: isRtl ? 'شامل' : 'Comprehensive',
    },
  ];

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />

      {/* Modal Card */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 15 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 15 }}
        dir={isRtl ? 'rtl' : 'ltr'}
        className="relative w-full max-w-md bg-white dark:bg-zinc-900 rounded-3xl shadow-2xl border border-slate-200 dark:border-zinc-800 overflow-hidden flex flex-col max-h-[90vh]"
      >
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-slate-100 dark:border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-300 flex items-center justify-center">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-base font-black text-slate-900 dark:text-stone-100">
                {isRtl ? 'إعدادات شرح سيموسان' : 'Simosan Teaching Settings'}
              </h3>
              <p className="text-[11px] text-slate-400 font-medium">
                {isRtl ? 'تخصيص لغة الشرح والامتحانات التدريبية' : 'Customize language and practice quizzes'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body Content */}
        <div className="p-4 sm:p-5 space-y-5 overflow-y-auto">
          {/* Section 1: Explanation Language */}
          <div>
            <label className="text-xs font-black text-slate-700 dark:text-slate-300 flex items-center gap-1.5 mb-2.5">
              <Languages className="w-4 h-4 text-violet-500" />
              <span>{isRtl ? 'لغة شرح سيموسان' : 'Explanation Language'}</span>
            </label>

            <div className="space-y-2">
              {langOptions.map((opt) => {
                const isSelected = languageMode === opt.id;
                return (
                  <button
                    key={opt.id}
                    onClick={() => onLanguageModeChange(opt.id)}
                    className={`w-full text-start p-3 rounded-2xl border transition-all flex items-start gap-3 ${
                      isSelected
                        ? 'border-violet-500 bg-violet-50/70 dark:bg-violet-950/30 text-violet-900 dark:text-violet-200 shadow-sm'
                        : 'border-slate-200 dark:border-zinc-800 bg-slate-50/50 dark:bg-zinc-800/40 hover:border-slate-300 dark:hover:border-zinc-700 text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <div
                      className={`shrink-0 w-5 h-5 rounded-full mt-0.5 border flex items-center justify-center ${
                        isSelected
                          ? 'border-violet-500 bg-violet-500 text-white'
                          : 'border-slate-300 dark:border-zinc-600 bg-white dark:bg-zinc-800'
                      }`}
                    >
                      {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-black">{opt.title}</span>
                        {opt.tag && (
                          <span
                            className={`text-[9px] font-bold px-1.5 py-0.2 rounded-full ${
                              isSelected
                                ? 'bg-violet-200/60 dark:bg-violet-800/50 text-violet-800 dark:text-violet-200'
                                : 'bg-slate-200 dark:bg-zinc-700 text-slate-600 dark:text-slate-400'
                            }`}
                          >
                            {opt.tag}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                        {opt.desc}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Section 2: Auto Quiz Toggle */}
          <div className="pt-2 border-t border-slate-100 dark:border-zinc-800">
            <div className="flex items-center justify-between gap-3 p-3 rounded-2xl bg-slate-50 dark:bg-zinc-800/50 border border-slate-200/80 dark:border-zinc-800">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-black text-slate-800 dark:text-stone-100">
                    {isRtl ? 'امتحان بعد كل جزء' : 'Quiz After Each Section'}
                  </span>
                  <span className="text-[9px] font-bold px-1.5 py-0.2 rounded-full bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300">
                    {autoQuiz ? (isRtl ? 'مفعّل' : 'Active') : (isRtl ? 'معطّل' : 'Off')}
                  </span>
                </div>
                <p className="text-[10px] sm:text-[11px] text-slate-400 dark:text-slate-500 mt-0.5 leading-relaxed">
                  {isRtl
                    ? 'توليد 3 أسئلة MCQ إنجليزية تفاعلية بعد كل شرح سريري لتثبيت الفهم.'
                    : 'Generates 3 interactive English MCQs after clinical explanations.'}
                </p>
              </div>

              {/* Toggle switch */}
              <button
                type="button"
                role="switch"
                aria-checked={autoQuiz}
                onClick={() => onAutoQuizChange(!autoQuiz)}
                className={`shrink-0 w-11 h-6 rounded-full transition-colors relative focus:outline-none ${
                  autoQuiz ? 'bg-violet-600' : 'bg-slate-300 dark:bg-zinc-700'
                }`}
              >
                <motion.div
                  layout
                  transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                  className={`w-5 h-5 rounded-full bg-white shadow-md absolute top-0.5 ${
                    autoQuiz
                      ? isRtl
                        ? 'right-5.5 left-auto'
                        : 'left-5.5 right-auto'
                      : isRtl
                      ? 'right-0.5 left-auto'
                      : 'left-0.5 right-auto'
                  }`}
                />
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-100 dark:border-zinc-800 bg-slate-50/50 dark:bg-zinc-900/50">
          <button
            onClick={onClose}
            className="w-full py-2.5 rounded-xl bg-violet-600 hover:bg-violet-700 active:scale-[0.99] text-white text-xs font-black shadow-md shadow-violet-500/20 transition"
          >
            {isRtl ? 'تم وحفظ' : 'Done & Save'}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
