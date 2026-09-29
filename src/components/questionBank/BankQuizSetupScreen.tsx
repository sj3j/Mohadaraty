import React, { useState } from 'react';
import { motion } from 'motion/react';
import { X, ArrowRight, Play } from 'lucide-react';
import { BankQuestion, QuestionTag } from '../../types/questionBank.types';

interface Props {
  bankQuestions: BankQuestion[];
  onStartQuiz: (filtered: BankQuestion[]) => void;
  onBack: () => void;
  isQuizLocked?: boolean;
}

export default function BankQuizSetupScreen({ bankQuestions, onStartQuiz, onBack, isQuizLocked }: Props) {
  const [selectedTags, setSelectedTags] = useState<Set<QuestionTag>>(new Set());
  const [order, setOrder] = useState<'random' | 'hardest'>('random');

  const allTags: QuestionTag[] = ['وزاري', 'سنين_سابقة', 'سؤال_الدكتور', 'مهم'];

  const handleToggleTag = (tag: QuestionTag) => {
    const next = new Set(selectedTags);
    if (next.has(tag)) next.delete(tag);
    else next.add(tag);
    setSelectedTags(next);
  };

  const handleStart = () => {
    if (isQuizLocked) return;
    // Apply filters
    let pool = bankQuestions;
    if (selectedTags.size > 0) {
      pool = pool.filter(q => q.tags.some(t => selectedTags.has(t)));
    }
    
    // Sort
    if (order === 'random') {
      pool.sort(() => Math.random() - 0.5);
    } else {
      pool.sort((a, b) => a.accuracyRate - b.accuracyRate); // lower accuracy = harder
    }
    
    const finalSet = pool;
    if (finalSet.length === 0) {
      alert('لا توجد أسئلة تطابق هذه المعايير.');
      return;
    }
    
    onStartQuiz(finalSet);
  };

  return (
    <motion.div 
      initial={{ x: 20, opacity: 0 }} 
      animate={{ x: 0, opacity: 1 }} 
      exit={{ x: -20, opacity: 0 }}
      className="flex flex-col h-full bg-stone-50 dark:bg-zinc-900"
    >
      <div className="flex items-center justify-between p-4 bg-white dark:bg-zinc-800 border-b border-slate-100 dark:border-zinc-700">
        <button onClick={onBack} className="p-2 rounded-full hover:bg-slate-100 dark:hover:bg-zinc-700">
          <ArrowRight className="w-6 h-6" />
        </button>
        <span className="font-bold text-lg dark:text-white">إعداد اختبار مخصص</span>
        <div className="w-10" />
      </div>

      <div className="flex-1 p-6 overflow-y-auto space-y-8">
        <div>
          <h3 className="font-bold text-slate-900 dark:text-white mb-4">فلتر التصنيف (اختياري)</h3>
          <div className="flex flex-wrap gap-3">
             {allTags.map(tag => (
               <button 
                 key={'tag_'+tag}
                 onClick={() => handleToggleTag(tag)}
                 className={`px-4 py-2 font-bold rounded-xl border-2 transition-colors ${
                   selectedTags.has(tag)
                   ? 'border-sky-500 bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400' 
                   : 'border-transparent bg-white dark:bg-zinc-800 text-slate-600 dark:text-slate-400'
                 }`}
               >
                 {tag.replace('_', ' ')}
               </button>
             ))}
          </div>
        </div>

        <div>
          <h3 className="font-bold text-slate-900 dark:text-white mb-4">ترتيب الأسئلة</h3>
          <div className="flex gap-3">
             <button 
               onClick={() => setOrder('random')}
               className={`flex-1 py-3 font-bold rounded-xl transition-colors border-2 ${
                 order === 'random' 
                 ? 'border-slate-800 bg-slate-800 text-white dark:bg-white dark:text-slate-900' 
                 : 'border-transparent bg-white dark:bg-zinc-800 text-slate-600 dark:text-slate-400'
               }`}
             >
               عشوائي
             </button>
             <button 
               onClick={() => setOrder('hardest')}
               className={`flex-1 py-3 font-bold rounded-xl transition-colors border-2 ${
                 order === 'hardest' 
                 ? 'border-slate-800 bg-slate-800 text-white dark:bg-white dark:text-slate-900' 
                 : 'border-transparent bg-white dark:bg-zinc-800 text-slate-600 dark:text-slate-400'
               }`}
             >
               الأصعب أولاً
             </button>
          </div>
        </div>
      </div>

      <div className="p-6 bg-white dark:bg-zinc-800 border-t border-slate-100 dark:border-zinc-700">
        {isQuizLocked ? (
          <div className="w-full p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-2xl text-center space-y-1">
            <p className="text-sm font-bold text-amber-900 dark:text-amber-200">الاختبارات معطلة مؤقتاً</p>
            <p className="text-xs text-amber-700 dark:text-amber-300">لا يمكن خوض اختبارات بنك الأسئلة أثناء فترة انتظار تأكيد النتيجة.</p>
          </div>
        ) : (
          <button 
            onClick={handleStart}
            className="w-full py-4 bg-emerald-600 hover:bg-emerald-700 text-white font-black text-lg rounded-2xl flex items-center justify-center gap-2 transition-colors shadow-lg shadow-emerald-500/20"
          >
            ابدأ الاختبار
            <Play className="w-5 h-5 fill-current" />
          </button>
        )}
      </div>
    </motion.div>
  );
}
