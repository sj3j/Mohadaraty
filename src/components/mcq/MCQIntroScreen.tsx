import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Lecture, UserProfile } from '../../types';
import { BookOpen, X, Clock, Trophy, AlertTriangle, ArrowRight, ArrowLeft, Bot, Library, ShieldAlert, FileText, Loader2, Check, Send, Lock, RotateCcw, Crown, Sparkles, GraduationCap } from 'lucide-react';
import { getLockedAnswers } from '../../services/mcqAnswerService';
import { BankQuestion } from '../../types/questionBank.types';
import { canManageAntiCheat, canManageLectures, canManageMcqSystem } from '../../lib/permissions';

interface Props {
  lecture: Lecture;
  questionsCount: number;
  bankQuestions?: BankQuestion[];
  firstAttemptStatus: { hasCompleted: boolean; score: number | null };
  onStart: () => void;
  onStartDoctorQuiz?: () => void;
  isSubscribed?: boolean;
  onShowPaywall?: () => void;
  onClose: () => void;
  user: UserProfile | null;
  userId: string;
  /** Students cannot generate; they ask staff to. */
  onRequestGeneration: () => void;
  requesting: boolean;
  requestState: 'idle' | 'sent' | 'already' | 'error';
  /** Staff generate directly. The server is the real gate - see canGenerate. */
  onGenerate: () => void;
  generateError: string | null;
  isQuizLocked: boolean;
}

