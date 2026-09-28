import React, { useState, useEffect } from 'react';
import { MCQQuestion, MCQChoice, MCQDifficulty, MCQStemFormat } from '../../types/mcq.types';
import { X, Loader2, ImagePlus, Trash } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { uploadBytes, getDownloadURL, ref } from 'firebase/storage';
import { storage } from '../../lib/firebase';
import { v4 as uuidv4 } from 'uuid';
import { ConfirmModal } from '../ui/ConfirmModal';

interface Props {
  question: MCQQuestion;
  onClose: () => void;
  onSubmit: (updated: Partial<MCQQuestion>) => Promise<void>;
  isSubmitting: boolean;
  onDelete?: () => Promise<void>;
  isDeleting?: boolean;
}

export default function MCQManualEditModal({ question, onClose, onSubmit, isSubmitting, onDelete, isDeleting }: Props) {
  const [stem, setStem] = useState(question.stem);
  const [stemFormat, setStemFormat] = useState<MCQStemFormat>(question.stemFormat);
  const [explanation, setExplanation] = useState(question.explanation);
  const [difficulty, setDifficulty] = useState<MCQDifficulty>(question.difficulty);
  const [correctAnswer, setCorrectAnswer] = useState(question.correctAnswer);
  
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);

  // MCQ specific
  const [choices, setChoices] = useState<MCQChoice[]>(question.type === 'mcq' ? [...question.choices] : [
    { label: 'A', text: '' },
    { label: 'B', text: '' },
    { label: 'C', text: '' },
    { label: 'D', text: '' },
    { label: 'E', text: '' }
  ]);

  const addChoice = () => {
    const nextLabel = String.fromCharCode(65 + choices.length) as "A" | "B" | "C" | "D" | "E"; // A, B, C...
    setChoices([...choices, { label: nextLabel, text: '' }]);
  };

  const removeChoice = (indexToRemove: number) => {
    if (choices.length <= 2) {
      alert("يجب أن يحتوي السؤال على خيارين على الأقل");
      return;
    }
    const newChoices = choices
      .filter((_, i) => i !== indexToRemove)
      .map((c, i) => ({ ...c, label: String.fromCharCode(65 + i) as "A" | "B" | "C" | "D" | "E" })); // Re-assign labels A, B, C...
    const removedChoiceLabel = choices[indexToRemove].label;
    if (correctAnswer === removedChoiceLabel) {
      setCorrectAnswer(newChoices[0].label as any);
    }
    setChoices(newChoices);
  };

  const [imageUrl, setImageUrl] = useState(question.imageUrl || '');
  const [uploadingImage, setUploadingImage] = useState(false);

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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const updated: Partial<MCQQuestion> = {
      stem,
      stemFormat,
      explanation,
      difficulty,
      correctAnswer,
      imageUrl: imageUrl || undefined,
    };
    if (question.type === 'mcq') {
      updated.choices = choices;
    }
    onSubmit(updated);
  };

  return (
    <div className="fixed inset-0 z-[250] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" dir="rtl">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="bg-white dark:bg-zinc-900 rounded-3xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-xl border border-slate-100 dark:border-zinc-800"
      >
        <div className="flex items-center justify-between mb-6">
          <h3 className="font-bold text-xl text-slate-800 dark:text-zinc-100">تعديل يدوي للسؤال</h3>
          <button onClick={onClose} disabled={isSubmitting} className="p-2 bg-slate-100 dark:bg-zinc-800 rounded-full text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          
          <div className="space-y-4">
            <div>
               <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">نص السؤال</label>
               <textarea 
                  value={stem}
                  onChange={e => setStem(e.target.value)}
                  className="w-full p-4 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 text-slate-900 dark:text-white resize-none outline-none focus:ring-2 focus:ring-sky-500/50"
                  rows={3}
                  required
               />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
             <div>
               <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">صيغة السؤال</label>
               <select
                 value={stemFormat}
                 onChange={e => setStemFormat(e.target.value as MCQStemFormat)}
                 className="w-full p-3 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 text-slate-900 dark:text-white outline-none"
               >
                  <option value="standard">قياسي (اختر الجواب الصحيح)</option>
                  <option value="except">ما عدا (Except)</option>
                  <option value="regarding">بخصوص (Regarding)</option>
               </select>
             </div>
             <div>
               <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">مستوى الصعوبة</label>
               <select
                 value={difficulty}
                 onChange={e => setDifficulty(e.target.value as MCQDifficulty)}
                 className="w-full p-3 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 text-slate-900 dark:text-white outline-none"
               >
                  <option value="easy">سهل 🟢</option>
                  <option value="medium">متوسط 🟡</option>
                  <option value="hard">صعب 🔴</option>
               </select>
             </div>
          </div>

          <div>
             <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">صورة توضيحية للسؤال (اختياري)</label>
             {imageUrl ? (
               <div className="relative inline-block mt-2 mb-4">
                 <img src={imageUrl} alt="Question visual" className="h-32 object-contain bg-slate-100 dark:bg-zinc-800 rounded-lg border border-slate-200 dark:border-zinc-700" />
                 <button type="button" onClick={() => setImageUrl('')} className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-1 shadow hover:bg-red-600 transition-colors">
                   <X className="w-4 h-4" />
                 </button>
               </div>
             ) : (
               <label className="flex items-center gap-2 cursor-pointer w-max px-4 py-2 bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-slate-700 dark:text-slate-300 rounded-lg transition-colors border border-dashed border-slate-300 dark:border-zinc-600">
                 <ImagePlus className="w-5 h-5" />
                 <span className="font-bold text-sm">{uploadingImage ? 'جاري الرفع...' : 'إضافة صورة'}</span>
                 <input type="file" accept="image/*" className="hidden" onChange={handleImageUpload} disabled={uploadingImage} />
               </label>
             )}
          </div>

          {question.type === 'mcq' && (
             <div className="space-y-4">
               <div className="flex items-center justify-between mb-2">
                 <label className="block text-sm font-bold text-slate-700 dark:text-slate-300">الخيارات</label>
                 <button 
                   onClick={addChoice} 
                   type="button" 
                   className="text-sm font-bold text-sky-600 hover:text-sky-700 dark:text-sky-400 dark:hover:text-sky-300 flex items-center gap-1"
                 >
                   <span className="text-xl">+</span> إضافة خيار
                 </button>
               </div>
               {choices.map((c, i) => (
                 <div key={c.label} className="flex gap-2 relative group">
                    <div className="flex-shrink-0 w-10 flex flex-col justify-center items-center">
                       <span className="font-bold text-slate-600 dark:text-slate-400 mb-1">{c.label}</span>
                       <input 
                         type="radio" 
                         name="correctAnswer" 
                         checked={correctAnswer === c.label}
                         onChange={() => setCorrectAnswer(c.label as any)}
                         className="w-4 h-4 cursor-pointer"
                       />
                    </div>
                    <input 
                      type="text" 
                      value={c.text}
                      onChange={e => {
                        const newArr = [...choices];
                        newArr[i].text = e.target.value;
                        setChoices(newArr);
                      }}
                      className="flex-1 p-3 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 text-slate-900 dark:text-white outline-none focus:ring-2 focus:ring-sky-500/50 text-left"
                      dir="auto"
                      placeholder={`خيار ${c.label}`}
                    />
                    {choices.length > 2 && (
                      <button 
                        type="button" 
                        onClick={() => removeChoice(i)} 
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg flex-shrink-0 self-center"
                        title="حذف الخيار"
                      >
                        <X className="w-5 h-5" />
                      </button>
                    )}
                 </div>
               ))}
               <p className="text-xs text-slate-500 mt-1">* تأكد من تحديد الجواب الصحيح باستخدام زر الاختيار (Radio)</p>
             </div>
          )}

          {question.type === 'true_false' && (
             <div className="space-y-4">
                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">الجواب الصحيح</label>
                <div className="flex gap-4">
                   <label className="flex items-center gap-2 cursor-pointer bg-slate-50 dark:bg-zinc-800 px-4 py-3 border border-slate-200 dark:border-zinc-700 rounded-xl w-1/2">
                      <input 
                        type="radio" 
                        name="correctAnswer_tf" 
                        checked={correctAnswer === 'True'}
                        onChange={() => setCorrectAnswer('True')}
                      />
                      <span className="font-bold text-slate-800 dark:text-slate-200">صحيح (True)</span>
                   </label>
                   <label className="flex items-center gap-2 cursor-pointer bg-slate-50 dark:bg-zinc-800 px-4 py-3 border border-slate-200 dark:border-zinc-700 rounded-xl w-1/2">
                      <input 
                        type="radio" 
                        name="correctAnswer_tf" 
                        checked={correctAnswer === 'False'}
                        onChange={() => setCorrectAnswer('False')}
                      />
                      <span className="font-bold text-slate-800 dark:text-slate-200">خطأ (False)</span>
                   </label>
                </div>
             </div>
          )}

          <div>
             <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">الشرح (التفسير)</label>
             <textarea 
                value={explanation}
                onChange={e => setExplanation(e.target.value)}
                className="w-full p-4 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 text-slate-900 dark:text-white resize-none outline-none focus:ring-2 focus:ring-sky-500/50"
                rows={3}
                required
             />
          </div>

          <div className="flex gap-3 pt-4 border-t border-slate-100 dark:border-zinc-800">
            {onDelete && (
              <button
                type="button"
                onClick={() => setShowConfirmDelete(true)}
                disabled={isSubmitting || isDeleting}
                className="py-3 px-4 rounded-xl font-bold bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/50 disabled:opacity-50 transition-colors flex items-center justify-center"
                title="حذف السؤال"
              >
                {isDeleting ? <Loader2 className="w-5 h-5 animate-spin" /> : <Trash className="w-5 h-5" />}
              </button>
            )}
            <button 
              type="button"
              onClick={onClose}
              className="flex-1 py-3 px-4 rounded-xl font-bold bg-slate-100 dark:bg-zinc-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-zinc-600 transition-colors"
              disabled={isSubmitting || isDeleting}
            >
              إلغاء
            </button>
            <button 
              type="submit"
              disabled={isSubmitting || isDeleting}
              className="flex-1 py-3 px-4 rounded-xl font-bold bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
            >
              {isSubmitting ? <Loader2 className="w-5 h-5 animate-spin" /> : 'حفظ التعديلات'}
            </button>
          </div>
        </form>
      </motion.div>

      <ConfirmModal
        isOpen={showConfirmDelete}
        onClose={() => setShowConfirmDelete(false)}
        onConfirm={() => {
          if (onDelete) onDelete();
        }}
        title="تأكيد الحذف"
        message="هل أنت متأكد من رغبتك في حذف هذا السؤال نهائياً؟ لا يمكن التراجع عن هذا الإجراء."
        confirmText="حذف نهائي"
        cancelText="إلغاء التراجع"
        isDestructive={true}
      />
    </div>
  );
}
