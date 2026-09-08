import React, { useState, useEffect } from 'react';
import { Upload, FileSpreadsheet, Check, X, AlertCircle, RefreshCw, Trash2, Save, Undo, ChevronDown, Search, Edit2 } from 'lucide-react';
import { collection, query, getDocs, where, onSnapshot, orderBy, doc, getDoc } from 'firebase/firestore';
import { db, auth, handleFirestoreError, OperationType } from '../../lib/firebase';
import { UserProfile, CATEGORIES, TRANSLATIONS } from '../../types';
import { parseGradeFile, parseGradeText, ParsedRow } from '../../services/gradeFileParser';
import { matchGradesToStudents } from '../../services/fuzzyMatchingService';
import { MatchedResult, GradeBatch } from '../../types/grades.types';
import { confirmDegreeBatchClient, undoDegreeBatch, patchDegreeBatchClient } from '../../services/adminGradeService';
import { motion, AnimatePresence } from 'motion/react';
import { useStageContext } from '../../contexts/StageContext';
import { useAcademicPhase } from '../../hooks/useAcademicPhase';
import { canManage } from '../../lib/permissions';
import { isMasterAdminEmail } from '../../../shared/masterAdmins';

export interface AdminGradesScreenProps {
  isOpen: boolean;
  onClose: () => void;
  user: UserProfile | null;
}

