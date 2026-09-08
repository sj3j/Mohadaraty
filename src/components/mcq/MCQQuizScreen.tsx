import React, { useReducer, useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Lecture } from '../../types';
import { MCQQuestion } from '../../types/mcq.types';
import { Check, X, ChevronUp, ArrowUp, Loader2, ShieldAlert, AlertTriangle, CheckCircle, MessageSquare, Edit2, ImagePlus } from 'lucide-react';
import { trackEvent } from '../../lib/analytics';
import { auth, db } from '../../lib/firebase';
import { doc, getDoc, updateDoc, addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { lockSingleAnswer, getLockedAnswers } from '../../services/mcqAnswerService';
import { enableAntiScreenshot, disableAntiScreenshot } from '../../services/antiCheatService';
import { modifyQuestionWithAI } from '../../services/mcqGenerationService';
import MCQManualEditModal from './MCQManualEditModal';

interface Props {
  onQuestionsUpdated?: (questions: any[]) => void;
  lecture: Lecture;
  questions: MCQQuestion[];
  onFinish: (answers: Record<string, { selected: string, isCorrect: boolean }>, correctCount: number, score: number) => void;
  onClose: () => void;
  user?: any;
}

type QuizState = {
  answers: Record<string, { selected: string, isCorrect: boolean, answered: boolean }>;
  answeredCount: number;
};

type QuizAction = 
  | { type: 'SELECT_ANSWER'; payload: { questionId: string; selected: string; isCorrect: boolean } }
  | { type: 'RESTORE_ANSWERS'; payload: Record<string, { selected: string; isCorrect: boolean }> };

function quizReducer(state: QuizState, action: QuizAction): QuizState {
  switch (action.type) {
    case 'RESTORE_ANSWERS': {
      const restored = { ...state.answers };
      let restoredCount = state.answeredCount;
      Object.keys(action.payload).forEach(qId => {
         if (!restored[qId]?.answered) {
           restored[qId] = {
             selected: action.payload[qId].selected,
             isCorrect: action.payload[qId].isCorrect,
             answered: true
           };
           restoredCount++;
         }
      });
      return { answers: restored, answeredCount: restoredCount };
    }
    case 'SELECT_ANSWER': {
      if (state.answers[action.payload.questionId]?.answered) return state; 
      
      const newAnswers = {
        ...state.answers,
        [action.payload.questionId]: {
          selected: action.payload.selected,
          isCorrect: action.payload.isCorrect,
          answered: true
        }
      };
      
      return {
        ...state,
        answers: newAnswers,
        answeredCount: state.answeredCount + 1,
      };
    }
    default:
      return state;
  }
}

export default function MCQQuizScreen({ lecture, questions, onFinish, onClose, user, onQuestionsUpdated }: Props) {
  const [state, dispatch] = useReducer(quizReducer, {
    answers: {},
    answeredCount: 0,
  });
  
  const [showDrawer, setShowDrawer] = useState(false);
  const [showFab, setShowFab] = useState(false);
  const [isRetake, setIsRetake] = useState<boolean | null>(null);
  const [showAntiCheatAlert, setShowAntiCheatAlert] = useState(false);
  const [isFinishing, setIsFinishing] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const questionRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const user = auth.currentUser;
    if (user) {
      enableAntiScreenshot(user.uid, lecture.id, () => {
        setShowAntiCheatAlert(true);
      });
    }

    return () => {
      if (user) {
        disableAntiScreenshot(user.uid, lecture.id);
      }
    };
  }, [lecture.id]);

  useEffect(() => {
    // Check if it's a retake and fetch locked answers if it's the first attempt
    const checkAttempt = async () => {
      const user = auth.currentUser;
      if (!user) return;
      try {
        const docRef = doc(db, `userMCQAnswers/${user.uid}/lectures/${lecture.id}`);
        const snap = await getDoc(docRef);
        if (snap.exists() && snap.data().hasCompletedFirstAttempt) {
          setIsRetake(true);
        } else {
          setIsRetake(false);
          // Fetch existing locked answers for partial attempt
          const locked = await getLockedAnswers(user.uid, lecture.id);
          if (Object.keys(locked).length > 0) {
            dispatch({ type: 'RESTORE_ANSWERS', payload: locked });
          }
        }
      } catch (e) {
        setIsRetake(false);
      }
    };
    checkAttempt();
  }, [lecture.id]);

  const allAnswered = state.answeredCount === questions.length;

  const [loadingQuestionId, setLoadingQuestionId] = useState<string | null>(null);

  const [reportQuestion, setReportQuestion] = useState<MCQQuestion | null>(null);
  const [reportReason, setReportReason] = useState('');
  const [isReporting, setIsReporting] = useState(false);
  const [showReportSuccess, setShowReportSuccess] = useState(false);

  const [editPromptQuestion, setEditPromptQuestion] = useState<MCQQuestion | null>(null);
  const [editPromptText, setEditPromptText] = useState('');
  const [isAiEditing, setIsAiEditing] = useState(false);
  const [showEditSuccess, setShowEditSuccess] = useState(false);
  const [grantAiAccess, setGrantAiAccess] = useState(false);
  const [modifyQuestionCheck, setModifyQuestionCheck] = useState(false);
  const [modifyAnswerCheck, setModifyAnswerCheck] = useState(false);
  const [modifyExplanationCheck, setModifyExplanationCheck] = useState(false);

  const [manualEditQuestion, setManualEditQuestion] = useState<MCQQuestion | null>(null);
  const [isManualEditing, setIsManualEditing] = useState(false);

  // Derive admin
  const isAdmin = user?.role === 'admin';

  const [localQuestions, setLocalQuestions] = useState(questions);
  useEffect(() => { setLocalQuestions(questions) }, [questions]);

  const [isDeletingManual, setIsDeletingManual] = useState(false);

  const deleteManualQuestion = async () => {
    if (!manualEditQuestion || !isAdmin) return;
    setIsDeletingManual(true);
    try {
      const docRef = doc(db, 'lecture_mcqs', lecture.id);
      const newQuestions = localQuestions.filter(q => q.id !== manualEditQuestion.id);

      await updateDoc(docRef, {
        questions: newQuestions
      });

      setLocalQuestions(newQuestions);
      if (onQuestionsUpdated) onQuestionsUpdated(newQuestions);
      setManualEditQuestion(null);
    } catch (e: any) {
      console.error(e);
      alert('فشل الحذف: ' + e.message);
    } finally {
      setIsDeletingManual(false);
    }
  };

  const submitManualEdit = async (updatedData: Partial<MCQQuestion>) => {
    if (!manualEditQuestion || !isAdmin) return;
    setIsManualEditing(true);
    try {
      const docRef = doc(db, 'lecture_mcqs', lecture.id);
      const newQuestions = localQuestions.map(q => 
        q.id === manualEditQuestion.id ? { ...q, ...updatedData } : q
      );

      await updateDoc(docRef, {
        questions: newQuestions
      });

      try {
        const questionText = updatedData.stem || manualEditQuestion.stem;
        let announcementText = `نعتذر عن الخطأ الذي ورد مسبقاً.
تم تصحيح السؤال في محاضرة "${lecture.title}":

${questionText}`;

        await addDoc(collection(db, 'announcements'), {
          type: 'announcement',
          text: announcementText,
          authorName: user?.name || user?.originalName || 'Admin',
          createdAt: serverTimestamp(),
          date: Date.now(),
          // The correction concerns this lecture, so it belongs to the lecture's
          // stage. Without it the announcement is invisible to every reader.
          stageId: lecture.stageId ?? null
        });
      } catch (announcementErr) {
        console.error("Failed to post announcement", announcementErr);
      }

      setLocalQuestions(newQuestions);
      setShowEditSuccess(true);
      setTimeout(() => setShowEditSuccess(false), 3000);
      setManualEditQuestion(null);
    } catch (e) {
      console.error(e);
      alert('حدث خطأ أثناء التعديل');
    } finally {
      setIsManualEditing(false);
    }
  };

  const submitAiEdit = async () => {
    if (!editPromptQuestion || (!editPromptText.trim() && !modifyQuestionCheck && !modifyAnswerCheck && !modifyExplanationCheck) || !isAdmin) return;
    
    let finalPrompt = editPromptText;
    let autoInstructions = [];
    if (modifyQuestionCheck) autoInstructions.push('قم بإعادة صياغة وتغيير نص السؤال (stem) ليكون أفضل وأوضح.');
    if (modifyAnswerCheck) autoInstructions.push('تأكد من صحة الجواب الصحيح (correctAnswer)، وقم بتعديل وتغيير الخيارات (options) لجعلها أكثر دقة.');
    if (modifyExplanationCheck) autoInstructions.push('أضف شرحاً علمياً مفصلاً (explanation) للإجابة.');
    if (autoInstructions.length > 0) {
      finalPrompt += '\n\nمطلوب بشكل إجباري:\n- ' + autoInstructions.join('\n- ');
    }
    setIsAiEditing(true);
    try {
      const { modifyQuestionWithAI, updateLectureMCQSet } = await import('../../services/mcqGenerationService');
      
      // lecture.id, not lecture.pdfUrl - the server resolves the PDF itself so
      // no caller can hand it an arbitrary URL to fetch.
      const newQuestionData = await modifyQuestionWithAI(editPromptQuestion, finalPrompt, grantAiAccess ? lecture.id : undefined);
      const updatedQuestions = localQuestions.map(q => q.id === editPromptQuestion.id ? { ...q, ...newQuestionData } : q);
      
      await updateLectureMCQSet(lecture.id, updatedQuestions);
      
      setLocalQuestions(updatedQuestions);
      if (onQuestionsUpdated) onQuestionsUpdated(updatedQuestions);
      setEditPromptQuestion(null);
      setEditPromptText('');
      setShowEditSuccess(true);
      setTimeout(() => setShowEditSuccess(false), 3000);
    } catch (e: any) {
      console.error(e);
      alert('فشل التعديل بالذكاء الاصطناعي: ' + e.message);
    } finally {
      setIsAiEditing(false);
    }
  };

  const handleReport = (q: MCQQuestion) => {
    setReportQuestion(q);
    setReportReason('');
  };

  const submitReport = async () => {
    if (!reportQuestion || !reportReason.trim()) return;
    setIsReporting(true);
    try {
      const { reportBankQuestion } = await import('../../services/questionBankService');
      const { auth } = await import('../../lib/firebase');
      const userName = user?.name || auth.currentUser?.displayName || auth.currentUser?.email || 'طالب';
      await reportBankQuestion(reportQuestion.id, reportReason, reportQuestion.stem, userName);
      setReportQuestion(null);
      setShowReportSuccess(true);
      setTimeout(() => setShowReportSuccess(false), 3000);
    } catch (e: any) {
      console.error(e);
    } finally {
      setIsReporting(false);
    }
  };

  const handleSelect = async (questionId: string, choiceLabel: string, expectedAnswer: string, index: number) => {
    if (state.answers[questionId]?.answered || loadingQuestionId === questionId) return;
    
    let isCorrect = choiceLabel === expectedAnswer;
    
    // Only lock per-question for the first attempt
    if (isRetake === false) {
      setLoadingQuestionId(questionId);
      try {
        const user = auth.currentUser;
        const questionData = questions.find(q => q.id === questionId);
        
        const lockPromise = lockSingleAnswer(
          user?.uid || '',
          lecture.id,
          questionId,
          choiceLabel,
          isCorrect,
          questionData?.explanation || '',
          expectedAnswer
        );

        // Max wait time of 4 seconds so the UI does not get stuck for the user
        const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), 4000));
        
        const res: any = await Promise.race([lockPromise, timeoutPromise]);

        // In case server overrides correct status
        if (res && res.isCorrect !== undefined) {
          isCorrect = res.isCorrect;
        }
      } catch (err) {
        console.warn("Failed locking answer", err);
      } finally {
        setLoadingQuestionId(null);
      }
    }

    // Analytics
    trackEvent('mcq_question_answered', { questionId, isCorrect });
    
    dispatch({ type: 'SELECT_ANSWER', payload: { questionId, selected: choiceLabel, isCorrect } });

    // Auto scroll to next unanswered after 400ms
    setTimeout(() => {
      // If this was the last question overall, and now all answered, scroll to bottom
      if (state.answeredCount + 1 === questions.length) {
         if (containerRef.current) {
            containerRef.current.scrollTo({ top: containerRef.current.scrollHeight, behavior: 'smooth' });
         }
         return;
      }

      // Find next unanswered
      let nextIndex = index + 1;
      while (nextIndex < questions.length) {
        if (!state.answers[questions[nextIndex].id]?.answered) {
          questionRefs.current[nextIndex]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          break;
        }
        nextIndex++;
      }
    }, 400);
  };

  const handleFinish = async () => {
    setIsFinishing(true);
    let correctCount = 0;
    Object.values(state.answers).forEach((a: any) => { if (a.isCorrect) correctCount++ });
    const score = (correctCount / questions.length) * 100;
    
    trackEvent('mcq_quiz_completed', { lectureId: lecture.id, score });
    try {
      const waitPromise = onFinish(state.answers, correctCount, score);
      const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), 8000));
      await Promise.race([waitPromise, timeoutPromise]);
    } finally {
      setIsFinishing(false);
    }
  };

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    // Show FAB if scrolled past ~ 5 questions (rough estimate 5 * 300px = 1500px)
    if (e.currentTarget.scrollTop > 800) {
      setShowFab(true);
    } else {
      setShowFab(false);
    }
  };

  const scrollToTop = () => {
    if (containerRef.current) {
      containerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const jumpTo = (index: number) => {
    setShowDrawer(false);
    questionRefs.current[index]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div className="flex flex-col h-full bg-stone-50 dark:bg-zinc-900 overflow-hidden relative" dir="rtl">
      
      {/* Sticky Header */}
      <div className="bg-white dark:bg-zinc-800 border-b border-slate-100 dark:border-zinc-700 z-30 shrink-0 px-4 pt-[max(env(safe-area-inset-top),0.75rem)] pb-3 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <button onClick={onClose} className="p-2 -mr-2 text-slate-400 hover:text-slate-600 dark:hover:text-white rounded-full transition-colors">
            <X className="w-6 h-6" />
          </button>
          
          <div className="flex-1 px-3 text-center">
             <h2 className="font-bold text-sm sm:text-base text-slate-800 dark:text-stone-100 truncate" dir="auto">
               {lecture.title}
             </h2>
             <span className="text-xs text-slate-500 font-medium">{questions.length} سؤال</span>
          </div>

          <button 
             onClick={() => setShowDrawer(true)}
             className="p-2 -ml-2 bg-slate-100 dark:bg-zinc-700 text-slate-600 dark:text-slate-300 rounded-full hover:bg-slate-200 transition-colors"
          >
             <ChevronUp className="w-5 h-5 rotate-180" />
          </button>
        </div>
        
        <div className="flex items-center justify-between text-xs font-bold">
           {isRetake === null ? (
              <div className="w-20 h-5 bg-slate-100 dark:bg-zinc-700 animate-pulse rounded" />
           ) : isRetake ? (
              <span className="px-2.5 py-1 bg-slate-100 text-slate-600 dark:bg-zinc-700 dark:text-slate-400 rounded-lg">إعادة — لا تؤثر على ترتيبك</span>
           ) : (
              <span className="px-2.5 py-1 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 rounded-lg flex items-center gap-1">🏆 أول محاولة</span>
           )}
           <span className="text-slate-500 dark:text-slate-400">أجبت على {state.answeredCount} من {questions.length}</span>
        </div>
      </div>

      {/* Scrollable Body */}
      <div 
         ref={containerRef}
         onScroll={handleScroll}
         className="flex-1 overflow-y-auto px-3 sm:px-4 py-6 scroll-smooth"
      >
        <div className="max-w-2xl mx-auto space-y-3 pb-[150px]">
          {localQuestions.map((question, index) => {
            const answerState = state.answers[question.id];
            const isAnswered = !!answerState;

            return (
              <div 
                key={question.id} 
                ref={el => questionRefs.current[index] = el}
                className="bg-white dark:bg-zinc-800 rounded-2xl p-4 sm:p-5 shadow-sm border border-slate-100 dark:border-zinc-700 relative overflow-hidden"
              >
                {/* Meta details */}
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                     <span className="font-bold text-sm text-slate-700 dark:text-slate-300 flex items-center gap-1">
                       Q{index + 1} 
                       <span className="text-slate-300 dark:text-zinc-600 px-1">·</span>
                       <span className="text-xs">
                          {question.difficulty === 'easy' ? 'سهل 🟢' : question.difficulty === 'medium' ? 'متوسط 🟡' : 'صعب 🔴'}
                       </span>
                     </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {isAdmin && (
                      <>
                        <button 
                          onClick={(e) => { e.stopPropagation(); setManualEditQuestion(question); }}
                          className="text-xs font-bold text-slate-600 hover:text-slate-800 bg-slate-100 hover:bg-slate-200 dark:bg-slate-700 dark:hover:bg-slate-600 dark:text-slate-300 px-2 py-1 flex items-center gap-1 rounded-md transition-colors"
                          title="تعديل يدوي"
                        >
                          <Edit2 className="w-3 h-3" />
                          تعديل
                        </button>
                        <button 
                          onClick={(e) => { e.stopPropagation(); setEditPromptQuestion(question); }}
                          className="text-xs font-bold text-sky-600 hover:text-sky-800 bg-sky-50 hover:bg-sky-100 dark:bg-sky-900/30 dark:text-sky-400 px-2 py-1 flex items-center gap-1 rounded-md transition-colors"
                          title="تعديل بالذكاء الاصطناعي"
                        >
                          <MessageSquare className="w-3 h-3" />
                          AI
                        </button>
                      </>
                    )}
                    <button 
                      onClick={(e) => { e.stopPropagation(); handleReport(question); }}
                      className="text-xs font-bold text-red-500 hover:text-red-700 bg-red-50 hover:bg-red-100 px-2 py-1 flex items-center gap-1 rounded-md transition-colors"
                      title="الإبلاغ عن خطأ"
                    >
                      <AlertTriangle className="w-3 h-3" />
                      بلاغ
                    </button>
                    {isAnswered && (
                       <motion.div 
                         initial={{ opacity: 0, scale: 0.8 }}
                         animate={{ opacity: 1, scale: 1 }}
                         className="flex items-center gap-1 font-bold text-sm"
                       >
                          {answerState.isCorrect ? (
                             <span className="text-green-600 dark:text-green-500 flex items-center gap-1">صحيح <Check className="w-4 h-4"/></span>
                          ) : (
                             <span className="text-red-600 dark:text-red-500 flex items-center gap-1">خطأ <X className="w-4 h-4"/></span>
                          )}
                       </motion.div>
                    )}
                  </div>
                </div>
                
                {/* Stem */}
                <h3 className="text-[17px] sm:text-lg font-bold text-slate-900 dark:text-white leading-relaxed mb-5 select-none" dir="auto" onContextMenu={(e) => e.preventDefault()}>
                  {question.stemFormat === 'except' && <span className="inline-block px-1.5 py-0.5 mr-2 bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 text-xs font-black rounded uppercase">Except</span>}
                  {question.stemFormat === 'regarding' && <span className="inline-block px-1.5 py-0.5 mr-2 bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400 text-xs font-black rounded uppercase">Regarding</span>}
                  {question.stem}
                </h3>

                {question.imageUrl && (
                  <div className="mb-5 bg-slate-50 dark:bg-zinc-800 rounded-xl overflow-hidden border border-slate-100 dark:border-zinc-700 flex justify-center p-2 isolate relative" onContextMenu={(e) => e.preventDefault()}>
                     <img src={question.imageUrl} alt="Question Graphic" className="max-h-[300px] object-contain select-none pointer-events-none" />
                  </div>
                )}

                {/* Choices */}
                <div className="space-y-2">
                  {question.type === 'true_false' ? (
                    <>
                      <ChoiceRow 
                        label="True" text="صحيح" expected={question.correctAnswer} 
                        isAnswered={isAnswered} answerState={answerState} 
                        isLoading={loadingQuestionId === question.id}
                        onSelect={() => handleSelect(question.id, 'True', question.correctAnswer, index)} />
                      <ChoiceRow 
                        label="False" text="خطأ" expected={question.correctAnswer} 
                        isAnswered={isAnswered} answerState={answerState} 
                        isLoading={loadingQuestionId === question.id}
                        onSelect={() => handleSelect(question.id, 'False', question.correctAnswer, index)} />
                    </>
                  ) : (
                    question.choices.map(c => (
                      <ChoiceRow 
                        key={c.label} label={c.label} text={c.text} expected={question.correctAnswer}
                        isAnswered={isAnswered} answerState={answerState}
                        isLoading={loadingQuestionId === question.id}
                        onSelect={() => handleSelect(question.id, c.label, question.correctAnswer, index)}
                      />
                    ))
                  )}
                </div>

                {/* Explanation */}
                <AnimatePresence>
                  {isAnswered && (
                    <motion.div
                      initial={{ opacity: 0, height: 0, marginTop: 0 }}
                      animate={{ opacity: 1, height: 'auto', marginTop: 16 }}
                      exit={{ opacity: 0, height: 0 }}
                      className="overflow-hidden"
                    >
                      <div className="bg-[#FFFDE7] dark:bg-amber-900/10 border border-amber-200/50 dark:border-amber-900/30 rounded-xl p-4">
                        <div className="flex gap-2 items-start">
                          <span className="text-xl leading-none shadow-sm">💡</span>
                          <div>
                            <span className="font-bold text-amber-900 dark:text-amber-500 text-sm block mb-1">الشرح:</span>
                            <p className="text-amber-950/80 dark:text-amber-200/80 text-sm leading-relaxed" dir="rtl">
                              {question.explanation}
                            </p>
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      </div>

      {/* Sticky Footer */}
      <AnimatePresence>
         {allAnswered && (
            <motion.div 
               initial={{ y: 150 }}
               animate={{ y: 0 }}
               exit={{ y: 150 }}
               transition={{ type: 'spring', damping: 25, stiffness: 200 }}
               className="absolute bottom-0 left-0 w-full bg-white dark:bg-zinc-800 border-t border-slate-100 dark:border-zinc-700 p-4 sm:p-5 z-40 rounded-t-3xl shadow-[0_-10px_20px_rgba(0,0,0,0.05)] dark:shadow-[0_-10px_20px_rgba(0,0,0,0.2)]"
            >
               <div className="max-w-2xl mx-auto flex flex-col items-center gap-3">
                  <span className="font-bold text-slate-800 dark:text-slate-200 flex items-center gap-2">
                     🎉 أجبت على كل الأسئلة!
                  </span>
                  <button 
                     onClick={handleFinish}
                     disabled={isFinishing}
                     className={`w-full py-4 bg-sky-500 text-white font-bold text-lg rounded-xl shadow-md shadow-sky-500/20 transition-transform ${isFinishing ? 'opacity-70 cursor-wait' : 'hover:bg-sky-600 active:scale-95'}`}
                  >
                     {isFinishing ? <Loader2 className="w-6 h-6 animate-spin mx-auto" /> : 'إنهاء وعرض النتيجة'}
                  </button>
               </div>
            </motion.div>
         )}
      </AnimatePresence>

      {/* Scroll to top FAB */}
      <AnimatePresence>
        {showFab && (
          <motion.button
            initial={{ opacity: 0, scale: 0.5, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.5, y: 20 }}
            onClick={scrollToTop}
            className={`absolute ${allAnswered ? 'bottom-32' : 'bottom-6'} right-6 w-12 h-12 bg-white dark:bg-zinc-700 text-slate-800 dark:text-white rounded-full shadow-xl flex items-center justify-center border border-slate-100 dark:border-zinc-600 z-30 transition-all hover:bg-slate-50`}
          >
            <ArrowUp className="w-5 h-5" />
          </motion.button>
        )}
      </AnimatePresence>

      {/* Overview Drawer */}
      <AnimatePresence>
        {showDrawer && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowDrawer(false)}
              className="absolute inset-0 bg-black/40 z-50 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="absolute bottom-0 w-full bg-white dark:bg-zinc-800 rounded-t-3xl p-6 pb-[calc(3rem+env(safe-area-inset-bottom))] z-50 max-h-[80vh] overflow-y-auto"
            >
              <div className="flex items-center justify-between mb-6">
                <h3 className="font-bold text-lg dark:text-white">نظرة عامة على الأسئلة</h3>
                <button onClick={() => setShowDrawer(false)} className="p-2 bg-slate-100 dark:bg-zinc-700 rounded-full text-slate-500">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="grid grid-cols-5 sm:grid-cols-10 gap-3" dir="ltr">
                {questions.map((q, idx) => {
                   const ans = state.answers[q.id];
                   let circleClass = "bg-slate-100 dark:bg-zinc-700 text-slate-400";
                   if (ans) {
                     circleClass = ans.isCorrect ? "bg-green-500 text-white shadow-md shadow-green-500/20" : "bg-red-500 text-white shadow-md shadow-red-500/20";
                   }
                   
                   return (
                     <button
                       key={q.id}
                       onClick={() => jumpTo(idx)}
                       className={`w-12 h-12 rounded-xl font-bold flex items-center justify-center transition-all ${circleClass}`}
                     >
                       {idx + 1}
                     </button>
                   );
                })}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Anti-cheat Alert Modal */}
      <AnimatePresence>
        {showAntiCheatAlert && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" dir="rtl">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: -10 }}
              className="bg-white dark:bg-zinc-900 rounded-3xl w-full max-w-sm overflow-hidden shadow-2xl relative"
            >
              <div className="absolute top-0 left-0 w-full h-1 bg-red-500" />
              <div className="p-6 text-center">
                <div className="w-16 h-16 bg-red-100 dark:bg-red-900/30 rounded-2xl flex items-center justify-center mx-auto mb-5 rotate-12">
                  <ShieldAlert className="w-8 h-8 text-red-600 dark:text-red-400 -rotate-12" />
                </div>
                
                <h3 className="text-xl font-black text-slate-900 dark:text-white mb-2">
                  تحذير أمني
                </h3>
                <p className="text-slate-600 dark:text-slate-400 mb-6 leading-relaxed">
                  تم اكتشاف محاولة التقاط شاشة أو تسجيل. هذا الإجراء مخالف لسياسة المنصة وقد يؤدي تكراره إلى <span className="font-bold text-red-500">حظر الحساب والفصل</span>.
                </p>
                
                <button
                  onClick={() => setShowAntiCheatAlert(false)}
                  className="w-full py-3 bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400 font-bold rounded-xl hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors"
                >
                  حسناً، فهمت
                </button>
              </div>
            </motion.div>
          </div>
        )}

        {manualEditQuestion && (
          <MCQManualEditModal
            question={manualEditQuestion}
            onClose={() => setManualEditQuestion(null)}
            onSubmit={submitManualEdit}
            isSubmitting={isManualEditing}
            onDelete={deleteManualQuestion}
            isDeleting={isDeletingManual}
          />
        )}

        {reportQuestion && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" dir="rtl">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white dark:bg-zinc-900 rounded-3xl p-6 w-full max-w-md shadow-xl border border-slate-100 dark:border-zinc-800"
            >
              <div className="flex items-center gap-3 mb-4 text-red-600 dark:text-red-500">
                <AlertTriangle className="w-8 h-8" />
                <h3 className="font-bold text-xl">الإبلاغ عن خطأ</h3>
              </div>
              <p className="text-sm font-bold text-slate-600 dark:text-slate-400 mb-4 bg-slate-50 dark:bg-zinc-800 p-3 rounded-xl border border-slate-100 dark:border-zinc-700 max-h-32 overflow-y-auto" dir="auto">
                {reportQuestion.stem}
              </p>
              <div className="mb-6">
                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
                  ما هو الخطأ في هذا السؤال؟ (الرجاء التوضيح)
                </label>
                <textarea 
                  value={reportReason}
                  onChange={e => setReportReason(e.target.value)}
                  className="w-full p-4 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 text-slate-900 dark:text-white resize-none outline-none focus:ring-2 focus:ring-red-500/50"
                  rows={3}
                  placeholder="مثال: الإجابة الصحيحة تعتبر واضحة لكنها محددة كخاطئة..."
                />
              </div>
              <div className="flex gap-3">
                <button 
                  onClick={() => setReportQuestion(null)}
                  className="flex-1 py-3 px-4 font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 rounded-xl transition-colors"
                  disabled={isReporting}
                >
                  إلغاء
                </button>
                <button 
                  onClick={submitReport}
                  disabled={!reportReason.trim() || isReporting}
                  className="flex-1 py-3 px-4 font-bold text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded-xl transition-colors"
                >
                  {isReporting ? 'جاري الإرسال...' : 'إرسال التقرير'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {editPromptQuestion && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" dir="rtl">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white dark:bg-zinc-900 rounded-3xl p-6 w-full max-w-md shadow-xl border border-slate-100 dark:border-zinc-800"
            >
              <div className="flex items-center gap-3 mb-4 text-sky-600 dark:text-sky-500">
                <MessageSquare className="w-8 h-8" />
                <h3 className="font-bold text-xl">تعديل بالذكاء الاصطناعي</h3>
              </div>
              <p className="text-sm font-bold text-slate-600 dark:text-slate-400 mb-4 bg-slate-50 dark:bg-zinc-800 p-3 rounded-xl border border-slate-100 dark:border-zinc-700 max-h-32 overflow-y-auto" dir="auto">
                {editPromptQuestion.stem}
              </p>
              <div className="mb-6">
                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
                  ما الذي تريد تعديله في هذا السؤال عبر الذكاء الاصطناعي؟
                </label>
                <textarea 
                  value={editPromptText}
                  onChange={e => setEditPromptText(e.target.value)}
                  className="w-full p-4 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 text-slate-900 dark:text-white resize-none outline-none focus:ring-2 focus:ring-sky-500/50"
                  rows={3}
                  placeholder="مثال: أضف شرحاً مفصلاً لهذا السؤال، اجعله أسهل..."
                />
              </div>

              
              <div className="flex flex-col gap-3 mb-6">
                <label className="flex items-center gap-2 cursor-pointer">
                  <div className="relative flex items-center">
                    <input type="checkbox" className="sr-only peer" checked={modifyQuestionCheck} onChange={(e) => setModifyQuestionCheck(e.target.checked)} />
                    <div className="w-10 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-sky-500/50 rounded-full peer dark:bg-zinc-700 peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:right-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-zinc-600 peer-checked:bg-sky-500 origin-right"></div>
                  </div>
                  <span className="text-sm font-bold text-slate-700 dark:text-slate-300 select-none text-right">تعديل السؤال نفسه</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <div className="relative flex items-center">
                    <input type="checkbox" className="sr-only peer" checked={modifyAnswerCheck} onChange={(e) => setModifyAnswerCheck(e.target.checked)} />
                    <div className="w-10 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-sky-500/50 rounded-full peer dark:bg-zinc-700 peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:right-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-zinc-600 peer-checked:bg-sky-500 origin-right"></div>
                  </div>
                  <span className="text-sm font-bold text-slate-700 dark:text-slate-300 select-none text-right">تعديل الجواب الصحيح والخيارات</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <div className="relative flex items-center">
                    <input type="checkbox" className="sr-only peer" checked={modifyExplanationCheck} onChange={(e) => setModifyExplanationCheck(e.target.checked)} />
                    <div className="w-10 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-sky-500/50 rounded-full peer dark:bg-zinc-700 peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:right-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-zinc-600 peer-checked:bg-sky-500 origin-right"></div>
                  </div>
                  <span className="text-sm font-bold text-slate-700 dark:text-slate-300 select-none text-right">تعديل الشرح للتوضيح</span>
                </label>
              </div>
              <label className="flex items-center gap-2 mb-6 cursor-pointer">
                <div className="relative flex items-center">
                  <input type="checkbox" className="sr-only peer" checked={grantAiAccess} onChange={(e) => setGrantAiAccess(e.target.checked)} />
                  <div className="w-10 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-sky-500/50 rounded-full peer dark:bg-zinc-700 peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:right-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-zinc-600 peer-checked:bg-sky-500 origin-right"></div>
                </div>
                <span className="text-sm font-bold text-slate-700 dark:text-slate-300 select-none text-right">
                  منح الذكاء الاصطناعي صلاحية الوصول إلى المحاضرة الحالية
                </span>
              </label>

              <div className="flex gap-3">
                <button 
                  onClick={() => setEditPromptQuestion(null)}
                  className="flex-1 py-3 px-4 rounded-xl font-bold bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors"
                  disabled={isAiEditing}
                >
                  إلغاء
                </button>
                <button 
                  onClick={submitAiEdit}
                  disabled={(!editPromptText.trim() && !modifyQuestionCheck && !modifyAnswerCheck && !modifyExplanationCheck) || isAiEditing}
                  className="flex-1 py-3 px-4 rounded-xl font-bold bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
                >
                  {isAiEditing ? <Loader2 className="w-5 h-5 animate-spin" /> : 'تطبيق التعديل'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {showReportSuccess && (
        <div className="fixed bottom-[calc(2.5rem+env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 z-[300] bg-emerald-600 text-white px-6 py-3 rounded-full font-bold shadow-lg flex items-center gap-2">
          <CheckCircle className="w-5 h-5" />
          تم إرسال التقرير بنجاح، شكراً لك!
        </div>
      )}
      
      {showEditSuccess && (
        <div className="fixed bottom-[calc(2.5rem+env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 z-[300] bg-sky-600 text-white px-6 py-3 rounded-full font-bold shadow-lg flex items-center gap-2">
          <CheckCircle className="w-5 h-5" />
          تم التعديل الذكي بنجاح
        </div>
      )}
    </div>
  );
}

// Sub-component for individual choices
function ChoiceRow({ label, text, expected, isAnswered, answerState, onSelect, isLoading }: any) {
  const isSelected = answerState?.selected === label;
  const isCorrectOption = expected === label;
  
  let barWidth = "0%";
  let bgFill = "bg-transparent";
  let suffix = "";
  
  if (isAnswered) {
    if (isCorrectOption) {
      barWidth = "100%";
      bgFill = "bg-green-100 dark:bg-green-900/30";
      suffix = "✅";
    } else if (isSelected) {
      barWidth = "100%";
      bgFill = "bg-red-100 dark:bg-red-900/30";
      suffix = "❌";
    } else {
      bgFill = "bg-transparent";
    }
  }

  return (
    <motion.button
      whileTap={!isAnswered && !isLoading ? { scale: 0.97 } : {}}
      onClick={onSelect}
      disabled={isAnswered || isLoading}
      className={`w-full relative text-left rounded-xl transition-all overflow-hidden border ${
        isAnswered 
          ? (isCorrectOption ? 'border-green-200 dark:border-green-800' : isSelected ? 'border-red-200 dark:border-red-800' : 'border-transparent')
          : 'border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-700/50'
      } ${isLoading ? 'opacity-70 cursor-wait' : ''}`}
      dir="auto"
    >
      {/* Background fill for Telegram style */}
      {isAnswered && (
         <motion.div 
           initial={{ width: '0%' }}
           animate={{ width: barWidth }}
           transition={{ duration: 0.3, ease: 'easeOut' }}
           className={`absolute inset-0 z-0 ${bgFill}`}
         />
      )}
      
      <div className="relative z-10 p-3 sm:p-4 flex items-center gap-3">
        {!isAnswered ? (
           <div className="w-5 h-5 rounded-full border-2 border-slate-300 dark:border-zinc-600 flex-shrink-0 flex items-center justify-center">
             {isLoading && <Loader2 className="w-3 h-3 text-slate-400 animate-spin" />}
           </div>
        ) : (
           <div className="w-5 flex items-center justify-center font-bold text-sm flex-shrink-0">
             {isCorrectOption ? '100%' : isSelected ? '100%' : '0%'}
           </div>
        )}
        
        <div className="flex-1 text-sm sm:text-base font-medium text-slate-700 dark:text-slate-200 pr-2 select-none" onContextMenu={(e) => e.preventDefault()}>
          {text}
        </div>
        
        {isAnswered && suffix && (
          <div className="flex-shrink-0 flex items-center justify-center bg-white/50 dark:bg-black/20 rounded-full p-0.5 select-none text-xl lg:text-lg text-lg">
            {suffix}
          </div>
        )}
      </div>
    </motion.button>
  );
}
