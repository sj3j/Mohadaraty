import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Check, X, ArrowRight, CheckCircle, AlertTriangle, MessageSquare, Loader2 } from 'lucide-react';
import { BankQuestion } from '../../types/questionBank.types';
import { saveUserBankAnswer } from '../../services/questionBankService';
import { ConfirmModal } from '../ui/ConfirmModal';
import BankQuestionManualEditModal from './BankQuestionManualEditModal';

interface Props {
  onQuestionsUpdated?: (questions: any[]) => void;
  questions: BankQuestion[];
  onFinish: () => void;
  onBack: () => void;
  userId: string;
  userName?: string;
  isAdmin?: boolean;
}

export default function BankQuizScreen({ questions: initialQuestions, onFinish, onBack, userId, userName, isAdmin, onQuestionsUpdated }: Props) {
  const [questions, setQuestions] = useState(initialQuestions);
  const [sessionId] = useState(() => Math.random().toString(36).substring(7));
  const [answers, setAnswers] = useState<Record<string, string>>({}); 
  const [isFinished, setIsFinished] = useState(false);
  const [score, setScore] = useState(0);
  const [showConfirmFinish, setShowConfirmFinish] = useState(false);
  const [reportQuestion, setReportQuestion] = useState<BankQuestion | null>(null);
  const [reportReason, setReportReason] = useState('');
  const [isReporting, setIsReporting] = useState(false);
  const [showReportSuccess, setShowReportSuccess] = useState(false);
  
  const [manualEditQuestion, setManualEditQuestion] = useState<BankQuestion | null>(null);
  const [isManualEditing, setIsManualEditing] = useState(false);

  const [editPromptQuestion, setEditPromptQuestion] = useState<BankQuestion | null>(null);
  const [editPromptText, setEditPromptText] = useState('');
  const [isAiEditing, setIsAiEditing] = useState(false);
  const [showEditSuccess, setShowEditSuccess] = useState(false);
  const [grantAiAccess, setGrantAiAccess] = useState(false);
  const [modifyQuestionCheck, setModifyQuestionCheck] = useState(false);
  const [modifyAnswerCheck, setModifyAnswerCheck] = useState(false);
  const [modifyExplanationCheck, setModifyExplanationCheck] = useState(false);

  const [isDeletingManual, setIsDeletingManual] = useState(false);

  const deleteManualQuestion = async () => {
    if (!manualEditQuestion || !isAdmin) return;
    setIsDeletingManual(true);
    try {
      const { softDeleteBankQuestion } = await import('../../services/questionBankService');
      await softDeleteBankQuestion(manualEditQuestion.id);
      
      const newQuestions = questions.filter(q => q.id !== manualEditQuestion.id);
      setQuestions(newQuestions);
      if (onQuestionsUpdated) onQuestionsUpdated(newQuestions);
      setManualEditQuestion(null);
    } catch (e: any) {
      console.error(e);
      alert('فشل الحذف: ' + e.message);
    } finally {
      setIsDeletingManual(false);
    }
  };

  const submitManualEdit = async (updatedData: Partial<BankQuestion>) => {
    if (!manualEditQuestion || !isAdmin) return;
    setIsManualEditing(true);
    try {
      const { editBankQuestion } = await import('../../services/questionBankService');
      await editBankQuestion(manualEditQuestion.id, updatedData);
      
      const newQuestions = questions.map(q => q.id === manualEditQuestion.id ? { ...q, ...updatedData } : q);
      setQuestions(newQuestions);
      if (onQuestionsUpdated) onQuestionsUpdated(newQuestions);

      try {
        const { getDoc, doc, addDoc, collection, serverTimestamp } = await import('firebase/firestore');
        const { db } = await import('../../lib/firebase');
        let lectureTitle = 'محاضرة';
        // The correction belongs to the stage of the lecture it is about; an
        // announcement with no stageId is invisible to every reader.
        let lectureStageId: string | null = null;
        if (manualEditQuestion.lectureId) {
          const lectureDoc = await getDoc(doc(db, 'lectures', manualEditQuestion.lectureId));
          if (lectureDoc.exists()) {
            lectureTitle = lectureDoc.data().title || lectureTitle;
            lectureStageId = lectureDoc.data().stageId ?? null;
          }
        }

        const questionText = updatedData.stem || manualEditQuestion.stem;
        let announcementText = `نعتذر عن الخطأ الذي ورد مسبقاً.
تم تصحيح السؤال في "${lectureTitle}":

${questionText}`;

        await addDoc(collection(db, 'announcements'), {
          type: 'announcement',
          text: announcementText,
          authorName: userName || 'Admin',
          createdAt: serverTimestamp(),
          date: Date.now(),
          stageId: lectureStageId
        });
      } catch (announcementErr) {
        console.error("Failed to post announcement", announcementErr);
      }

      setManualEditQuestion(null);
      setShowEditSuccess(true);
      setTimeout(() => setShowEditSuccess(false), 3000);
    } catch (e: any) {
      console.error(e);
      alert('فشل التعديل اليدوي: ' + e.message);
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
      // This used to fetch the lecture just to read its pdfUrl and pass it on.
      // The server now resolves the PDF from the id, so the round trip is gone
      // and there is no URL for a caller to substitute.
      const groundingLectureId = grantAiAccess ? editPromptQuestion.lectureId : undefined;

      const { modifyQuestionWithAI } = await import('../../services/mcqGenerationService');
      const { editBankQuestion } = await import('../../services/questionBankService');

      const newQuestionData = await modifyQuestionWithAI(editPromptQuestion, finalPrompt, groundingLectureId);
      await editBankQuestion(editPromptQuestion.id, newQuestionData);
      
      const newQuestions = questions.map(q => q.id === editPromptQuestion.id ? { ...q, ...newQuestionData } : q);
      setQuestions(newQuestions);
      if (onQuestionsUpdated) onQuestionsUpdated(newQuestions);
      
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

  const handleAnswer = async (q: BankQuestion, choiceText: string) => {
    if (isFinished || answers[q.id]) return;
    setAnswers(prev => ({ ...prev, [q.id]: choiceText }));
    
    const isCorrect = choiceText === q.correctAnswer;
    if (isCorrect) {
      setScore(s => s + 1);
    }
    await saveUserBankAnswer(userId, q.id, choiceText, isCorrect, sessionId, q.tags);
  };

  const executeFinish = async () => {
    setIsFinished(true);
  };

  const handleFinish = async () => {
    if (Object.keys(answers).length < questions.length) {
      setShowConfirmFinish(true);
      return;
    }
    await executeFinish();
  };

  const handleReport = (q: BankQuestion) => {
    setReportQuestion(q);
    setReportReason('');
  };

  const submitReport = async () => {
    if (!reportQuestion || !reportReason.trim()) return;
    setIsReporting(true);
    try {
      const { reportBankQuestion } = await import('../../services/questionBankService');
      const { auth } = await import('../../lib/firebase');
      const finalUserName = userName || auth.currentUser?.displayName || auth.currentUser?.email || 'طالب';
      await reportBankQuestion(reportQuestion.id, reportReason, reportQuestion.stem, finalUserName);
      setReportQuestion(null);
      setShowReportSuccess(true);
      setTimeout(() => setShowReportSuccess(false), 3000);
    } catch (e: any) {
      console.error(e);
    } finally {
      setIsReporting(false);
    }
  };

  const solvedCount = Object.keys(answers).length;
  const totalCount = questions.length;
  const progressPercent = totalCount > 0 ? (solvedCount / totalCount) * 100 : 0;

  return (
    <motion.div 
      initial={{ x: 20, opacity: 0 }} 
      animate={{ x: 0, opacity: 1 }} 
      exit={{ x: -20, opacity: 0 }}
      className="flex flex-col h-full bg-stone-50 dark:bg-zinc-900 absolute inset-0 z-50"
    >
      <div className="flex flex-col bg-white dark:bg-zinc-800 border-b border-slate-100 dark:border-zinc-700 shadow-sm z-10 shrink-0 relative">
         <div className="flex items-center justify-between p-4 pt-[max(env(safe-area-inset-top),1rem)]">
           <button onClick={onBack} className="p-2 -mr-2 text-slate-400 hover:text-slate-600 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-zinc-700 rounded-full transition-colors">
             <ArrowRight className="w-6 h-6" />
           </button>
           <span className="font-bold text-lg dark:text-white">اختبار مخصص</span>
           <div className="w-10 text-center font-bold text-sm text-slate-500">
             {solvedCount}/{totalCount}
           </div>
         </div>
         {/* Progress Bar */}
         <div className="w-full h-1.5 bg-slate-100 dark:bg-zinc-700">
           <motion.div 
             className="h-full bg-emerald-500"
             initial={{ width: 0 }}
             animate={{ width: `${progressPercent}%` }}
             transition={{ duration: 0.3 }}
           />
         </div>
      </div>

      <div className="flex-1 p-4 sm:p-6 overflow-y-auto space-y-6 pb-20">
        {isFinished && (
           <div className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 p-6 rounded-2xl text-center mb-6">
              <CheckCircle className="w-16 h-16 text-emerald-500 mx-auto mb-4" />
              <h2 className="text-2xl font-black text-emerald-700 dark:text-emerald-400 mb-2">انتهى الاختبار</h2>
              <p className="text-xl font-bold text-slate-800 dark:text-slate-200">
                أجبت على {score}/{questions.length} بشكل صحيح
              </p>
           </div>
        )}

        {questions.map((q, index) => {
          const userAns = answers[q.id];
          
          return (
            <div key={q.id} className="bg-white dark:bg-zinc-800 rounded-3xl p-5 shadow-sm border border-slate-100 dark:border-zinc-700 relative group">
              <div className="absolute top-4 left-4 flex items-center gap-1">
                {isAdmin && (
                  <>
                    <button 
                      onClick={() => setManualEditQuestion(q)} 
                      className="p-1.5 text-slate-300 hover:text-slate-600 hover:bg-slate-100 dark:text-zinc-500 dark:hover:text-slate-300 dark:hover:bg-zinc-700/50 rounded-lg transition-colors flex items-center gap-1"
                      title="تعديل يدوي"
                    >
                      <span className="text-[10px] font-bold">تعديل</span>
                    </button>
                    <button 
                      onClick={() => setEditPromptQuestion(q)} 
                      className="p-1.5 text-slate-300 hover:text-sky-500 hover:bg-sky-50 dark:text-zinc-500 dark:hover:text-sky-400 dark:hover:bg-sky-900/30 rounded-lg transition-colors flex items-center gap-1"
                      title="تعديل بالذكاء الاصطناعي"
                    >
                      <MessageSquare className="w-4 h-4" />
                      <span className="text-[10px] font-bold">AI</span>
                    </button>
                  </>
                )}
                <button 
                  onClick={() => handleReport(q)} 
                  className="p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 dark:text-zinc-500 dark:hover:text-red-400 dark:hover:bg-red-900/30 rounded-lg transition-colors"
                  title="الإبلاغ عن خطأ"
                >
                  <AlertTriangle className="w-5 h-5" />
                </button>
              </div>
              <div className="flex justify-between items-start mb-4 pl-24">
                 <div className="flex flex-wrap gap-2 items-center">
                   <span className="px-3 py-1 bg-slate-100 text-slate-600 dark:bg-zinc-700 dark:text-slate-300 rounded font-bold text-sm">
                     السؤال {index + 1}
                   </span>
                   {q.tags && q.tags.map((tag: string) => (
                     <span key={tag} className="px-2 py-0.5 bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300 border border-sky-200 dark:border-sky-800 rounded text-xs font-bold whitespace-nowrap">
                       {tag.replace('_', ' ')}
                     </span>
                   ))}
                   {q.year && (
                     <span className="px-2 py-0.5 bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 border border-amber-200 dark:border-amber-800 rounded text-xs font-bold whitespace-nowrap">
                       {q.year}
                     </span>
                   )}
                 </div>
                 {userAns && (
                    <span className="font-bold flex items-center gap-1">
                      {userAns === q.correctAnswer ? (
                         <span className="text-emerald-600 flex items-center gap-1"><Check className="w-4 h-4"/> صحيح</span>
                      ) : (
                         <span className="text-red-600 flex items-center gap-1"><X className="w-4 h-4"/> خطأ</span>
                      )}
                    </span>
                 )}
              </div>
              
              <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-4 select-none" dir="auto">{q.stem}</h3>
              
              {q.imageUrl && (
                <div className="mb-5 bg-slate-50 dark:bg-zinc-800 rounded-xl overflow-hidden border border-slate-100 dark:border-zinc-700 flex justify-center p-2 isolate relative" onContextMenu={(e) => e.preventDefault()}>
                   <img src={q.imageUrl} alt="Question Graphic" className="max-h-[300px] object-contain select-none pointer-events-none" />
                </div>
              )}

              <div className="space-y-2">
                {q.choices.map((c, i) => {
                  let btnClass = "w-full text-right p-4 rounded-2xl font-bold transition-all border-2 ";
                  const isSelected = userAns === c.text;
                  const isActualCorrect = c.text === q.correctAnswer;
                  const hasAnswered = !!userAns;

                  if (!hasAnswered) {
                    if (isSelected) {
                      btnClass += "border-sky-500 bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:border-sky-400 dark:text-sky-300";
                    } else {
                      btnClass += "border-slate-200 bg-white hover:bg-slate-50 text-slate-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-slate-300";
                    }
                  } else {
                    if (isActualCorrect) {
                      btnClass += "bg-emerald-50 border-emerald-500 text-emerald-700 dark:bg-emerald-500/20";
                    } else if (isSelected) {
                      btnClass += "bg-red-50 border-red-500 text-red-700 dark:bg-red-500/20";
                    } else {
                      btnClass += "bg-stone-50 border-transparent text-slate-500 opacity-50 dark:bg-zinc-900";
                    }
                  }

                  return (
                    <button
                      key={i}
                      onClick={() => handleAnswer(q, c.text)}
                      disabled={hasAnswered || isFinished}
                      className={btnClass}
                      dir="auto"
                    >
                       {c.text}
                    </button>
                  );
                })}
              </div>

              {userAns && q.explanation && (
                <motion.div 
                  initial={{ opacity: 0, height: 0 }} 
                  animate={{ opacity: 1, height: 'auto' }} 
                  className="mt-4 p-4 bg-sky-50 dark:bg-sky-900/20 border border-sky-100 dark:border-sky-900/50 rounded-2xl"
                >
                  <p className="text-sm font-bold text-sky-800 dark:text-sky-300">💡 توضيح:</p>
                  <p className="text-sm text-sky-700 dark:text-sky-400 mt-2 font-medium" dir="auto">{q.explanation}</p>
                </motion.div>
              )}
            </div>
          );
        })}
      </div>

      {!isFinished && (
        <div className="p-6 bg-white dark:bg-zinc-800 border-t border-slate-100 dark:border-zinc-700">
          <button 
            onClick={handleFinish}
            className="w-full py-4 bg-emerald-600 hover:bg-emerald-700 text-white font-black text-lg rounded-2xl transition-colors shadow-lg shadow-emerald-500/20"
          >
            إنهاء الاختبار
          </button>
        </div>
      )}
      
      <ConfirmModal
        isOpen={showConfirmFinish}
        onClose={() => setShowConfirmFinish(false)}
        onConfirm={executeFinish}
        title="إنهاء الاختبار"
        message="هناك أسئلة لم تقم بالإجابة عليها، هل أنت متأكد من رغبتك في إنهاء الاختبار الآن؟"
        confirmText="نعم، إنهاء الاختبار"
        cancelText="العودة للاختبار"
        isDestructive={false}
      />

      {manualEditQuestion && (
        <BankQuestionManualEditModal
          question={manualEditQuestion}
          onClose={() => setManualEditQuestion(null)}
          onSubmit={submitManualEdit}
          isSubmitting={isManualEditing}
          onDelete={deleteManualQuestion}
          isDeleting={isDeletingManual}
        />
      )}

      {editPromptQuestion && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" dir="rtl">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
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
            
            {(editPromptQuestion.lectureId || true) && (
              <>
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
                  منح الذكاء الاصطناعي صلاحية الوصول إلى المحاضرة المحددة (إن وجدت)
                </span>
              </label>
              </>
            )}

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

      {reportQuestion && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" dir="rtl">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
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

      {showReportSuccess && (
        <div className="fixed bottom-[calc(2.5rem+env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 z-[300] bg-emerald-600 text-white px-6 py-3 rounded-full font-bold shadow-lg flex items-center gap-2">
          <CheckCircle className="w-5 h-5" />
          تم إرسال التقرير بنجاح، شكراً لك!
        </div>
      )}
    </motion.div>
  );
}
