import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { CheckCircle2, XCircle, RotateCcw, Award, HelpCircle, ChevronDown, Sparkles } from 'lucide-react';
import type { SimosanQuizQuestion } from '../../services/simosanService';

interface Props {
  quizzes: SimosanQuizQuestion[];
  isRtl: boolean;
  messageId: string;
}

export default function SimosanQuizCard({ quizzes, isRtl, messageId }: Props) {
  // Keyed by question ID or index: selected option index
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string | number, number>>({});
  // Track open/collapsed explanation state per question
  const [showExplanation, setShowExplanation] = useState<Record<string | number, boolean>>({});

  if (!quizzes || quizzes.length === 0) return null;

  const handleSelect = (qId: string | number, optIdx: number) => {
    // If already answered, don't allow changing until retry
    if (selectedAnswers[qId] !== undefined) return;
    setSelectedAnswers((prev) => ({ ...prev, [qId]: optIdx }));
    setShowExplanation((prev) => ({ ...prev, [qId]: true }));
  };

  const handleRetry = () => {
    setSelectedAnswers({});
    setShowExplanation({});
  };

  const totalQuestions = quizzes.length;
  const answeredCount = Object.keys(selectedAnswers).length;
  const correctCount = quizzes.filter(
    (q, idx) => selectedAnswers[q.id ?? idx] === q.correctIndex
  ).length;
  const isCompleted = answeredCount === totalQuestions;

  return (
    <div className="mt-4 pt-3 border-t border-slate-200/80 dark:border-zinc-700/80 space-y-4">
      {/* Quiz Header Badge */}
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-1.5 text-xs font-black text-violet-600 dark:text-violet-400">
          <Sparkles className="w-3.5 h-3.5" />
          <span>{isRtl ? 'اختبار تدريبي سريع' : 'Practice Checkpoint Quiz'}</span>
          <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-violet-100 dark:bg-violet-900/40 font-bold">
            {answeredCount}/{totalQuestions}
          </span>
        </div>
        {answeredCount > 0 && (
          <button
            onClick={handleRetry}
            className="text-[11px] font-bold text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 flex items-center gap-1 transition"
          >
            <RotateCcw className="w-3 h-3" />
            <span>{isRtl ? 'إعادة' : 'Reset'}</span>
          </button>
        )}
      </div>

      {/* Questions List */}
      <div className="space-y-4">
        {quizzes.map((q, qIdx) => {
          const qKey = q.id ?? qIdx;
          const selected = selectedAnswers[qKey];
          const hasAnswered = selected !== undefined;
          const isCorrect = selected === q.correctIndex;

          return (
            <div
              key={qKey}
              className="rounded-2xl border border-slate-200/90 dark:border-zinc-700/90 bg-white/70 dark:bg-zinc-800/70 p-3.5 shadow-sm transition"
            >
              {/* Question Stem (English Exam Standard) */}
              <div className="flex items-start gap-2 mb-3" dir="ltr">
                <span className="shrink-0 flex items-center justify-center w-5 h-5 rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-300 text-[11px] font-black">
                  {qIdx + 1}
                </span>
                <p className="text-xs sm:text-sm font-bold text-slate-900 dark:text-stone-100 leading-snug">
                  {q.question}
                </p>
              </div>

              {/* Options (A, B, C, D) */}
              <div className="space-y-2" dir="ltr">
                {q.options.map((opt, optIdx) => {
                  const letter = String.fromCharCode(65 + optIdx); // A, B, C, D
                  const isThisSelected = selected === optIdx;
                  const isThisCorrect = optIdx === q.correctIndex;

                  let btnStyle =
                    'border-slate-200 dark:border-zinc-700 bg-slate-50/60 dark:bg-zinc-900/40 text-slate-700 dark:text-slate-200 hover:border-violet-300 dark:hover:border-violet-600 active:scale-[0.99]';

                  if (hasAnswered) {
                    if (isThisCorrect) {
                      btnStyle =
                        'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-200 font-black';
                    } else if (isThisSelected) {
                      btnStyle =
                        'border-rose-500 bg-rose-50 dark:bg-rose-950/40 text-rose-900 dark:text-rose-200 font-bold';
                    } else {
                      btnStyle =
                        'border-transparent bg-slate-100/50 dark:bg-zinc-800/40 text-slate-400 dark:text-slate-500 opacity-60';
                    }
                  }

                  return (
                    <button
                      key={optIdx}
                      disabled={hasAnswered}
                      onClick={() => handleSelect(qKey, optIdx)}
                      className={`w-full text-start px-3 py-2 rounded-xl border text-xs leading-relaxed transition flex items-center gap-2.5 ${btnStyle}`}
                    >
                      <span
                        className={`shrink-0 w-5 h-5 rounded-md flex items-center justify-center text-[10px] font-black ${
                          hasAnswered && isThisCorrect
                            ? 'bg-emerald-500 text-white'
                            : hasAnswered && isThisSelected
                            ? 'bg-rose-500 text-white'
                            : 'bg-white dark:bg-zinc-800 border border-slate-300 dark:border-zinc-600 text-slate-500 dark:text-slate-400'
                        }`}
                      >
                        {hasAnswered && isThisCorrect ? (
                          <CheckCircle2 className="w-3.5 h-3.5" />
                        ) : hasAnswered && isThisSelected ? (
                          <XCircle className="w-3.5 h-3.5" />
                        ) : (
                          letter
                        )}
                      </span>
                      <span className="flex-1 font-medium">{opt}</span>
                    </button>
                  );
                })}
              </div>

              {/* Instant Clinical Explanation */}
              <AnimatePresence>
                {hasAnswered && q.explanation && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="mt-3 pt-2.5 border-t border-slate-100 dark:border-zinc-700/60"
                    dir="ltr"
                  >
                    <div className="flex items-start gap-1.5 text-xs text-slate-600 dark:text-slate-300 bg-slate-100/80 dark:bg-zinc-900/60 p-2.5 rounded-xl">
                      <HelpCircle className="w-3.5 h-3.5 text-violet-500 shrink-0 mt-0.5" />
                      <div className="text-[11px] leading-relaxed">
                        <span className="font-bold text-violet-600 dark:text-violet-400 mr-1">
                          Clinical Key:
                        </span>
                        <span>{q.explanation}</span>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>

      {/* Completion Summary Badge */}
      {isCompleted && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="p-3.5 rounded-2xl bg-gradient-to-r from-violet-500/10 via-sky-500/10 to-emerald-500/10 border border-violet-200 dark:border-violet-800 text-center space-y-2"
        >
          <div className="flex items-center justify-center gap-1.5 text-violet-700 dark:text-violet-300 font-black text-xs sm:text-sm">
            <Award className="w-4 h-4 text-amber-500" />
            <span>
              {isRtl
                ? `أكملت الاختبار! النتيجة: ${correctCount} من ${totalQuestions} صحيحة 🎯`
                : `Quiz Completed! Score: ${correctCount}/${totalQuestions} correct 🎯`}
            </span>
          </div>
          <p className="text-[10px] text-slate-500 dark:text-slate-400">
            {correctCount === totalQuestions
              ? isRtl
                ? 'ممتاز! استيعاب كامل للمفاهيم الأساسية.'
                : 'Excellent! Perfect comprehension of key concepts.'
              : isRtl
              ? 'راجع التفسيرات السريرية أعلاه لتثبيت النقاط غير المتقنة.'
              : 'Review the clinical keys above to reinforce tricky points.'}
          </p>
        </motion.div>
      )}
    </div>
  );
}
