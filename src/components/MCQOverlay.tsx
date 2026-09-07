import React, { useState, useReducer, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Lecture, UserProfile, Language } from '../types';
import { X, Loader2, ArrowRight } from 'lucide-react';
import { getExistingMCQsForLecture, generateMCQsForLecture, AIUnavailableError, AI_UNAVAILABLE_MESSAGE } from '../services/mcqGenerationService';
import { getFirstAttemptStatus, finalizeFirstAttempt, submitRetakeAttempt } from '../services/mcqAnswerService';
import { checkMCQBanStatus } from '../services/antiCheatService';
import { getQuestionsForLecture, bankLectureIdFor } from '../services/questionBankService';
import { BankQuestion } from '../types/questionBank.types';

import MCQIntroScreen from './mcq/MCQIntroScreen';
import MCQQuizScreen from './mcq/MCQQuizScreen';
import MCQResultScreen from './mcq/MCQResultScreen';
import MCQReviewScreen from './mcq/MCQReviewScreen';
import BankQuizSetupScreen from './questionBank/BankQuizSetupScreen';
import BankQuizScreen from './questionBank/BankQuizScreen';

export type MCQStackRoute = 'init_loading' | 'loading' | 'intro' | 'quiz' | 'result' | 'review' | 'banned' | 'bank_quiz_setup' | 'bank_quiz' | 'bank_result';

interface MCQOverlayProps {
  lecture: Lecture;
  user: UserProfile;
  lang: Language;
  onClose: () => void;
}

