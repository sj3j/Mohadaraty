import React, { useState, useEffect } from 'react';
import { collection, query, getDocs, updateDoc, doc, deleteDoc, orderBy, limit } from 'firebase/firestore';
import { db, auth } from '../../lib/firebase';
import { X, Search, Filter, Plus, Edit2, Trash2, ShieldAlert, FileSpreadsheet, Bell } from 'lucide-react';
import { TRANSLATIONS, Language, CATEGORIES, COURSE_IDS, COURSE_LABELS } from '../../types';
import type { Lecture } from '../../types';
import { useStageSubjects } from '../../hooks/useStageSubjects';
import { subjectsForCourse, subjectSlugOf } from '../../lib/subjectDisplay';
import {
  bankLectureIdFor,
  canonicalBankLectureId,
  isQuestionMatchingLecture,
  isQuestionMatchingSubject,
  questionBankLectureOptions,
} from '../../lib/questionBankMatching';
import { BankQuestion } from '../../types/questionBank.types';
import { getAllBankQuestionsForAdmin, softDeleteBankQuestion, sendDoctorQuestionsNotification } from '../../services/questionBankService';
import AddBankQuestionModal from './AddBankQuestionModal';
import UploadPDFModal from './UploadPDFModal';
import UploadExcelModal from './UploadExcelModal';
import { ConfirmModal } from '../ui/ConfirmModal';

interface AdminQuestionBankScreenProps {
  isOpen: boolean;
  onClose: () => void;
  lang: Language;
  targetQuestionId?: string | null;
  targetAlert?: any | null;
  targetLectureId?: string | null;
  targetSubjectId?: string | null;
  canOpenAntiCheat?: boolean;
}

