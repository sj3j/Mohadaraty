import React, { useState, useEffect } from 'react';
import { collection, query, getDocs, updateDoc, doc, deleteDoc, orderBy } from 'firebase/firestore';
import { db, auth } from '../../lib/firebase';
import { X, Search, Filter, Plus, Edit2, Trash2, ShieldAlert } from 'lucide-react';
import { TRANSLATIONS, Language, CATEGORIES, COURSE_IDS, COURSE_LABELS } from '../../types';
import { useStageSubjects } from '../../hooks/useStageSubjects';
import { subjectsForCourse } from '../../lib/subjectDisplay';
import { BankQuestion } from '../../types/questionBank.types';
import { getAllBankQuestionsForAdmin, softDeleteBankQuestion } from '../../services/questionBankService';
import AddBankQuestionModal from './AddBankQuestionModal';
import UploadPDFModal from './UploadPDFModal';
import { ConfirmModal } from '../ui/ConfirmModal';

interface AdminQuestionBankScreenProps {
  isOpen: boolean;
  onClose: () => void;
  lang: Language;
}

export default function AdminQuestionBankScreen({ isOpen, onClose, lang }: AdminQuestionBankScreenProps) {
  const { subjects } = useStageSubjects();
  const [questions, setQuestions] = useState<BankQuestion[]>([]);
  const [lectures, setLectures] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [selectedSubject, setSelectedSubject] = useState<string | null>(null);
  const [selectedLecture, setSelectedLecture] = useState<string | null>(null);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isImportPdfOpen, setIsImportPdfOpen] = useState(false);
  const [questionToDelete, setQuestionToDelete] = useState<string | null>(null);
  const [editingQuestion, setEditingQuestion] = useState<BankQuestion | null>(null);

  const tags = ['الكل', 'وزاري', 'سنين_سابقة', 'سؤال_الدكتور', 'مهم', 'متوقع'];
  const t = TRANSLATIONS[lang];

  const fetchQuestionsAndLectures = async () => {
    setLoading(true);
    try {
      const q = await getAllBankQuestionsForAdmin();
      
      // Inject alert flags
      const alertsSnap = await getDocs(query(collection(db, 'adminAlerts')));
      const alerts = alertsSnap.docs.map(d => d.data());
      
      const enrichedQuestions = q.map(question => {
        const relatedAlert = alerts.find(a => a.type === 'question_report' && a.questionId === question.id);
        if (relatedAlert) {
          return { ...question, isFlagged: true, flaggedReason: relatedAlert.reason };
        }
        return question;
      });

      setQuestions(enrichedQuestions);
      const snap = await getDocs(query(collection(db, 'lectures')));
      setLectures(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (err: any) {
      console.error(err);
      alert('Error fetching questions: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) fetchQuestionsAndLectures();
  }, [isOpen]);

  const handleDelete = async (id: string) => {
    try {
      await softDeleteBankQuestion(id);
      fetchQuestionsAndLectures();
    } catch (e: any) {
      alert("Error: " + e.message);
    }
  }

  const filtered = questions.filter(q => {
    if (q.isActive === false) return false;
    if (searchTerm && !q.stem.toLowerCase().includes(searchTerm.toLowerCase())) return false;
    if (selectedTag && selectedTag !== 'الكل' && !q.tags.includes(selectedTag as any)) return false;
    if (selectedSubject && q.subjectId !== selectedSubject) return false;
    if (selectedLecture && q.lectureId !== selectedLecture) return false;
    return true;
  });

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" dir="rtl">
      <div className="bg-white dark:bg-zinc-900 w-full max-w-4xl rounded-2xl shadow-xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between p-4 border-b border-gray-100 dark:border-zinc-800 bg-sky-50 dark:bg-sky-900/10">
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">📚 بنك الأسئلة</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-full transition-colors text-gray-500">
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="p-4 border-b border-gray-100 dark:border-zinc-800">
           <div className="flex flex-col sm:flex-row flex-wrap gap-4 mb-4">
              <div className="flex-1 relative min-w-[200px]">
                <Search className="w-5 h-5 absolute right-3 top-2.5 text-gray-400" />
                <input 
                  type="text" 
                  placeholder="ابحث في الأسئلة..." 
                  className="w-full bg-gray-50 dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-xl pr-10 pl-4 py-2"
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                />
              </div>
              <button 
                onClick={() => window.dispatchEvent(new CustomEvent('open-anti-cheat-board'))} 
                className="bg-red-50 hover:bg-red-100 text-red-600 dark:bg-red-900/20 dark:hover:bg-red-900/40 dark:text-red-400 px-4 py-2 rounded-xl font-bold flex items-center justify-center gap-2 border border-red-200 dark:border-red-800"
              >
                <ShieldAlert className="w-5 h-5" /> مراقبة الغش (MCQ)
              </button>
              <button 
                onClick={() => setIsAddOpen(true)} 
                className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-xl font-bold flex items-center justify-center gap-2"
              >
                <Plus className="w-5 h-5" /> إضافة سؤال
              </button>
              <button 
                onClick={() => setIsImportPdfOpen(true)} 
                className="bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-xl font-bold flex items-center justify-center gap-2"
              >
                استخراج من PDF (AI)
              </button>
              <button 
                onClick={() => alert("استيراد Excel لاحقاً")} 
                className="bg-sky-600 hover:bg-sky-700 text-white px-4 py-2 rounded-xl font-bold flex items-center justify-center gap-2"
              >
                استيراد من Excel
              </button>
           </div>
           
           <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-none">
             {tags.map(tag => (
               <button 
                  key={tag}
                  onClick={() => setSelectedTag(tag === 'الكل' ? null : tag)}
                  className={`px-3 py-1.5 rounded-full text-sm font-bold whitespace-nowrap transition-colors ${
                    (selectedTag === tag || (tag === 'الكل' && !selectedTag))
                    ? 'bg-slate-800 text-white dark:bg-white dark:text-slate-900'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-zinc-800 dark:text-slate-400'
                  }`}
               >
                 {tag}
               </button>
             ))}
           </div>
           
           <div className="flex flex-col sm:flex-row gap-4 mt-4">
             <select
               value={selectedSubject || ''}
               onChange={e => {
                 setSelectedSubject(e.target.value || null);
                 setSelectedLecture(null);
               }}
               className="flex-1 p-2 rounded-xl border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-800 text-sm"
             >
               <option value="">جميع المواد</option>
               {subjects.length > 0
                 ? COURSE_IDS.map(courseId => {
                     const courseSubjects = subjectsForCourse(subjects, courseId);
                     if (courseSubjects.length === 0) return null;
                     return (
                       <optgroup key={courseId} label={COURSE_LABELS[courseId].ar}>
                         {courseSubjects.map(sub => (
                           <option key={sub.id} value={sub.id}>{sub.nameAr || sub.nameEn}</option>
                         ))}
                       </optgroup>
                     );
                   })
                 : CATEGORIES.map(c => <option key={c.value} value={c.value}>{t[c.labelKey]}</option>)}
             </select>

             <select
               value={selectedLecture || ''}
               onChange={e => setSelectedLecture(e.target.value || null)}
               className="flex-1 p-2 rounded-xl border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-800 text-sm"
               disabled={!selectedSubject}
             >
               <option value="">جميع المحاضرات</option>
               {lectures.filter(l => l.category === selectedSubject).map(l => (
                 <option key={l.id} value={l.id}>{l.title}</option>
               ))}
             </select>
           </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {loading ? (
             <div className="text-center p-10"><div className="w-8 h-8 border-4 border-sky-500 border-t-transparent rounded-full animate-spin mx-auto"></div></div>
          ) : filtered.length === 0 ? (
             <p className="text-center text-slate-500 p-10">لا توجد أسئلة بهذا التصنيف.</p>
          ) : (
            filtered.map(q => (
              <div key={q.id} className="border border-gray-200 dark:border-zinc-700 rounded-xl p-4 bg-white dark:bg-zinc-800/50">
                <div className="flex gap-2 flex-wrap mb-2">
                  {q.isFlagged && (
                    <span 
                      className="px-2 py-0.5 text-[10px] font-bold rounded bg-red-100 text-red-700 dark:bg-red-900/30 flex items-center gap-1 cursor-help"
                      title={q.flaggedReason}
                    >
                      <ShieldAlert className="w-3 h-3" /> تم التبليغ: {q.flaggedReason}
                    </span>
                  )}
                  {q.tags.map(t => (
                    <span key={t} className="px-2 py-0.5 text-[10px] font-bold rounded bg-slate-100 text-slate-600 dark:bg-zinc-700 dark:text-slate-300">
                      {t} {t === 'سنين_سابقة' && q.year && `(${q.year})`}
                    </span>
                  ))}
                  <span className="px-2 py-0.5 text-[10px] font-bold rounded bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400">
                    {q.scope === 'lecture' ? 'محاضرة' : q.scope === 'subject' ? 'مادة' : 'بلا مادة ⚠'}
                  </span>
                </div>
                <p className="font-medium text-slate-800 dark:text-slate-200 text-sm mb-3 line-clamp-2" dir="auto">{q.stem}</p>
                <div className="flex justify-between items-center text-xs text-slate-500">
                  <span>الصعوبة: {q.difficulty} • محاولات: {q.attemptCount}</span>
                  <div className="flex gap-2">
                    <button onClick={() => setEditingQuestion(q)} className="text-sky-600 hover:underline">تعديل</button>
                    <button onClick={() => setQuestionToDelete(q.id)} className="text-red-600 hover:underline">حذف</button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
      
      <AddBankQuestionModal 
        isOpen={isAddOpen} 
        onClose={() => setIsAddOpen(false)} 
        onAdded={fetchQuestionsAndLectures} 
      />

      {editingQuestion && (
        <AddBankQuestionModal 
          isOpen={true} 
          initialData={editingQuestion}
          onClose={() => setEditingQuestion(null)} 
          onAdded={() => {
            setEditingQuestion(null);
            fetchQuestionsAndLectures();
          }} 
        />
      )}
      
      <UploadPDFModal
        isOpen={isImportPdfOpen}
        onClose={() => setIsImportPdfOpen(false)}
        onAdded={fetchQuestionsAndLectures}
      />
      
      <ConfirmModal
        isOpen={!!questionToDelete}
        onClose={() => setQuestionToDelete(null)}
        onConfirm={() => {
          if (questionToDelete) handleDelete(questionToDelete);
        }}
        title="حذف السؤال"
        message="هل أنت متأكد من حذف هذا السؤال من البنك؟"
      />
    </div>
  );
}
