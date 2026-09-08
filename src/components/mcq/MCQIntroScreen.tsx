import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Lecture, UserProfile } from '../../types';
import { BookOpen, X, Clock, Trophy, AlertTriangle, ArrowRight, ArrowLeft, Bot, Library, ShieldAlert, FileText, Loader2, Check, Send } from 'lucide-react';
import { getLockedAnswers } from '../../services/mcqAnswerService';
import { BankQuestion } from '../../types/questionBank.types';
import { canManageMcqSystem, isMasterAdmin, isStaff } from '../../lib/permissions';

interface Props {
  lecture: Lecture;
  questionsCount: number;
  bankQuestions?: BankQuestion[];
  firstAttemptStatus: { hasCompleted: boolean; score: number | null };
  onStart: () => void;
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
}

export default function MCQIntroScreen({ lecture, questionsCount, bankQuestions = [], firstAttemptStatus, onStart, onClose, user, userId, onRequestGeneration, requesting, requestState, onGenerate, generateError }: Props) {
  const isRetake = firstAttemptStatus.hasCompleted;
  const isTranslated = lecture.version === 'translated';
  const [lockedCount, setLockedCount] = useState(0);

  /*
   * Master admin, representative (role 'admin') and assistant (role
   * 'moderator') - exactly the three the server's verifyAdmin admits, so the
   * button is never offered to someone /api/mcq/generate would then 403.
   * `canManageMcqSystem` is NOT the right gate here: it is master-admin-only
   * and guards the question bank and cheating monitor, not generation.
   */
  const canGenerate = !isTranslated && (isMasterAdmin(user) || isStaff(user));

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
          {questionsCount > 0 ? (
            <button
              onClick={onStart}
              className="w-full py-3 bg-sky-600 hover:bg-sky-700 text-white font-bold rounded-xl flex items-center justify-center gap-2 transition-colors mt-2"
            >
              {lockedCount > 0 && !isRetake ? 'أكمل اختبار AI' : 'ابدأ اختبار AI'}
              <ArrowLeft className="w-4 h-4" />
            </button>
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
                <p className="text-xs font-bold text-amber-600 dark:text-amber-400 text-center mt-2">
                  {generateError}
                </p>
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
              <button 
                onClick={() => window.dispatchEvent(new CustomEvent('open-bank-quiz', { detail: { bankQuestions, lectureId: lecture.id } }))}
                className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl flex items-center justify-center gap-2 transition-colors"
               >
                 ابدأ اختبار ببنك الأسئلة
              </button>
            </div>
          </div>
        )}

        {canManageMcqSystem(user) && (
          <div className="bg-white dark:bg-zinc-800 rounded-2xl p-5 border border-slate-100 dark:border-zinc-700 shadow-sm mb-6">
            <h2 className="text-lg font-bold text-slate-900 dark:text-white mb-4">أدوات المشرف</h2>
            
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('open-admin-bank'))}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-emerald-50 dark:bg-emerald-900/10 text-emerald-600 dark:text-emerald-400 rounded-xl font-bold hover:bg-emerald-100 dark:hover:bg-emerald-900/30 transition-colors mb-3"
            >
              <FileText className="w-5 h-5" />
              إدارة بنك الأسئلة
            </button>
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('open-anti-cheat-board'))}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-red-50 dark:bg-red-900/10 text-red-600 dark:text-red-400 rounded-xl font-bold hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors"
            >
              <ShieldAlert className="w-5 h-5" />
              مراقبة الغش (MCQ)
            </button>
          </div>
        )}

      </div>
    </motion.div>
  );
}