const SearchableStudentSelect = ({ 
  value, 
  onChange, 
  students, 
  selectedStudentIds, 
  className 
}: { 
  value: string | null; 
  onChange: (val: string | null) => void; 
  students: any[]; 
  selectedStudentIds: Set<string>; 
  className?: string;
}) => {
  const [isOpen, setIsOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const wrapperRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const selectedStudent = students.find(s => s.uid === value);
  const showAlias = selectedStudent?.name && selectedStudent?.originalName && !selectedStudent.originalName.includes(selectedStudent.name) && selectedStudent.originalName !== selectedStudent.name;

  const displaySelected = selectedStudent 
    ? `${selectedStudent.originalName} ${showAlias ? `(الاسم بحسابه: ${selectedStudent.name})` : ''} - ${selectedStudent.email || selectedStudent.uid}`
    : 'غير متطابق (لن يتم الحفظ)';

  const filteredStudents = students.filter(s => {
    if (selectedStudentIds.has(s.uid) && s.uid !== value) return false;
    if (!search) return true;
    const term = search.toLowerCase();
    return (s.originalName && s.originalName.toLowerCase().includes(term)) ||
           (s.name && s.name.toLowerCase().includes(term)) ||
           (s.email && s.email.toLowerCase().includes(term));
  });

  return (
    <div className="relative" ref={wrapperRef}>
      <div 
        onClick={() => setIsOpen(!isOpen)}
        className={`w-full max-w-[250px] sm:max-w-[300px] border px-3 py-2 rounded-lg flex items-center justify-between cursor-pointer bg-white dark:bg-zinc-900 border-gray-300 dark:border-zinc-700 hover:bg-gray-50 dark:hover:bg-zinc-800 transition-colors ${className}`}
      >
        <span className="truncate text-sm text-gray-900 dark:text-gray-100">{displaySelected}</span>
        <ChevronDown className="w-4 h-4 ml-2 text-gray-500 flex-shrink-0" />
      </div>
      
      {isOpen && (
        <div className="absolute z-50 mt-1 w-full sm:w-[350px] bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 rounded-lg shadow-xl max-h-60 flex flex-col right-0 overflow-hidden">
          <div className="p-2 border-b border-gray-100 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-800/50">
            <div className="relative">
              <input
                type="text"
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="ابحث عن اسم أو إيميل..."
                className="w-full pl-2 pr-9 py-2 text-sm bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 rounded-md focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            </div>
          </div>
          <div className="overflow-y-auto p-1 py-2 flex-1">
            <div 
              onClick={() => { onChange(null); setIsOpen(false); }}
              className={`px-3 py-2 text-sm rounded-md hover:bg-gray-100 dark:hover:bg-zinc-800 cursor-pointer transition-colors ${!value ? 'bg-gray-100/80 dark:bg-zinc-800/80 font-bold text-gray-900 dark:text-white' : 'text-gray-700 dark:text-gray-300'}`}
            >
              غير متطابق (لن يتم الحفظ)
            </div>
            {filteredStudents.map(s => {
              const showA = s.name && s.originalName && !s.originalName.includes(s.name) && s.originalName !== s.name;
              return (
                <div 
                  key={s.uid || s.id || `unreg-${Math.random()}`}
                  onClick={() => { onChange(s.uid); setIsOpen(false); }}
                  className={`px-3 py-2 text-sm rounded-md hover:bg-gray-100 dark:hover:bg-zinc-800 cursor-pointer transition-colors flex flex-col gap-0.5 ${value === s.uid ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 font-bold' : 'text-gray-700 dark:text-gray-300'}`}
                >
                  <span>{s.originalName}</span>
                  {showA && <span className="text-[10px] text-gray-500 dark:text-zinc-400 font-normal">الاسم بحسابه: {s.name}</span>}
                  <span className="text-[10px] text-gray-400 dark:text-zinc-500 font-mono font-normal truncate mt-0.5" dir="ltr">{s.email || s.uid}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default function AdminGradesScreen({ isOpen, onClose, user }: AdminGradesScreenProps) {
  const isMasterAdmin = isMasterAdminEmail(auth.currentUser?.email);
  const canManageGrades = canManage(user, 'manageGrades');
  const { effectiveStageId } = useStageContext();
  // Stamped onto every degree this upload writes. Taken from the calendar, not
  // from createdAt: a batch confirmed after the year rolls over still belongs to
  // the year it examined.
  const { yearLabel } = useAcademicPhase();
  
  if (isOpen && !canManageGrades && !isMasterAdmin) {
    onClose();
    return null;
  }
  
  const [tab, setTab] = useState<'upload' | 'history'>('upload');

  // Upload/Review State
  const [examName, setExamName] = useState('');
  const [material, setMaterial] = useState('');
  const [maxDegree, setMaxDegree] = useState('100');
  const [patchText, setPatchText] = useState('');
  const [isParsing, setIsParsing] = useState(false);
  const [isMatching, setIsMatching] = useState(false);
  const [students, setStudents] = useState<UserProfile[]>([]);
  const [matchedResults, setMatchedResults] = useState<MatchedResult[]>([]);
  const [sortUnmatchedFirst, setSortUnmatchedFirst] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [confirmingBatchId, setConfirmingBatchId] = useState<string | null>(null);
  const [editBatchId, setEditBatchId] = useState<string | null>(null);
  const [patchAppealsBatchId, setPatchAppealsBatchId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const [resultSearchQuery, setResultSearchQuery] = useState('');
  const [resultSortType, setResultSortType] = useState<'default' | 'highest' | 'lowest'>('default');

  // History State
  const [batches, setBatches] = useState<any[]>([]);
  const [historyYear, setHistoryYear] = useState<string>('all');

  // Years present in the loaded history, newest first. Derived in memory rather
  // than queried: the history query is already where('stageId') + orderBy(
  // 'createdAt'), and a second where() would need another composite index for a
  // list that is only ever a handful of rows.
  const historyYears = Array.from(
    new Set(batches.map(b => b.yearLabel).filter(Boolean) as string[])
  ).sort((a, b) => b.localeCompare(a));

  const visibleBatches = historyYear === 'all'
    ? batches
    : batches.filter(b => (b.yearLabel || '') === historyYear);

  // Fetch all students exactly once
  useEffect(() => {
    if (!isOpen) return;
    const fetchStudents = async () => {
      try {
        // Fetch registration names from students collection
        const studentsSnap = await getDocs(query(collection(db, 'students'), where('stageId', '==', effectiveStageId)));
        const registeredStudentsMap = new Map<string, any>();
        studentsSnap.docs.forEach(d => {
          const data = d.data();
          const emailKey = (data.email || d.id).toLowerCase().trim();
          registeredStudentsMap.set(emailKey, { id: d.id, ...data });
        });

        const q = query(collection(db, 'users'), where('role', '==', 'student'), where('stageId', '==', effectiveStageId));
        const usersSnap = await getDocs(q);
        
        const addedEmails = new Set<string>();

        const st: (UserProfile & { isRegistered?: boolean })[] = usersSnap.docs.map(d => {
          const data = d.data();
          const email = (data.email || d.id).toLowerCase().trim();
          addedEmails.add(email);
          const regData = registeredStudentsMap.get(email);
          const regName = regData?.name || null;
          return { 
            uid: d.id, 
            ...data, 
            originalName: regName ? regName : `${data.name || email} (غير مسجل رسمياً)`,
            isRegistered: !!regName
          } as UserProfile & { isRegistered?: boolean };
        }); 

        // Important: Add students who are registered but have NEVER logged into the app yet
        registeredStudentsMap.forEach((data, email) => {
          if (!addedEmails.has(email)) {
            // The uid for custom token logic is implicitly their email.
            // Using data.id (which is the doc id in 'students', usually their email).
            st.push({
              uid: data.id, 
              email: email,
              name: data.name || email,
              originalName: data.name || email,
              role: data.role || 'student',
              isRegistered: true,
              favorites: [],
              studied: [],
              completedWeeklyTasks: [],
              notificationPreferences: { lectures: true, announcements: true, chat: true, records: true, homeworks: true }
            } as UserProfile & { isRegistered?: boolean });
          }
        });
        
        setStudents(st);
      } catch (err) {
        console.error("Error fetching students:", err);
      }
    };
    fetchStudents();
  }, [isOpen, effectiveStageId]);

  // Fetch batches history
  useEffect(() => {
    if (!isOpen) return;
    if (tab === 'history') {
      const q = query(collection(db, 'degreeBatches'), where('stageId', '==', effectiveStageId), orderBy('createdAt', 'desc'));
      const unsub = onSnapshot(q, (snap) => {
        setBatches(snap.docs.map(d => ({ ...d.data(), id: d.id })));
      }, (error) => {
        handleFirestoreError(error, OperationType.LIST, 'degreeBatches');
      });
      return () => unsub();
    }
  }, [tab, isOpen, effectiveStageId]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!examName.trim()) {
      setErrorMsg("يرجى إدخال اسم الاختبار/السعي أولاً");
      return;
    }
    
    if (!material) {
      setErrorMsg("يرجى اختيار المادة الدراسية");
      return;
    }

    setErrorMsg('');
    setIsParsing(true);
    try {
      const parsedStats = await parseGradeFile(file);
      setIsParsing(false);
      setIsMatching(true);
      
      const results = matchGradesToStudents(parsedStats, students);
      setMatchedResults(results);
    } catch (err: any) {
      setErrorMsg("فشل تحليل الملف: " + err.message);
    } finally {
      setIsParsing(false);
      setIsMatching(false);
      e.target.value = ''; // Reset file input
    }
  };

  const handleTextMatch = async () => {
    if (!patchText.trim()) {
      setErrorMsg("يرجى لصق الدرجات أولاً");
      return;
    }
    
    setErrorMsg('');
    setIsParsing(true);
    try {
      const parsedStats = parseGradeText(patchText);
      setIsParsing(false);
      setIsMatching(true);
      
      const results = matchGradesToStudents(parsedStats, students);
      setMatchedResults(results);
    } catch (err: any) {
      setErrorMsg("فشل تحليل النص: " + err.message);
    } finally {
      setIsParsing(false);
      setIsMatching(false);
    }
  };

  const handleManualMatchToggle = (rowId: string, studentId: string | null) => {
    setMatchedResults(prev => prev.map(r => {
      if (r.rowId === rowId) {
        const student = students.find(s => s.uid === studentId);
        return {
          ...r,
          matchedUserId: student?.uid || null,
          matchedUserName: student?.name || null,
          matchScore: student ? 1.0 : 0
        };
      }
      return r;
    }));
  };

  const handleManualDegreeChange = (rowId: string, newDegree: string) => {
    setMatchedResults(prev => prev.map(r => 
      r.rowId === rowId ? { ...r, degree: newDegree } : r
    ));
  };

  const addManualRow = () => {
    const newRowId = `manual_${Date.now()}`;
    setMatchedResults(prev => [{
      rowId: newRowId,
      excelName: 'إدخال يدوي',
      degree: '',
      matchedUserId: null,
      matchedUserName: null,
      matchScore: 0,
      originalRowData: {}
    }, ...prev]);
  };

  const removeRowRowId = (rowId: string) => {
    setMatchedResults(prev => prev.filter(r => r.rowId !== rowId));
  };

  const handleConfirmBatch = async () => {
    if (!matchedResults.length) return;
    setIsSaving(true);
    try {
       if (patchAppealsBatchId) {
         await patchDegreeBatchClient(patchAppealsBatchId, matchedResults);
         setPatchAppealsBatchId(null);
       } else {
         const allStudentIds = students.map(s => s.uid);
         await confirmDegreeBatchClient(examName, matchedResults, Number(maxDegree) || 100, material, editBatchId || undefined, allStudentIds, effectiveStageId, yearLabel);
       }
       setMatchedResults([]);
       setExamName('');
       setMaterial('');
       setMaxDegree('100');
       setEditBatchId(null);
       setTab('history');
    } catch (err: any) {
      setErrorMsg("فشل الحفظ: " + err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleUndo = async (batchId: string) => {
    setIsDeleting(true);
    setErrorMsg('');
    try {
      await undoDegreeBatch(batchId);
      if (editBatchId === batchId) setEditBatchId(null);
      setConfirmingBatchId(null);
    } catch (err: any) {
      setErrorMsg("فشل التراجع: " + err.message);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleEditBatch = async (batch: any) => {
    setIsDeleting(true);
    setErrorMsg('');
    try {
      const examId = `exam_${batch.id}`;
      const results: MatchedResult[] = [];
      const studentIds = Array.from(new Set(batch.studentIds || [])) as string[];
      const chunkSize = 10;
      for (let i = 0; i < studentIds.length; i += chunkSize) {
         const chunk = studentIds.slice(i, i + chunkSize);
         const promises = chunk.map((uid: string) => getDoc(doc(db, `degrees/${uid}/exams/${examId}`)));
         const docs = await Promise.all(promises);
         
         docs.forEach((d, idx) => {
            if (d.exists()) {
               const data = d.data();
               const uid = chunk[idx];
               const student = students.find(s => s.uid === uid);
               results.push({
                 rowId: `edit_${uid}`,
                 excelName: student?.originalName || student?.name || 'طالب مجهول',
                 degree: data.degree,
                 matchedUserId: uid,
                 matchedUserName: student?.name || null,
                 matchScore: 1,
                 originalRow: {}
               });
            }
         });
      }
      setMatchedResults(results);
      setExamName(batch.examName);
      setMaterial(batch.material || '');
      setMaxDegree(String(batch.maxDegree || 100));
      setEditBatchId(batch.id);
      setTab('upload');
    } catch (e: any) {
      console.error(e);
      setErrorMsg("حدث خطأ في تحميل الكشف: " + e.message);
    } finally {
      setIsDeleting(false);
    }
  };

  const selectedStudentIds = new Set(matchedResults.map(r => r.matchedUserId).filter(Boolean)) as Set<string>;

  let filteredAndSortedResults = matchedResults.filter(r => {
    if (!resultSearchQuery) return true;
    const query = resultSearchQuery.toLowerCase();
    return (
      r.excelName.toLowerCase().includes(query) ||
      (r.matchedUserName && r.matchedUserName.toLowerCase().includes(query)) ||
      (r.matchedUserOriginalName && r.matchedUserOriginalName.toLowerCase().includes(query))
    );
  });

  filteredAndSortedResults.sort((a, b) => {
    if (sortUnmatchedFirst && resultSortType === 'default') {
      const aMatched = !!a.matchedUserId;
      const bMatched = !!b.matchedUserId;
      if (aMatched === bMatched) return 0;
      return aMatched ? 1 : -1;
    }
    if (resultSortType === 'highest') {
       const da = parseFloat(String(a.degree)) || 0;
       const db = parseFloat(String(b.degree)) || 0;
       return db - da; // highest first
    }
    if (resultSortType === 'lowest') {
       const da = parseFloat(String(a.degree)) || 0;
       const db = parseFloat(String(b.degree)) || 0;
       return da - db; // lowest first
    }
    return 0;
  });

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" dir="rtl">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="bg-white dark:bg-zinc-900 rounded-3xl w-full max-w-4xl max-h-[90vh] overflow-y-auto shadow-2xl relative"
          >
            <button
              onClick={onClose}
              className="absolute top-4 right-4 p-2 text-gray-400 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-full transition-colors z-10"
            >
              <X className="w-6 h-6" />
            </button>

            <div className="p-4 sm:p-6 lg:p-8">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
                <h1 className="text-2xl font-bold dark:text-white mt-1">إدارة الدرجات والسعيّات</h1>
                <div className="flex items-center gap-2 bg-gray-100 dark:bg-zinc-800 p-1 rounded-lg">
                  <button 
                    className={`px-4 py-2 rounded-md font-medium text-sm transition-colors ${tab === 'upload' ? 'bg-white dark:bg-zinc-700 shadow text-emerald-600 dark:text-emerald-400' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400'}`}
                    onClick={() => {
                        setTab('upload');
                        setEditBatchId(null);
                        setPatchAppealsBatchId(null);
                        setMatchedResults([]);
                        setExamName('');
                        setMaterial('');
                    }}
                  >
                    رفع كشف جديد
                  </button>
                  <button 
                    className={`px-4 py-2 rounded-md font-medium text-sm transition-colors ${tab === 'history' ? 'bg-white dark:bg-zinc-700 shadow text-emerald-600 dark:text-emerald-400' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400'}`}
                    onClick={() => setTab('history')}
                  >
                    سجل الكشوفات
                  </button>
                </div>
              </div>

      {errorMsg && (
        <div className="bg-red-50 dark:bg-red-900/20 text-red-600 p-4 rounded-lg mb-6 flex items-center gap-2 border border-red-100 dark:border-red-900/30">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <p>{errorMsg}</p>
        </div>
      )}

      {tab === 'upload' && (
        <div className="space-y-6">
          {editBatchId && (
            <div className="bg-sky-50 dark:bg-sky-900/30 border border-sky-200 dark:border-sky-800 text-sky-800 dark:text-sky-300 p-4 rounded-xl flex items-center justify-between">
              <span className="font-bold">أنت الآن تقوم بتعديل كشف محفوظ مسبقاً. سيتم استبدال الكشف القديم عند الحفظ.</span>
              <button 
                onClick={() => {
                  setTab('upload');
                  setEditBatchId(null);
                  setMatchedResults([]);
                  setExamName('');
                  setMaterial('');
                }}
                className="text-sm font-medium hover:underline text-sky-600 dark:text-sky-400"
              >
                إلغاء التعديل
              </button>
            </div>
          )}
          {matchedResults.length === 0 ? (
            <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-gray-100 dark:border-zinc-800 p-6 sm:p-10 text-center">
              <FileSpreadsheet className="w-16 h-16 text-emerald-100 dark:text-emerald-900/50 mx-auto mb-4" />
              <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
                {patchAppealsBatchId ? 'رفع وتعديل درجات المعترضين' : 'رفع نتائج وسعيّات جديدة'}
              </h2>
              <p className="text-gray-500 dark:text-zinc-400 max-w-md mx-auto mb-8">
                {patchAppealsBatchId ? 'قم بلصق الدرجات أو أسماء الطلاب مع الدرجات الجديدة (اسم الطالب، تاب/فاصلة، ثم الدرجة).' : 'قم بتسمية الاختبار، ثم ارفع ملف إكسيل أو CSV. سيحاول النظام تلقائياً مطابقة أسماء الطلاب مع قاعدة البيانات.'}
              </p>

              {!patchAppealsBatchId && (
                <>
                  <div className="max-w-md mx-auto mb-6 flex flex-col sm:flex-row gap-4">
                    <div className="flex-1 text-right">
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">اسم الاختبار أو التقييم *</label>
                      <input 
                        type="text"
                        value={examName}
                        onChange={(e) => setExamName(e.target.value)}
                        placeholder="مثال: سعي الفصل الأول، امتحان الميدترم..."
                        className="w-full px-4 py-3 bg-gray-50 dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 dark:text-white"
                      />
                    </div>
                    <div className="w-full sm:w-32 text-right">
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">الدرجة السقف</label>
                      <input 
                        type="number"
                        value={maxDegree}
                        onChange={(e) => setMaxDegree(e.target.value)}
                        placeholder="100"
                        className="w-full px-4 py-3 bg-gray-50 dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 dark:text-white"
                      />
                    </div>
                  </div>

                  <div className="max-w-md mx-auto mb-8 text-right">
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">المادة الدراسية *</label>
                    <select
                      value={material}
                      onChange={(e) => setMaterial(e.target.value)}
                      className="w-full px-4 py-3 bg-gray-50 dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-xl focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 dark:text-white appearance-none"
                    >
                      <option value="" disabled>اختر المادة الدراسية...</option>
                      {CATEGORIES.map(c => (
                        <option key={c.value} value={c.value}>
                          {TRANSLATIONS.ar[c.labelKey]}
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              )}

              {patchAppealsBatchId ? (
                <div className="max-w-md mx-auto relative group">
                  <textarea 
                    value={patchText}
                    onChange={(e) => setPatchText(e.target.value)}
                    placeholder={'علي أحمد\t10\nمحمد عبد\t8.5'}
                    className="w-full h-40 px-4 py-3 bg-gray-50 dark:bg-zinc-800 border-2 border-dashed border-emerald-300 dark:border-emerald-700/50 rounded-2xl focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 dark:text-white text-right leading-relaxed"
                    dir="auto"
                  />
                  <button 
                    onClick={handleTextMatch}
                    disabled={isParsing || isMatching || !patchText.trim()}
                    className="mt-4 w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold transition-colors disabled:opacity-50 flex justify-center items-center gap-2"
                  >
                   {(isParsing || isMatching) && <RefreshCw className="w-5 h-5 animate-spin" />}
                   معالجة ومطابقة الدرجات
                  </button>
                </div>
              ) : (
                <div className="max-w-md mx-auto relative group">
                  <input 
                    type="file" 
                    accept=".csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel"
                    onChange={handleFileUpload}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                    disabled={isParsing || isMatching}
                  />
                  <div className="bg-emerald-50 border-2 border-dashed border-emerald-300 dark:border-emerald-900/50 dark:bg-emerald-900/10 rounded-2xl p-8 transition-colors group-hover:bg-emerald-100 dark:group-hover:bg-emerald-900/20 flex flex-col items-center justify-center">
                    {(isParsing || isMatching) ? (
                      <RefreshCw className="w-8 h-8 text-emerald-500 animate-spin mb-3" />
                    ) : (
                      <Upload className="w-8 h-8 text-emerald-500 mb-3" />
                    )}
                    <span className="text-emerald-700 dark:text-emerald-400 font-medium">
                      {isParsing ? 'جاري تحليل الملف...' : isMatching ? 'جاري مطابقة الأسماء...' : 'اضغط لاختيار ملف Excel / CSV'}
                    </span>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-gray-100 dark:border-zinc-800 overflow-hidden">
               <div className="p-4 sm:p-6 border-b border-gray-100 dark:border-zinc-800 flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
                 <div>
                   <h2 className="text-lg font-bold text-gray-900 dark:text-white">مراجعة كشف: {examName}</h2>
                   <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 mt-2">
                     <div className="bg-gray-50 dark:bg-zinc-800/80 rounded-lg p-2 sm:p-3 flex flex-wrap gap-x-4 gap-y-2 text-sm border border-gray-100 dark:border-zinc-700/50">
                       <p className="text-gray-600 dark:text-zinc-300">
                         الصفوف: <span className="font-bold text-gray-900 dark:text-white">{matchedResults.length}</span>
                       </p>
                       <p className="text-emerald-700 dark:text-emerald-400">
                         المطابقة مع النظام: <span className="font-bold">{matchedResults.filter(r => r.matchedUserId).length}</span>
                       </p>
                       {(() => {
                          const maxNum = Number(maxDegree);
                          const passedCount = matchedResults.filter(r => 
                            r.matchedUserId && !isNaN(Number(r.degree)) && (Number(r.degree) / maxNum) >= 0.5
                          ).length;
                          const totalMatched = matchedResults.filter(r => r.matchedUserId).length;
                          if (totalMatched > 0 && maxNum > 0 && !isNaN(maxNum)) {
                            const pRate = (passedCount / totalMatched) * 100;
                            return (
                              <p className="text-sky-700 dark:text-sky-400 font-medium whitespace-nowrap">
                                نسبة نجاح الطلاب بالامتحان: <span className="font-bold whitespace-nowrap" dir="ltr">{pRate.toFixed(1)}%</span>
                              </p>
                            );
                          }
                          return null;
                       })()}
                     </div>
                     
                     <div className="flex flex-wrap items-center gap-3">
                       <input
                         type="text"
                         placeholder="بحث عن طالب..."
                         value={resultSearchQuery}
                         onChange={(e) => setResultSearchQuery(e.target.value)}
                         className="px-3 py-1.5 text-sm border border-gray-300 dark:border-zinc-700 rounded-lg dark:bg-zinc-800 focus:ring-emerald-500 focus:border-emerald-500 w-48"
                       />
                       <select
                         value={resultSortType}
                         onChange={(e: any) => setResultSortType(e.target.value)}
                         className="px-3 py-1.5 text-sm border border-gray-300 dark:border-zinc-700 rounded-lg dark:bg-zinc-800 focus:ring-emerald-500 focus:border-emerald-500"
                       >
                         <option value="default">الترتيب الافتراضي</option>
                         <option value="highest">الأعلى درجة أولاً</option>
                         <option value="lowest">الأقل درجة أولاً</option>
                       </select>
                       <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                         <input 
                           type="checkbox" 
                           checked={sortUnmatchedFirst} 
                           onChange={(e) => setSortUnmatchedFirst(e.target.checked)}
                           className="rounded text-emerald-500 focus:ring-emerald-500 cursor-pointer"
                         />
                         <span className="text-gray-600 dark:text-gray-300 font-bold">فرز "غير مطابق" أولاً</span>
                       </label>
                     </div>
                   </div>
                 </div>
                 <div className="flex gap-2 w-full sm:w-auto">
                   <button
                     onClick={addManualRow}
                     disabled={isSaving}
                     className="flex-1 sm:flex-none px-4 py-2 border border-emerald-300 dark:border-emerald-700/50 text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 rounded-xl hover:bg-emerald-100 dark:hover:bg-emerald-900/40 font-medium transition-colors whitespace-nowrap"
                   >
                     + إضافة طالب
                   </button>
                   <button 
                     onClick={() => {
                        setMatchedResults([]);
                        setEditBatchId(null);
                        setPatchAppealsBatchId(null);
                     }}
                     disabled={isSaving}
                     className="flex-1 sm:flex-none px-4 py-2 border border-gray-300 dark:border-zinc-700 text-gray-700 dark:text-gray-300 rounded-xl hover:bg-gray-50 dark:hover:bg-zinc-800 font-medium transition-colors"
                   >
                     إلغاء
                   </button>
                   <button 
                     onClick={handleConfirmBatch}
                     disabled={isSaving}
                     className="flex-1 sm:flex-none px-6 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-medium transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                   >
                     {isSaving ? <RefreshCw className="w-5 h-5 animate-spin" /> : (patchAppealsBatchId ? <RefreshCw className="w-5 h-5" /> : <Save className="w-5 h-5" />)}
                     {patchAppealsBatchId ? 'دمج وتحديث المعترضين' : 'اعتماد وحفظ'}
                   </button>
                 </div>
               </div>

               <div className="overflow-x-auto">
                 <table className="w-full text-sm text-right text-gray-500 dark:text-zinc-400 mt-4">
                   <thead className="text-xs text-gray-700 uppercase bg-gray-50 dark:bg-zinc-800/50 dark:text-zinc-300">
                     <tr>
                       <th className="px-6 py-3">الاسم في الكشف</th>
                       <th className="px-6 py-3">الدرجة</th>
                       <th className="px-6 py-3">المطابقة مع النظام</th>
                       <th className="px-6 py-3">إجراء</th>
                     </tr>
                   </thead>
                   <tbody>
                     {filteredAndSortedResults.map((result) => (
                       <tr key={result.rowId} className="border-b border-gray-50 dark:border-zinc-800 hover:bg-gray-50 dark:hover:bg-zinc-800/50 transition-colors">
                         <td className="px-6 py-4 font-medium text-gray-900 dark:text-white">
                           {result.rowId.startsWith('manual_') ? (
                             <input
                               type="text"
                               value={result.excelName === 'إدخال يدوي' ? '' : result.excelName}
                               onChange={(e) => setMatchedResults(prev => prev.map(r => r.rowId === result.rowId ? { ...r, excelName: e.target.value } : r))}
                               className="w-full max-w-[150px] px-2 py-1 bg-white dark:bg-zinc-900 border border-gray-300 dark:border-zinc-700 rounded-md focus:ring-emerald-500 focus:border-emerald-500 dark:text-white"
                               placeholder="اسم الطالب"
                             />
                           ) : (
                             <div>
                               <div className="font-bold text-gray-900 dark:text-white">📄 {result.excelName}</div>
                               {result.matchedUserId && (
                                 <div className="text-[10px] text-gray-500 dark:text-zinc-400 mt-1 space-y-0.5 border-t border-gray-100 dark:border-zinc-800 pt-1">
                                   <div>👤 الاسم: {result.matchedUserOriginalName || result.matchedUserName}</div>
                                   {result.matchedUserOriginalName && result.matchedUserOriginalName !== result.matchedUserName && (
                                     <div className="text-gray-400 dark:text-zinc-500 text-[9px]">الاسم الحالي: {result.matchedUserName}</div>
                                   )}
                                   <div className="text-sky-600 dark:text-sky-400">🎯 الثقة: {Math.round(result.matchScore * 100)}%</div>
                                 </div>
                               )}
                             </div>
                           )}
                         </td>
                         <td className="px-6 py-4 font-bold text-emerald-600 dark:text-emerald-400">
                           {result.rowId.startsWith('manual_') ? (
                             <input
                               type="text"
                               value={result.degree}
                               onChange={(e) => handleManualDegreeChange(result.rowId, e.target.value)}
                               className="w-20 px-2 py-1 bg-white dark:bg-zinc-900 border border-gray-300 dark:border-zinc-700 rounded-md focus:ring-emerald-500 focus:border-emerald-500 dark:text-white"
                               placeholder="الدرجة"
                             />
                           ) : (
                             result.degree
                           )}
                         </td>
                         <td className="px-6 py-4">
                           <SearchableStudentSelect
                              value={result.matchedUserId || null}
                              onChange={(val) => handleManualMatchToggle(result.rowId, val)}
                              students={students}
                              selectedStudentIds={selectedStudentIds}
                              className={`w-full max-w-[200px] text-sm
                                ${result.matchedUserId && result.matchScore > 0.8 ? 'border-emerald-500 ring-1 ring-emerald-500' : 
                                  result.matchedUserId ? 'border-yellow-400 ring-1 ring-yellow-400' : 'border-red-400 ring-1 ring-red-400'}
                              `}
                           />
                           {result.matchedUserId && result.matchScore < 1 && (
                             <div className="mt-1 text-[10px] text-yellow-600 dark:text-yellow-500">تمت مطابقة تقريبية</div>
                           )}
                         </td>
                         <td className="px-6 py-4">
                           <button onClick={() => removeRowRowId(result.rowId)} className="text-red-500 hover:text-red-700 p-1">
                             <Trash2 className="w-5 h-5" />
                           </button>
                         </td>
                       </tr>
                     ))}
                   </tbody>
                 </table>
               </div>
            </div>
          )}
        </div>
      )}

      {tab === 'history' && (
        <div className="space-y-4">
          {historyYears.length > 1 && (
            <div className="flex flex-wrap items-center gap-2 pb-1">
              <span className="text-sm font-medium text-gray-500 dark:text-zinc-400">السنة الدراسية:</span>
              <button
                onClick={() => setHistoryYear('all')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${historyYear === 'all' ? 'bg-emerald-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700'}`}
              >
                الكل
              </button>
              {historyYears.map(y => (
                <button
                  key={y}
                  onClick={() => setHistoryYear(y)}
                  dir="ltr"
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold font-mono transition-colors ${historyYear === y ? 'bg-emerald-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700'}`}
                >
                  {y}
                </button>
              ))}
            </div>
          )}

          {visibleBatches.length === 0 ? (
            <div className="text-center py-12 text-gray-500 dark:text-zinc-400">لا توجد كشوفات محفوظة مسبقاً</div>
          ) : (
            visibleBatches.map(batch => (
              <div key={batch.id} className="bg-white dark:bg-zinc-900 p-4 sm:p-6 rounded-2xl border border-gray-100 dark:border-zinc-800 shadow-sm flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
                <div>
                  <h3 className="text-lg font-bold text-gray-900 dark:text-white">
                    {batch.examName}
                    {batch.yearLabel && (
                      <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium font-mono bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-400" dir="ltr">
                        {batch.yearLabel}
                      </span>
                    )}
                    {batch.material && (
                      <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400">
                        {TRANSLATIONS.ar[CATEGORIES.find(c => c.value === batch.material)?.labelKey as keyof typeof TRANSLATIONS.ar] || batch.material}
                      </span>
                    )}
                  </h3>
                  <div className="flex gap-4 mt-2 text-sm text-gray-500 dark:text-zinc-400">
                    <span>التاريخ: {batch.createdAt?.toDate ? new Date(batch.createdAt.toDate()).toLocaleDateString('ar-EG') : 'الآن'}</span>
                    <span>الطلاب المقيمين: {batch.stats.matched}</span>
                    {typeof batch.passRate === 'number' && (
                      <span className="font-bold text-emerald-600 dark:text-emerald-400">
                        نسبة النجاح: {batch.passRate.toFixed(1)}%
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {confirmingBatchId === batch.id ? (
                    <>
                      <button 
                        onClick={() => handleUndo(batch.id)}
                        disabled={isDeleting}
                        className="px-4 py-2 text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded-xl font-medium text-sm transition-colors flex items-center gap-2"
                      >
                        {isDeleting ? 'جاري الحذف...' : 'تأكيد الحذف نهائياً'}
                      </button>
                      <button 
                        onClick={() => setConfirmingBatchId(null)}
                        disabled={isDeleting}
                        className="px-4 py-2 text-gray-700 dark:text-gray-300 bg-gray-100 hover:bg-gray-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 disabled:opacity-50 rounded-xl font-medium text-sm transition-colors"
                      >
                        إلغاء
                      </button>
                    </>
                  ) : (
                    <>
                      <button 
                        onClick={() => {
                          setPatchAppealsBatchId(batch.id);
                          setEditBatchId(null);
                          setExamName(batch.examName);
                          setMaterial(batch.material || '');
                          setMaxDegree(String(batch.maxDegree || 100));
                          setMatchedResults([]);
                          setTab('upload');
                        }}
                        disabled={isDeleting}
                        className="px-4 py-2 text-indigo-600 bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-900/20 dark:text-indigo-400 dark:hover:bg-indigo-900/40 rounded-xl font-medium text-sm transition-colors flex items-center gap-2"
                      >
                        <RefreshCw className="w-4 h-4" />
                        رفع درجات المحجوبين والاعتراض
                      </button>
                      <button 
                        onClick={() => handleEditBatch(batch)}
                        disabled={isDeleting}
                        className="px-4 py-2 text-sky-600 bg-sky-50 hover:bg-sky-100 dark:bg-sky-900/20 dark:text-sky-400 dark:hover:bg-sky-900/40 rounded-xl font-medium text-sm transition-colors flex items-center gap-2"
                      >
                        <Edit2 className="w-4 h-4" />
                        تعديل الكشف
                      </button>
                      <button 
                        onClick={() => setConfirmingBatchId(batch.id)}
                        className="px-4 py-2 text-red-600 bg-red-50 hover:bg-red-100 dark:bg-red-900/20 dark:hover:bg-red-900/40 rounded-xl font-medium text-sm transition-colors flex items-center gap-2"
                      >
                        <Undo className="w-4 h-4" />
                        حذف الكشف والتراجع
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
