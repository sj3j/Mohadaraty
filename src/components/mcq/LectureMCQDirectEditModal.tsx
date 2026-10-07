import React, { useState } from 'react';
import { MCQQuestion, MCQChoice, MCQDifficulty, MCQStemFormat } from '../../types/mcq.types';
import { X, Loader2, ImagePlus, ShieldAlert, CheckCircle, Send } from 'lucide-react';
import { motion } from 'motion/react';
import { uploadBytes, getDownloadURL, ref } from 'firebase/storage';
import { storage } from '../../lib/firebase';
import { v4 as uuidv4 } from 'uuid';
import { getExistingMCQsForLecture, updateLectureMCQSet } from '../../services/mcqGenerationService';
import { replyToQuestionReport } from '../../services/questionBankService';

interface Props {
  isOpen: boolean;
  lectureId: string;
  lectureTitle?: string;
  question: MCQQuestion;
  alertData?: any;
  onClose: () => void;
  onSaved: () => void;
}

export default function LectureMCQDirectEditModal({
  isOpen,
  lectureId,
  lectureTitle,
  question,
  alertData,
  onClose,
  onSaved
}: Props) {
  const [stem, setStem] = useState(question.stem);
  const [stemFormat, setStemFormat] = useState<MCQStemFormat>(question.stemFormat || 'standard');
  const [explanation, setExplanation] = useState(question.explanation || '');
  const [difficulty, setDifficulty] = useState<MCQDifficulty>(question.difficulty || 'medium');
  const [correctAnswer, setCorrectAnswer] = useState(question.correctAnswer || 'A');
  const [imageUrl, setImageUrl] = useState(question.imageUrl || '');
  const [uploadingImage, setUploadingImage] = useState(false);

  // Choices
  const [choices, setChoices] = useState<MCQChoice[]>(
    question.type === 'mcq' && question.choices?.length
      ? [...question.choices]
      : [
          { label: 'A', text: '' },
          { label: 'B', text: '' },
          { label: 'C', text: '' },
          { label: 'D', text: '' },
          { label: 'E', text: '' }
        ]
  );

  // Resolution & Reply
  const [replyText, setReplyText] = useState(
    alertData ? 'تمت مراجعة وتعديل السؤال، شكراً لملاحظتك.' : ''
  );
  const [shouldReply, setShouldReply] = useState(Boolean(alertData && !alertData.replied));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const addChoice = () => {
    const nextLabel = String.fromCharCode(65 + choices.length) as 'A' | 'B' | 'C' | 'D' | 'E';
    setChoices([...choices, { label: nextLabel, text: '' }]);
  };

  const removeChoice = (indexToRemove: number) => {
    if (choices.length <= 2) {
      alert('يجب أن يحتوي السؤال على خيارين على الأقل');
      return;
    }
    const newChoices = choices
      .filter((_, i) => i !== indexToRemove)
      .map((c, i) => ({ ...c, label: String.fromCharCode(65 + i) as 'A' | 'B' | 'C' | 'D' | 'E' }));
    const removedChoiceLabel = choices[indexToRemove].label;
    if (correctAnswer === removedChoiceLabel) {
      setCorrectAnswer(newChoices[0].label as any);
    }
    setChoices(newChoices);
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      alert('حجم الصورة يجب أن لا يتجاوز 5 ميغابايت');
      return;
    }

    setUploadingImage(true);
    try {
      const ext = file.name.split('.').pop();
      const path = `mcq_images/${uuidv4()}.${ext}`;
      const storageRef = ref(storage, path);
      
      await uploadBytes(storageRef, file);
      const url = await getDownloadURL(storageRef);
      setImageUrl(url);
    } catch (e) {
      console.error(e);
      alert('فشل رفع الصورة');
    } finally {
      setUploadingImage(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stem.trim()) {
      setErrorMsg('نص السؤال مطلوب');
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      // 1. Fetch current questions of this lecture
      const existing = await getExistingMCQsForLecture(lectureId);
      const updatedQuestion: MCQQuestion = {
        ...question,
        stem: stem.trim(),
        stemFormat,
        explanation: explanation.trim(),
        difficulty,
        correctAnswer,
        imageUrl: imageUrl || undefined,
        choices: question.type === 'mcq' ? choices : []
      };

      let replaced = false;
      const newQuestions = existing.map(q => {
        if (q.id === question.id || (q.stem && q.stem === question.stem)) {
          replaced = true;
          return updatedQuestion;
        }
        return q;
      });

      // If question wasn't found in array by id/stem, append it
      if (!replaced) {
        newQuestions.push(updatedQuestion);
      }

      await updateLectureMCQSet(lectureId, newQuestions);

      // 2. If reply to student is enabled, send reply
      if (shouldReply && alertData && replyText.trim()) {
        await replyToQuestionReport(alertData.id, alertData.reportedBy, replyText.trim(), true);
      }

      onSaved();
      onClose();
    } catch (err: any) {
      console.error('Failed to update lecture MCQ:', err);
      setErrorMsg('فشل حفظ التعديل: ' + (err.message || 'خطأ غير معروف'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[260] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" dir="rtl">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="bg-white dark:bg-zinc-900 rounded-3xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl border border-slate-200 dark:border-zinc-800"
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-100 dark:border-zinc-800 mb-4">
          <div>
            <h3 className="font-bold text-xl text-slate-800 dark:text-zinc-100 flex items-center gap-2">
              <span>تعديل سؤال المحاضرة</span>
              {lectureTitle && (
                <span className="text-xs font-normal text-sky-600 dark:text-sky-400 bg-sky-50 dark:bg-sky-900/30 px-2 py-0.5 rounded-md">
                  {lectureTitle}
                </span>
              )}
            </h3>
            <p className="text-xs text-slate-500 mt-1">تعديل السؤال المباشر لمجموعة اختبارات المحاضرة</p>
          </div>
          <button 
            onClick={onClose} 
            disabled={isSubmitting} 
            className="p-2 bg-slate-100 dark:bg-zinc-800 rounded-full text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Student Report Banner if triggered from an alert */}
        {alertData && (
          <div className="mb-5 p-4 rounded-2xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 space-y-1.5">
            <div className="flex items-center gap-2 text-amber-800 dark:text-amber-300 font-bold text-xs">
              <ShieldAlert className="w-4 h-4 shrink-0 text-amber-600" />
              <span>بلاغ نشط من الطالب: {alertData.reportedByName || alertData.reportedBy}</span>
            </div>
            <p className="text-xs text-amber-900 dark:text-amber-200 bg-white/70 dark:bg-zinc-900/70 p-2 rounded-xl border border-amber-100 dark:border-amber-900/30 font-medium">
              تفاصيل المشكلة: {alertData.reason || alertData.message || 'لا توجد تفاصيل'}
            </p>
          </div>
        )}

        {errorMsg && (
          <div className="mb-4 p-3 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 text-xs text-red-700 dark:text-red-300 font-bold">
            {errorMsg}
          </div>
        )}

        <form onSubmit={handleSave} className="space-y-5">
          {/* Stem */}
          <div>
            <label className="block text-xs font-bold text-slate-600 dark:text-slate-300 mb-1">
              نص السؤال (Stem)
            </label>
            <textarea
              value={stem}
              onChange={(e) => setStem(e.target.value)}
              required
              rows={3}
              className="w-full p-3 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 text-sm focus:border-sky-500 focus:outline-none"
              placeholder="اكتب نص السؤال هنا..."
              dir="auto"
            />
          </div>

          {/* Formats & Difficulty */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-slate-600 dark:text-slate-300 mb-1">
                صيغة السؤال
              </label>
              <select
                value={stemFormat}
                onChange={(e) => setStemFormat(e.target.value as any)}
                className="w-full p-2.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 text-xs font-semibold"
              >
                <option value="standard">قياسي (Standard)</option>
                <option value="except">استثناء (Except / Not)</option>
                <option value="regarding">بخصوص (Regarding)</option>
                <option value="true_false">صح أو خطأ (True / False)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-600 dark:text-slate-300 mb-1">
                الصعوبة
              </label>
              <select
                value={difficulty}
                onChange={(e) => setDifficulty(e.target.value as any)}
                className="w-full p-2.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 text-xs font-semibold"
              >
                <option value="easy">سهل (Easy)</option>
                <option value="medium">متوسط (Medium)</option>
                <option value="hard">صعب (Hard)</option>
              </select>
            </div>
          </div>

          {/* Choices (if MCQ) */}
          {question.type === 'mcq' && (
            <div className="space-y-2 pt-2 border-t border-slate-100 dark:border-zinc-800">
              <div className="flex items-center justify-between">
                <label className="block text-xs font-bold text-slate-600 dark:text-slate-300">
                  الخيارات (اختر الإجابة الصحيحة)
                </label>
                {choices.length < 5 && (
                  <button
                    type="button"
                    onClick={addChoice}
                    className="text-xs font-bold text-sky-600 hover:underline"
                  >
                    + إضافة خيار
                  </button>
                )}
              </div>

              <div className="space-y-2">
                {choices.map((choice, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setCorrectAnswer(choice.label)}
                      className={`w-7 h-7 rounded-lg text-xs font-bold flex items-center justify-center transition-colors ${
                        correctAnswer === choice.label
                          ? 'bg-emerald-500 text-white shadow-sm'
                          : 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200'
                      }`}
                      title={correctAnswer === choice.label ? 'الإجابة الصحيحة' : 'تعيين كإجابة صحيحة'}
                    >
                      {choice.label}
                    </button>
                    <input
                      type="text"
                      value={choice.text}
                      onChange={(e) => {
                        const newChoices = [...choices];
                        newChoices[idx].text = e.target.value;
                        setChoices(newChoices);
                      }}
                      className="flex-1 p-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 text-xs"
                      placeholder={`خيار ${choice.label}`}
                      dir="auto"
                    />
                    {choices.length > 2 && (
                      <button
                        type="button"
                        onClick={() => removeChoice(idx)}
                        className="p-1.5 text-slate-400 hover:text-red-500 transition-colors"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Explanation */}
          <div>
            <label className="block text-xs font-bold text-slate-600 dark:text-slate-300 mb-1">
              التوضيح / التفسير (Explanation)
            </label>
            <textarea
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
              rows={2}
              className="w-full p-2.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 text-xs focus:border-sky-500 focus:outline-none"
              placeholder="سبب اختيار هذه الإجابة وتوضيح الحل..."
              dir="auto"
            />
          </div>

          {/* Optional Image */}
          <div>
            <label className="block text-xs font-bold text-slate-600 dark:text-slate-300 mb-1">
              صورة توضيحية (اختياري)
            </label>
            <div className="flex items-center gap-3">
              <label className="cursor-pointer inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-100">
                <ImagePlus className="w-4 h-4 text-sky-600" />
                <span>{uploadingImage ? 'جاري الرفع...' : 'رفع صورة'}</span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleImageUpload}
                  className="hidden"
                  disabled={uploadingImage}
                />
              </label>
              {imageUrl && (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-emerald-600 font-bold">تم إرفاق صورة</span>
                  <button
                    type="button"
                    onClick={() => setImageUrl('')}
                    className="text-xs text-red-500 hover:underline"
                  >
                    إزالة
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Resolution & Student Reply Section */}
          {alertData && (
            <div className="pt-3 border-t border-slate-100 dark:border-zinc-800 space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={shouldReply}
                  onChange={(e) => setShouldReply(e.target.checked)}
                  className="rounded border-slate-300 text-sky-600 focus:ring-sky-500 w-4 h-4"
                />
                <span className="text-xs font-bold text-slate-700 dark:text-slate-300">
                  إرسال رد للطالب وحل البلاغ عند حفظ التعديلات
                </span>
              </label>

              {shouldReply && (
                <div className="mt-2">
                  <input
                    type="text"
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    placeholder="اكتب ردك للطالب..."
                    className="w-full p-2.5 rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs focus:border-sky-500 focus:outline-none"
                  />
                </div>
              )}
            </div>
          )}

          {/* Submit */}
          <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100 dark:border-zinc-800">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2.5 rounded-xl text-xs font-bold text-slate-500 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-6 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold flex items-center gap-2 shadow-md shadow-sky-600/20 disabled:opacity-50 transition-all"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>جاري الحفظ...</span>
                </>
              ) : (
                <>
                  <CheckCircle className="w-4 h-4" />
                  <span>{shouldReply ? 'حفظ التعديلات وإرسال الرد' : 'حفظ التعديلات'}</span>
                </>
              )}
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  );
}