export default function MCQOverlay({ lecture, user, lang, onClose }: MCQOverlayProps) {
  const isRtl = lang === 'ar';
  const [route, setRoute] = useState<MCQStackRoute>('init_loading');
  
  // High-level state to pass to screens
  const [questions, setQuestions] = useState<any[]>([]);
  const [bankQuestions, setBankQuestions] = useState<BankQuestion[]>([]);
  const [bankQuizQuestions, setBankQuizQuestions] = useState<BankQuestion[]>([]);
  const [firstAttemptStatus, setFirstAttemptStatus] = useState<{hasCompleted: boolean, score: number | null}>({hasCompleted: false, score: null});
  const [finalResult, setFinalResult] = useState<any>(null); // from submitting
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const initMCQ = async () => {
      try {
        const isBanned = await checkMCQBanStatus(user.uid);
        if (!active) return;
        
        if (isBanned) {
          setRoute('banned');
          return;
        }

        // 0. Fetch Bank Questions.
        // subjectId, not category: getQuestionsForLecture matches bank questions
        // on `scope == 'subject' && subjectId ==`, and bank questions store the
        // real subject slug. Passing the legacy category meant subject-scoped
        // questions never surfaced. It matters far more after a year-end wipe,
        // when subject scope is all most questions have left. `category` stays
        // as the fallback for content predating the curriculum migration.
        // bankLectureIdFor, not lecture.id: a translated lecture reads the
        // ORIGINAL's lecture-scoped questions, so "lecture 5 translated" and
        // "lecture 5 raw" share one bank instead of each keeping a private copy.
        const bq = await getQuestionsForLecture(bankLectureIdFor(lecture), lecture.subjectId || lecture.category || '');
        if (active) setBankQuestions(bq);

        // 1. Fetch first attempt status
        const status = await getFirstAttemptStatus(user.uid, lecture.id);
        if (!active) return;
        setFirstAttemptStatus(status);

        // 2. Fetch existing generated questions only (do not generate yet)
        const fetchedQuestions = await getExistingMCQsForLecture(lecture.id);
        if (!active) return;
        
        setQuestions(fetchedQuestions);
        setRoute('intro');
      } catch (err: any) {
        console.error(err);
        if (active) {
          setErrorMsg(err.message || 'فشل فتح الاختبار. يرجى المحاولة مرة أخرى.'); // Generic error
          setRoute('loading');
        }
      }
    };
    initMCQ();
    return () => { active = false; };
  }, [lecture, user.uid]);

  const handleStartQuiz = async () => {
    // A translated lecture is raw source material and never gets AI questions.
    // The intro screen hides the AI card for them, so this is unreachable
    // through the UI - it exists so the rule cannot be lost to a later UI edit.
    if (lecture.version === 'translated') return;

    if (questions.length === 0) {
      setRoute('loading');
      setErrorMsg(null);
      try {
        // subjectId, NOT category - the same rule as the bank lookup above.
        // `category` is legacy and absent on every lecture uploaded against the
        // real curriculum, so passing it sent `undefined` into a Firestore write
        // and the student got "Unsupported field value: undefined" instead of a
        // quiz. The mcqs doc keys on subjectId; category is only a fallback for
        // content that predates the migration.
        const generatedQuestions = await generateMCQsForLecture(
          lecture.id,
          lecture.subjectId || lecture.category || '',
          lecture.pdfUrl,
        );
        setQuestions(generatedQuestions);
        setRoute('quiz');
      } catch (err: any) {
        console.error(err);
        // A provider outage (dead key, exhausted quota) is not something the
        // student did or can fix, and its real cause must not reach the screen.
        setErrorMsg(
          err instanceof AIUnavailableError
            ? AI_UNAVAILABLE_MESSAGE
            : (err.message || 'فشل التوليد. يرجى المحاولة مرة أخرى.'),
        );
      }
    } else {
      setRoute('quiz');
    }
  };
  
  const handleFinishQuiz = async (answersState: any, correctCount: number, score: number) => {
    // Process submission
    try {
      let result;
      if (!firstAttemptStatus.hasCompleted) {
         result = await finalizeFirstAttempt(user.uid, lecture.id, lecture.category, answersState, questions.length);
      } else {
         result = await submitRetakeAttempt(user.uid, lecture.id, answersState, questions.length);
      }
      setFinalResult({ ...result, answers: answersState });
      setRoute('result');
    } catch (e) {
      console.error(e);
      alert('Error submitting answers.');
    }
  };

  useEffect(() => {
    const handleQuizSetup = (e: any) => {
      setRoute('bank_quiz_setup');
    };
    window.addEventListener('open-bank-quiz', handleQuizSetup);
    return () => {
      window.removeEventListener('open-bank-quiz', handleQuizSetup);
    }
  }, []);

  return (
    <div className="fixed inset-0 z-[100] bg-white dark:bg-zinc-900 flex flex-col" dir={isRtl ? 'rtl' : 'ltr'}>
      <AnimatePresence mode="wait">
        {route === 'init_loading' && (
          <motion.div 
            key="init_loading"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="flex-1 flex items-center justify-center flex-col p-6"
          >
             <Loader2 className="w-10 h-10 text-blue-500 animate-spin mb-4" />
             <h2 className="text-xl font-bold dark:text-white">جاري التحميل...</h2>
          </motion.div>
        )}
        
        {route === 'loading' && (
          <motion.div 
            key="loading"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="flex-1 flex items-center justify-center flex-col p-6"
          >
            {errorMsg ? (
              <div className="text-center">
                <div className="w-16 h-16 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-4">
                  <X className="w-8 h-8" />
                </div>
                <h2 className="text-xl font-bold mb-2 dark:text-white">{errorMsg}</h2>
                <button 
                  onClick={() => {
                    if (bankQuestions.length > 0 || route === 'loading') {
                        setRoute('intro');
                    } else {
                        onClose();
                    }
                  }} 
                  className="mt-4 px-6 py-2 bg-blue-600 text-white rounded-lg"
                >
                  {isRtl ? 'العودة' : 'Back'}
                </button>
              </div>
            ) : (
              <div className="text-center">
                <div className="relative w-24 h-24 mx-auto mb-6">
                  {/* Pulse animation matching design system */}
                  <div className="absolute inset-0 bg-blue-100 dark:bg-blue-900/30 rounded-full animate-ping opacity-75"></div>
                  <div className="relative w-full h-full bg-white dark:bg-zinc-800 border-4 border-blue-500 rounded-full flex items-center justify-center shadow-lg">
                     <Loader2 className="w-10 h-10 text-blue-500 animate-spin" />
                  </div>
                </div>
                <h2 className="text-2xl font-black text-slate-900 dark:text-stone-100 mb-2">جاري توليد الأسئلة بالذكاء الاصطناعي...</h2>
                <p className="text-slate-500 font-medium">قد يستغرق هذا 10-30 ثانية</p>
              </div>
            )}
          </motion.div>
        )}

        {route === 'banned' && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="flex-1 flex flex-col items-center justify-center p-6 bg-red-50 dark:bg-red-900/10"
          >
             <div className="w-20 h-20 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-4 border border-red-200">
               <X className="w-10 h-10" />
             </div>
             <h2 className="text-2xl font-black text-red-700 dark:text-red-500 mb-2 text-center">🚫 تم تعليق صلاحيتك للوصول للاختبارات</h2>
             <p className="text-slate-600 dark:text-slate-400 font-medium text-center max-w-md">يرجى التواصل مع الإدارة. تم اكتشاف محاولات تصوير شاشة أو خروج من التطبيق بشكل متكرر أثناء الامتحانات السابقة.</p>
             <button onClick={onClose} className="mt-8 px-6 py-3 bg-red-600 text-white font-bold rounded-xl shadow-lg shadow-red-600/20 active:scale-95 transition-all">العودة للرئيسية</button>
          </motion.div>
        )}

        {route === 'intro' && (
          <MCQIntroScreen 
            lecture={lecture} 
            questionsCount={questions.length}
            bankQuestions={bankQuestions}
            firstAttemptStatus={firstAttemptStatus}
            onStart={handleStartQuiz}
            onClose={onClose}
            user={user}
            userId={user.uid}
          />
        )}

        {route === 'quiz' && (
          <MCQQuizScreen 
            lecture={lecture}
            questions={questions}
            onFinish={handleFinishQuiz}
            onClose={onClose}
            user={user}
            onQuestionsUpdated={setQuestions}
          />
        )}

        {route === 'result' && (
          <MCQResultScreen 
            lecture={lecture}
            result={finalResult}
            isFirstAttempt={!firstAttemptStatus.hasCompleted}
            questionsCount={questions.length}
            onReview={() => setRoute('review')}
            onRetake={() => {
               // Update local stat to pretend it's a retake now
               setFirstAttemptStatus({ hasCompleted: true, score: finalResult.score });
               setRoute('intro');
            }}
            onClose={onClose}
          />
        )}

        {route === 'review' && (
          <MCQReviewScreen 
            questions={questions}
            answers={finalResult.answers}
            onBack={() => setRoute('result')}
            lectureId={lecture.id}
          />
        )}

        {route === 'bank_quiz_setup' && (
          <BankQuizSetupScreen 
            bankQuestions={bankQuestions}
            onStartQuiz={(filtered) => {
               setBankQuizQuestions(filtered);
               setRoute('bank_quiz');
            }}
            onBack={() => setRoute('intro')}
          />
        )}

        {route === 'bank_quiz' && (
          <BankQuizScreen 
            questions={bankQuizQuestions}
            onFinish={() => {}} // finishes internally
            onBack={() => setRoute('intro')}
            userId={user.uid}
            userName={user.name}
            isAdmin={user.role === 'admin'}
            onQuestionsUpdated={(updated) => {
               setBankQuizQuestions(updated);
               setBankQuestions(prev => prev.map(q => {
                   const u = updated.find(x => x.id === q.id);
                   return u ? u : q;
               }));
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