export default function MCQIntroScreen({ lecture, questionsCount, bankQuestions = [], firstAttemptStatus, onStart, onStartDoctorQuiz, isSubscribed = false, onShowPaywall, onClose, user, userId, onRequestGeneration, requesting, requestState, onGenerate, generateError, isQuizLocked }: Props) {
  const isRetake = firstAttemptStatus.hasCompleted;
  const isTranslated = lecture.version === 'translated';
  const [lockedCount, setLockedCount] = useState(0);
  const [retryCountdown, setRetryCountdown] = useState(0);

  useEffect(() => {
    if (generateError) {
      setRetryCountdown(5);
      const interval = setInterval(() => {
        setRetryCountdown((prev) => {
          if (prev <= 1) {
            clearInterval(interval);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(interval);
    } else {
      setRetryCountdown(0);
    }
  }, [generateError]);

  /*
   * Master admin, representative (role 'admin') and assistant (role
   * 'moderator') - exactly the three the server's verifyAdmin admits, so the
   * button is never offered to someone /api/mcq/generate would then 403.
   * `canManageMcqSystem` is NOT the right gate here: it is master-admin-only
   * and guards the question bank and cheating monitor, not generation.
   */
  const canGenerate = !isTranslated && canManageLectures(user);

  useEffect(() => {
    if (!isRetake && userId) {
      getLockedAnswers(userId, lecture.id).then(answers => {
        setLockedCount(Object.keys(answers).length);
      });
    }
  }, [isRetake, userId, lecture.id]);

  return (
    <motion.div 
      initial={{ x: 20, opacity: 0 }} 
      animate={{ x: 0, opacity: 1 }} 
      exit={{ x: -20, opacity: 0 }}
      className="flex flex-col h-full bg-stone-50 dark:bg-zinc-900"
    >
      <div className="flex items-center justify-between p-4 bg-white dark:bg-zinc-800 border-b border-slate-100 dark:border-zinc-700">
        <button onClick={onClose} className="p-2 rounded-full hover:bg-slate-100 dark:hover:bg-zinc-700">
          <X className="w-6 h-6" />
        </button>
        <span className="font-bold text-lg dark:text-white">تفاصيل الاختبار</span>
        <div className="w-10" />
      </div>

      <div className="flex-1 p-6 overflow-y-auto">
        <div className="mb-6">
          <div className="inline-flex px-3 py-1 bg-sky-100 text-sky-700 rounded-full text-xs font-bold mb-3">
            {lecture.category}
          </div>
          <h1 className="text-2xl font-black text-slate-900 dark:text-white leading-tight">
            اختبارات: {lecture.title}
          </h1>
        </div>

        {/* AI Section (Existing) - hidden entirely for translated lectures, which
            are raw source material and never get AI questions. They still reach
            this screen, for the question bank below, which they share with the
            original they were translated from. */}
        {!isTranslated && (
        <div className="bg-white dark:bg-zinc-800 rounded-2xl p-5 border border-slate-100 dark:border-zinc-700 shadow-sm mb-6">
          <div className="flex items-center gap-2 mb-4">
            <Bot className="w-5 h-5 text-sky-500" />
            <h2 className="text-lg font-bold text-slate-900 dark:text-white">أسئلة الذكاء الاصطناعي</h2>
          </div>
          <p className="text-sm text-slate-600 dark:text-slate-400 mb-4">
            {questionsCount > 0
              ? `${questionsCount} سؤال مولّد من محتوى المحاضرة`
              : 'لم تُحضَّر أسئلة هذه المحاضرة بعد.'}
          </p>
          
          <div className="space-y-4 mb-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-50 dark:bg-blue-900/30 text-blue-600 rounded-lg">
                 <BookOpen className="w-4 h-4" />
              </div>
              <p className="font-bold text-sm text-slate-900 dark:text-white">بدون وقت محدد</p>
            </div>
            <div className="flex items-center gap-3">
              <div className="p-2 bg-amber-50 dark:bg-amber-900/30 text-amber-600 rounded-lg">
                 <Trophy className="w-4 h-4" />
              </div>
              <p className="font-bold text-sm text-slate-900 dark:text-white">أول محاولة تُحسب في اللوحة</p>
            </div>
          </div>

          {isRetake && (
            <div className="space-y-3 mb-4">
              <div className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 p-3 rounded-xl flex items-center justify-between">
                <span className="font-bold text-sm text-emerald-800 dark:text-emerald-300">محاولتك الأولى:</span>
                <span className="font-black text-emerald-600 dark:text-emerald-400">{firstAttemptStatus.score}%</span>
              </div>
              <div className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                <p>هذه إعادة — لن تؤثر على ترتيبك في لوحة الصدارة.</p>
              </div>
            </div>
          )}

          {!isRetake && lockedCount > 0 && (
            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 p-3 rounded-xl flex items-start gap-2 mb-4 text-xs font-medium">
              <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
              <div className="text-amber-800 dark:text-amber-300">
                لديك {lockedCount} إجابة محفوظة. لا يمكن تغييرها.
              </div>
            </div>
          )}
          
          {/* Generation is staff-only and server-side now - it used to run in
              the student's browser on a bundled API key. With no questions yet
              the student can ask for them; the mcqs listener flips this card to
              the start button the moment staff finish, with no refresh. */}
          {isQuizLocked ? (
            <div className="p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl text-center space-y-1.5 mt-2">
              <Lock className="w-5 h-5 text-amber-600 dark:text-amber-400 mx-auto" />
              <p className="text-sm font-bold text-amber-900 dark:text-amber-200">
                الاختبارات معطلة مؤقتاً
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-300">
                لا يمكن خوض الاختبارات أثناء فترة انتظار النتيجة النهائية. ستُتاح الاختبارات فور تأكيد نتيجتك.
              </p>
            </div>
          ) : questionsCount > 0 ? (
            <>
              {!isSubscribed && (
                <div className="flex items-center justify-between px-3 py-2 bg-sky-50/80 dark:bg-sky-950/30 border border-sky-100 dark:border-sky-900/40 rounded-xl mb-2 text-xs text-sky-800 dark:text-sky-300 font-bold">
                  <span className="flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-sky-500" />
                    معاينة مجانية متاحة
                  </span>
                  <span className="bg-sky-600 text-white text-[10px] px-2 py-0.5 rounded-full font-black">
                    أول سؤالين مجاناً 🎁
                  </span>
                </div>
              )}
              <button
                onClick={onStart}
                className="w-full py-3 bg-sky-600 hover:bg-sky-700 text-white font-bold rounded-xl flex items-center justify-center gap-2 transition-colors mt-1 shadow-sm"
              >
                {lockedCount > 0 && !isRetake ? 'أكمل اختبار AI' : 'ابدأ اختبار AI'}
                <ArrowLeft className="w-4 h-4 rtl:rotate-0" />
              </button>

              {/* أسئلة الدكتور choice locked below ابدأ اختبار Ai */}
              {!isSubscribed ? (
                <button
                  type="button"
                  onClick={onShowPaywall}
                  className="w-full mt-3 p-3.5 rounded-xl border border-purple-200 dark:border-purple-800/60 bg-gradient-to-r from-purple-50/90 via-indigo-50/40 to-purple-50/90 dark:from-purple-950/25 dark:via-zinc-800/90 dark:to-purple-950/25 hover:border-purple-300 dark:hover:border-purple-700 transition-all flex items-center justify-between text-right group shadow-xs active:scale-[0.99]"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-400 flex items-center justify-center shrink-0">
                      <GraduationCap className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-black text-sm text-slate-900 dark:text-white">
                          أسئلة الدكتور
                        </span>
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-purple-600 text-[10px] font-black text-white shadow-xs">
                          <Crown className="w-2.5 h-2.5 fill-current" />
                          باقة التفوق
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                        {bankQuestions.filter(q => q.tags?.includes('سؤال_الدكتور')).length > 0
                          ? `${bankQuestions.filter(q => q.tags?.includes('سؤال_الدكتور')).length} سؤال من امتحانات وملاحظات الدكتور`
                          : 'أسئلة حصرية مأخوذة من شرح وملاحظات الدكتور'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 text-purple-600 dark:text-purple-400 font-bold text-xs bg-white dark:bg-zinc-800 px-2.5 py-1.5 rounded-lg border border-purple-200/80 dark:border-purple-900/60 shrink-0 shadow-xs">
                    <Lock className="w-3.5 h-3.5 text-purple-500" />
                    <span>مغلق</span>
                  </div>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onStartDoctorQuiz}
                  disabled={bankQuestions.filter(q => q.tags?.includes('سؤال_الدكتور')).length === 0}
                  className="w-full mt-3 p-3.5 rounded-xl border border-purple-200 dark:border-purple-800/60 bg-gradient-to-r from-purple-50 via-white to-purple-50 dark:from-purple-950/20 dark:via-zinc-800 dark:to-purple-950/20 hover:border-purple-400 dark:hover:border-purple-600 transition-all flex items-center justify-between text-right group shadow-xs disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-400 flex items-center justify-center shrink-0">
                      <GraduationCap className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-black text-sm text-slate-900 dark:text-white">
                          أسئلة الدكتور
                        </span>
                        <span className="px-2 py-0.5 rounded-md bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 text-[10px] font-bold">
                          {bankQuestions.filter(q => q.tags?.includes('سؤال_الدكتور')).length} سؤال
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                        أسئلة حصرية مأخوذة من شرح وملاحظات الدكتور
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 text-purple-600 dark:text-purple-400 font-bold text-xs bg-white dark:bg-zinc-800 px-3 py-1.5 rounded-lg border border-purple-200 dark:border-purple-800 group-hover:bg-purple-600 group-hover:text-white transition-colors shrink-0">
                    <span>ابدأ</span>
                    <ArrowLeft className="w-3.5 h-3.5 rtl:rotate-0" />
                  </div>
                </button>
              )}
            </>
          ) : canGenerate ? (
            <>
              <button
                onClick={onGenerate}
                className="w-full py-3 bg-sky-600 hover:bg-sky-700 text-white font-bold rounded-xl flex items-center justify-center gap-2 transition-colors mt-2"
              >
                <Bot className="w-4 h-4" />
                أنشئ الأسئلة الآن
              </button>
              {generateError && (
                <div className="mt-3 p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-xl space-y-2">
                  <p className="text-xs font-bold text-amber-700 dark:text-amber-300 text-center">
                    {generateError}
                  </p>
                  <button
                    type="button"
                    onClick={onGenerate}
                    disabled={retryCountdown > 0}
                    className="w-full py-2 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-xs font-bold rounded-lg flex items-center justify-center gap-1.5 transition-colors"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    {retryCountdown > 0 ? `إعادة المحاولة (${retryCountdown}s)` : 'إعادة المحاولة الآن'}
                  </button>
                </div>
              )}
            </>
          ) : requestState === 'sent' || requestState === 'already' ? (
            <div className="w-full py-3 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 font-bold rounded-xl flex items-center justify-center gap-2 mt-2 text-sm">
              <Check className="w-4 h-4" />
              {requestState === 'already' ? 'طلبك مُسجَّل بالفعل' : 'تم إرسال الطلب للإدارة'}
            </div>
          ) : (
            <>
              <button
                onClick={onRequestGeneration}
                disabled={requesting}
                className="w-full py-3 bg-slate-900 dark:bg-stone-100 text-white dark:text-zinc-900 font-bold rounded-xl flex items-center justify-center gap-2 transition-colors mt-2 disabled:opacity-50"
              >
                {requesting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                اطلب تحضير الأسئلة
              </button>
              {requestState === 'error' && (
                <p className="text-xs font-bold text-amber-600 dark:text-amber-400 text-center mt-2">
                  تعذّر إرسال الطلب. حاول لاحقاً.
                </p>
              )}
            </>
          )}
        </div>
        )}

        {/* A translated lecture whose original has no bank questions yet would
            otherwise render a completely empty screen - no AI card, no bank
            card - which reads as a broken overlay rather than an empty one. */}
        {isTranslated && bankQuestions.length === 0 && (
          <div className="bg-white dark:bg-zinc-800 rounded-2xl p-5 border border-slate-100 dark:border-zinc-700 shadow-sm mb-6 text-center">
            <Library className="w-8 h-8 text-slate-300 dark:text-zinc-600 mx-auto mb-3" />
            <p className="text-sm text-slate-500 dark:text-slate-400">
              لا توجد أسئلة في بنك الأسئلة لهذه المحاضرة بعد.
            </p>
          </div>
        )}

        {/* Bank Section */}
        {bankQuestions.length > 0 && (
          <div className="bg-white dark:bg-zinc-800 rounded-2xl p-5 border border-slate-100 dark:border-zinc-700 shadow-sm mb-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Library className="w-5 h-5 text-emerald-500" />
                <h2 className="text-lg font-bold text-slate-900 dark:text-white">بنك الأسئلة</h2>
              </div>
              <span className="font-black text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 px-2 py-0.5 rounded text-sm">{bankQuestions.length} سؤال</span>
            </div>
            
            <div className="flex flex-wrap gap-2 mb-4">
              {['وزاري', 'سنين_سابقة', 'سؤال_الدكتور', 'مهم'].map(tag => {
                const count = bankQuestions.filter(q => q.tags.includes(tag as any)).length;
                if (count === 0) return null;
                const colors = {
                  'وزاري': 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400',
                  'سنين_سابقة': 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
                  'سؤال_الدكتور': 'bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
                  'مهم': 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                }[tag] || 'bg-slate-100 text-slate-600';
                return (
                  <span key={tag} className={`text-xs font-bold px-2 py-1 rounded ${colors}`}>
                    {tag.replace('_', ' ')}: {count}
                  </span>
                )
              })}
            </div>
            
            <div className="flex gap-2">
              {isQuizLocked ? (
                <div className="w-full p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl text-center space-y-1.5">
                  <Lock className="w-5 h-5 text-amber-600 dark:text-amber-400 mx-auto" />
                  <p className="text-sm font-bold text-amber-900 dark:text-amber-200">
                    بنك الأسئلة معطل مؤقتاً
                  </p>
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    لا يمكن خوض اختبارات بنك الأسئلة أثناء فترة انتظار تأكيد النتيجة.
                  </p>
                </div>
              ) : !isSubscribed ? (
                <button 
                  onClick={onShowPaywall}
                  className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl flex items-center justify-center gap-2 transition-colors relative shadow-sm"
                >
                  <Lock className="w-4 h-4" />
                  <span>ابدأ اختبار ببنك الأسئلة</span>
                  <span className="text-[10px] bg-white/20 px-2 py-0.5 rounded-full font-medium">باقة التفوق</span>
                </button>
              ) : (
                <button 
                  onClick={() => window.dispatchEvent(new CustomEvent('open-bank-quiz', { detail: { bankQuestions, lectureId: lecture.id } }))}
                  className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl flex items-center justify-center gap-2 transition-colors"
                >
                  ابدأ اختبار ببنك الأسئلة
                </button>
              )}
            </div>
          </div>
        )}

        {(canManageMcqSystem(user) || canManageAntiCheat(user)) && (
          <div className="bg-white dark:bg-zinc-800 rounded-2xl p-5 border border-slate-100 dark:border-zinc-700 shadow-sm mb-6">
            <h2 className="text-lg font-bold text-slate-900 dark:text-white mb-4">أدوات المشرف</h2>
            
            {canManageMcqSystem(user) && <button
              onClick={() => window.dispatchEvent(new CustomEvent('open-admin-bank'))}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-emerald-50 dark:bg-emerald-900/10 text-emerald-600 dark:text-emerald-400 rounded-xl font-bold hover:bg-emerald-100 dark:hover:bg-emerald-900/30 transition-colors mb-3"
            >
              <FileText className="w-5 h-5" />
              إدارة بنك الأسئلة
            </button>}
            {canManageAntiCheat(user) && <button
              onClick={() => window.dispatchEvent(new CustomEvent('open-anti-cheat-board'))}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-red-50 dark:bg-red-900/10 text-red-600 dark:text-red-400 rounded-xl font-bold hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors"
            >
              <ShieldAlert className="w-5 h-5" />
              مراقبة الغش (MCQ)
            </button>}
          </div>
        )}

      </div>
    </motion.div>
  );
}