export default function AdminQuestionBankScreen({
  isOpen,
  onClose,
  lang,
  targetQuestionId,
  targetAlert,
  targetLectureId,
  targetSubjectId,
  canOpenAntiCheat = false
}: AdminQuestionBankScreenProps) {
  const { subjects } = useStageSubjects();
  const [questions, setQuestions] = useState<BankQuestion[]>([]);
  const [lectures, setLectures] = useState<Lecture[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [selectedSubject, setSelectedSubject] = useState<string | null>(null);
  const [selectedLecture, setSelectedLecture] = useState<string | null>(null);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isImportPdfOpen, setIsImportPdfOpen] = useState(false);
  const [isImportExcelOpen, setIsImportExcelOpen] = useState(false);
  const [questionToDelete, setQuestionToDelete] = useState<string | null>(null);
  const [editingQuestion, setEditingQuestion] = useState<BankQuestion | null>(null);
  const [isSendingNotif, setIsSendingNotif] = useState(false);

  const tags = ['الكل', 'وزاري', 'سنين_سابقة', 'سؤال_الدكتور', 'مهم', 'متوقع'];
  const t = TRANSLATIONS[lang];

  const fetchQuestionsAndLectures = async () => {
    setLoading(true);
    try {
      const q = await getAllBankQuestionsForAdmin();
      
      // Inject alert flags
      const alertsSnap = await getDocs(query(collection(db, 'adminAlerts'), orderBy('createdAt', 'desc'), limit(100)));
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
      const fetchedLectures: Lecture[] = snap.docs.map(d => ({ id: d.id, ...d.data() } as Lecture));
      setLectures(fetchedLectures);

      if (targetLectureId) {
        const canonicalTargetLectureId = canonicalBankLectureId(targetLectureId, fetchedLectures);
        setSelectedLecture(canonicalTargetLectureId);
        if (!targetSubjectId) {
          const foundLec = fetchedLectures.find(l => l.id === canonicalTargetLectureId)
            ?? fetchedLectures.find(l => bankLectureIdFor(l) === canonicalTargetLectureId);
          if (foundLec) {
            const resolvedSubj = subjectSlugOf(foundLec) || null;
            if (resolvedSubj) setSelectedSubject(resolvedSubj);
          }
        }
      }

      // Auto-target question if requested
      if (targetQuestionId) {
        const found = enrichedQuestions.find(item => item.id === targetQuestionId);
        if (found) {
          setEditingQuestion(found);
          setSearchTerm(found.stem ? found.stem.substring(0, 30) : '');
        } else if (targetAlert?.questionStem) {
          setSearchTerm(targetAlert.questionStem.substring(0, 30));
        }
      } else if (targetAlert?.questionStem) {
        setSearchTerm(targetAlert.questionStem.substring(0, 30));
      }
    } catch (err: any) {
      console.error(err);
      alert('Error fetching questions: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      if (targetSubjectId) {
        setSelectedSubject(targetSubjectId);
      }
      fetchQuestionsAndLectures();
    }
  }, [isOpen, targetQuestionId, targetLectureId, targetSubjectId]);

  const handleDelete = async (id: string) => {
    try {
      await softDeleteBankQuestion(id);
      fetchQuestionsAndLectures();
    } catch (e: any) {
      alert("Error: " + e.message);
    }
  };

  const handleSendDoctorNotification = async () => {
    if (!selectedLecture) return;
    const canonicalLectureId = canonicalBankLectureId(selectedLecture, lectures);
    const lecObj = lectures.find(l => l.id === canonicalLectureId)
      ?? lectures.find(l => bankLectureIdFor(l) === canonicalLectureId);
    const lecTitle = lecObj?.title || 'المحاضرة';
    const docQs = questions.filter(q =>
      isQuestionMatchingLecture(q, canonicalLectureId, lectures) &&
      q.tags?.includes('سؤال_الدكتور') &&
      q.isActive !== false,
    );

    const confirmMsg = `هل تريد بالتأكيد إرسال إشعار للطلاب (تعال ادرس) لمحاضرة:\n"${lecTitle}"؟\n(يوجد ${docQs.length} سؤال دكتور مضاف لهذه المحاضرة)`;
    if (!window.confirm(confirmMsg)) return;

    setIsSendingNotif(true);
    try {
      const res = await sendDoctorQuestionsNotification({
        lectureId: canonicalLectureId,
        lectureTitle: lecTitle,
        stageId: lecObj?.stageId,
        subjectId: lecObj?.subjectId,
      });
      alert(`تم إرسال الإشعار بنجاح!\nعدد المستلمين المستهدفين: ${res.recipientsCount}\nالأجهزة التي استلمت الإشعار: ${res.sentCount}`);
    } catch (err: any) {
      console.error('Failed to send notification:', err);
      alert('فشل إرسال الإشعار: ' + (err?.message || 'خطأ غير معروف'));
    } finally {
      setIsSendingNotif(false);
    }
  };

  const filtered = questions.filter(q => {
    if (q.isActive === false) return false;
    if (searchTerm && !q.stem.toLowerCase().includes(searchTerm.toLowerCase())) return false;
    if (selectedTag && selectedTag !== 'الكل' && !q.tags.includes(selectedTag as any)) return false;
    if (!isQuestionMatchingSubject(q, selectedSubject)) return false;
    if (!isQuestionMatchingLecture(q, selectedLecture, lectures)) return false;
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

        {targetAlert && (
          <div className="bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-900/60 p-3 px-4 flex items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 text-amber-800 dark:text-amber-200 font-bold">
              <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0" />
              <span>
                بلاغ نشط من الطالب: {targetAlert.reportedByName || targetAlert.reportedBy} ({targetAlert.reason || targetAlert.message || 'بلا تفاصيل'})
              </span>
            </div>
            {targetAlert.replied ? (
              <span className="text-emerald-600 dark:text-emerald-400 font-bold bg-emerald-50 dark:bg-emerald-900/30 px-2 py-0.5 rounded-lg">
                تم الرد سابقاً
              </span>
            ) : (
              <span className="text-amber-700 dark:text-amber-300 font-semibold">
                يرجى مراجعة وتعديل السؤال لحل البلاغ
              </span>
            )}
          </div>
        )}

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
              {canOpenAntiCheat && <button
                onClick={() => window.dispatchEvent(new CustomEvent('open-anti-cheat-board'))} 
                className="bg-red-50 hover:bg-red-100 text-red-600 dark:bg-red-900/20 dark:hover:bg-red-900/40 dark:text-red-400 px-4 py-2 rounded-xl font-bold flex items-center justify-center gap-2 border border-red-200 dark:border-red-800"
              >
                <ShieldAlert className="w-5 h-5" /> مراقبة الغش (MCQ)
              </button>}
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
                onClick={() => setIsImportExcelOpen(true)} 
                className="bg-sky-600 hover:bg-sky-700 text-white px-4 py-2 rounded-xl font-bold flex items-center justify-center gap-2 shadow-sm"
              >
                <FileSpreadsheet className="w-5 h-5" /> استيراد من Excel
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
               {questionBankLectureOptions(lectures, selectedSubject).map(l => (
                 <option key={l.id} value={l.id}>{l.title}</option>
               ))}
             </select>

              {selectedLecture && (
                <button
                  type="button"
                  onClick={handleSendDoctorNotification}
                  disabled={isSendingNotif}
                  className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-sm font-bold flex items-center justify-center gap-2 shadow-sm transition-colors shrink-0 disabled:opacity-50"
                  title="إرسال إشعار للطلاب بتوفر أسئلة الدكتور لهذه المحاضرة"
                >
                  <Bell className="w-4 h-4" />
                  <span>{isSendingNotif ? 'جاري الإرسال...' : 'إرسال إشعار للطلاب'}</span>
                </button>
              )}
           </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {loading ? (
            <div className="text-center py-12 text-slate-400">جاري تحميل الأسئلة...</div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-slate-400">لا توجد أسئلة تطابق البحث أو الفلتر</div>
          ) : (
            filtered.map((q) => (
              <div 
                key={q.id} 
                className={`p-4 rounded-xl border transition-all ${
                  q.isFlagged 
                    ? 'bg-amber-50/60 dark:bg-amber-950/20 border-amber-300 dark:border-amber-800 shadow-sm' 
                    : 'bg-white dark:bg-zinc-800/50 border-gray-100 dark:border-zinc-800'
                }`}
              >
                {q.isFlagged && (
                  <div className="mb-2 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400 font-bold bg-amber-100/60 dark:bg-amber-900/40 px-2.5 py-1 rounded-lg w-fit">
                    <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
                    <span>تم الإبلاغ عن هذا السؤال: {q.flaggedReason || 'خطأ في المحتوى'}</span>
                  </div>
                )}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex gap-1.5 flex-wrap">
                    {q.tags?.map(t => (
                      <span key={t} className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-slate-100 text-slate-600 dark:bg-zinc-700 dark:text-slate-300">
                        {t}
                      </span>
                    ))}
                  </div>
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
        initialScope={selectedLecture ? 'lecture' : 'subject'}
        initialSubjectId={selectedSubject}
        initialLectureId={selectedLecture}
      />

      {editingQuestion && (
        <AddBankQuestionModal 
          isOpen={true} 
          initialData={editingQuestion}
          targetAlert={targetAlert && (targetAlert.questionId === editingQuestion.id || (editingQuestion.stem && targetAlert.questionStem && editingQuestion.stem.includes(targetAlert.questionStem.substring(0, 25)))) ? targetAlert : undefined}
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
        initialScope={selectedLecture ? 'lecture' : 'subject'}
        initialSubjectId={selectedSubject}
        initialLectureId={selectedLecture}
      />

      <UploadExcelModal
        isOpen={isImportExcelOpen}
        onClose={() => setIsImportExcelOpen(false)}
        onAdded={fetchQuestionsAndLectures}
        initialScope={selectedLecture ? 'lecture' : 'subject'}
        initialSubjectId={selectedSubject}
        initialLectureId={selectedLecture}
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
