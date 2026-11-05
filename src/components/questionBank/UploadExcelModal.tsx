import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { collection, query, getDocs } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { 
  X, 
  Upload, 
  Download, 
  Loader2, 
  Edit3, 
  Save, 
  CheckCircle, 
  FileSpreadsheet, 
  AlertTriangle, 
  CheckCircle2, 
  Trash2, 
  Filter, 
  ChevronDown, 
  ChevronUp, 
  RefreshCw 
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { QuestionScope, QuestionTag, Difficulty } from '../../types/questionBank.types';
import { CATEGORIES, TRANSLATIONS, COURSE_IDS, COURSE_LABELS } from '../../types';
import { useStageSubjects } from '../../hooks/useStageSubjects';
import { useStageContext } from '../../contexts/StageContext';
import { subjectMetaFrom, subjectSlugOf, subjectsForCourse } from '../../lib/subjectDisplay';
import { 
  parseQuestionBankExcel, 
  downloadQuestionBankTemplate, 
  ParsedExcelQuestion 
} from '../../services/questionBankExcelService';
import { batchAddBankQuestions, bankLectureIdFor, NewBankQuestionInput, sendDoctorQuestionsNotification } from '../../services/questionBankService';

const ALL_TAGS: QuestionTag[] = ['وزاري', 'سنين_سابقة', 'سؤال_الدكتور', 'مهم', 'متوقع'];

interface UploadExcelModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdded: () => void;
}

type Stage = 'upload' | 'review' | 'saving' | 'done';
type ReviewFilter = 'all' | 'valid' | 'invalid';

export default function UploadExcelModal({ isOpen, onClose, onAdded }: UploadExcelModalProps) {
  const [stage, setStage] = useState<Stage>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Categorization / Scope
  const [scope, setScope] = useState<QuestionScope>('subject');
  const [subjectId, setSubjectId] = useState<string>('');
  const [lectureId, setLectureId] = useState<string>('');
  const [tags, setTags] = useState<Set<QuestionTag>>(new Set());
  const [customTag, setCustomTag] = useState<string>('');
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [lectures, setLectures] = useState<any[]>([]);
  const [notifyStudents, setNotifyStudents] = useState<boolean>(true);

  const { effectiveStageId } = useStageContext();
  const { subjects } = useStageSubjects();
  const hasCurriculum = subjects.length > 0;
  const subjectMeta = subjectMetaFrom(subjects, subjectId);

  // Review & Questions Data
  const [questions, setQuestions] = useState<ParsedExcelQuestion[]>([]);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('all');
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [completedSaves, setCompletedSaves] = useState(0);
  const [totalToSave, setTotalToSave] = useState(0);

  useEffect(() => {
    if (isOpen) {
      setStage('upload');
      setFile(null);
      setError(null);
      setQuestions([]);
      setCompletedSaves(0);
      setTotalToSave(0);
      setScope('subject');
      setSubjectId('');
      setLectureId('');
      setTags(new Set());
      setReviewFilter('all');
      setExpandedIndex(null);

      getDocs(query(collection(db, 'lectures')))
        .then(snap => {
          setLectures(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        })
        .catch(err => {
          console.error('[UploadExcelModal] Failed to fetch lectures', err);
        });
    }
  }, [isOpen]);

  const toggleTag = (tag: QuestionTag) => {
    const newTags = new Set(tags);
    if (newTags.has(tag)) newTags.delete(tag);
    else newTags.add(tag);
    setTags(newTags);
  };

  const handleFileProcess = async (selectedFile: File) => {
    const validExtensions = ['.xlsx', '.xls', '.csv', '.ods'];
    const hasValidExt = validExtensions.some(ext => selectedFile.name.toLowerCase().endsWith(ext));
    if (!hasValidExt) {
      setError('يرجى اختيار ملف Excel بصيغة (.xlsx أو .xls أو .csv)');
      return;
    }

    if (!subjectId) {
      setError('يرجى اختيار المادة الدراسية أولاً قبل معالجة الملف.');
      return;
    }

    if (scope === 'lecture' && !lectureId) {
      setError('يرجى اختيار المحاضرة التابعة للأسئلة.');
      return;
    }

    setFile(selectedFile);
    setIsParsing(true);
    setError(null);

    try {
      const result = await parseQuestionBankExcel(selectedFile, difficulty);
      if (result.questions.length === 0) {
        throw new Error('لم يتم العثور على أي أسئلة صالحة في الملف المرفق. تأكد من احتواء الملف على أعمدة الأسئلة.');
      }
      setQuestions(result.questions);
      setStage('review');
    } catch (err: any) {
      console.error('[UploadExcelModal] Parse error:', err);
      setError(err?.message || 'فشل في قراءة ملف الـ Excel. يرجى مراجعة الأعمدة وإعادة المحاولة.');
    } finally {
      setIsParsing(false);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileProcess(e.dataTransfer.files[0]);
    }
  };

  // Re-validates a single question whenever the user edits it on screen
  const revalidateQuestion = (q: ParsedExcelQuestion): ParsedExcelQuestion => {
    const errors: string[] = [];
    if (!q.stem || !q.stem.trim()) {
      errors.push('نص السؤال فارغ');
    }

    const validChoices = q.choices.filter(c => c.text && c.text.trim() !== '');
    if (validChoices.length < 2) {
      errors.push('يجب توفر خيارين على الأقل');
    }

    if (!q.correctAnswer || !q.correctAnswer.trim()) {
      errors.push('لم يتم تحديد الإجابة الصحيحة');
    } else {
      const match = validChoices.some(
        c => c.text.trim().toLowerCase() === q.correctAnswer.trim().toLowerCase()
      );
      if (!match) {
        errors.push('الإجابة الصحيحة لا تطابق أي خيار من الخيارات المتوفرة');
      }
    }

    return {
      ...q,
      isValid: errors.length === 0,
      errors
    };
  };

  const updateQuestionField = (id: string, field: keyof ParsedExcelQuestion, value: any) => {
    setQuestions(prev => prev.map(q => {
      if (q.id !== id) return q;
      const updated = { ...q, [field]: value };
      return revalidateQuestion(updated);
    }));
  };

  const updateChoiceText = (questionId: string, choiceIndex: number, newText: string) => {
    setQuestions(prev => prev.map(q => {
      if (q.id !== questionId) return q;
      const oldText = q.choices[choiceIndex]?.text;
      const newChoices = q.choices.map((c, i) => i === choiceIndex ? { ...c, text: newText } : c);
      let newAnswer = q.correctAnswer;
      // If the edited choice was previously the correct answer, keep it synchronized
      if (oldText && q.correctAnswer === oldText) {
        newAnswer = newText;
      }
      const updated = { ...q, choices: newChoices, correctAnswer: newAnswer };
      return revalidateQuestion(updated);
    }));
  };

  const selectCorrectAnswer = (questionId: string, choiceText: string) => {
    updateQuestionField(questionId, 'correctAnswer', choiceText);
  };

  const deleteQuestion = (id: string) => {
    setQuestions(prev => prev.filter(q => q.id !== id));
  };

  const removeAllInvalid = () => {
    setQuestions(prev => prev.filter(q => q.isValid));
  };

  // Batch Save to Firestore
  const handleSaveToBank = async () => {
    const validQuestions = questions.filter(q => q.isValid);
    if (validQuestions.length === 0) {
      setError('لا توجد أي أسئلة صالحة للحفظ. يرجى تصحيح الأخطاء أولاً.');
      return;
    }

    setStage('saving');
    setError(null);
    setCompletedSaves(0);
    setTotalToSave(validQuestions.length);

    const defaultTagsList = Array.from(tags) as QuestionTag[];
    const selectedLecture = lectures.find(l => l.id === lectureId);
    const resolvedLectureId = selectedLecture ? bankLectureIdFor(selectedLecture) : lectureId;
    const resolvedStageId = effectiveStageId || (subjectMeta as any)?.stageId || null;

    const payloads: NewBankQuestionInput[] = validQuestions.map(q => {
      // Merge file tags with modal default tags
      const combinedTags = Array.from(new Set([...defaultTagsList, ...q.tags]));
      const validChoices = q.choices
        .filter(c => typeof c.text === 'string' && c.text.trim() !== '')
        .map((c, idx) => ({
          label: String.fromCharCode(65 + idx),
          text: c.text.trim()
        }));

      return {
        scope,
        subjectId,
        stageId: resolvedStageId,
        courseId: subjectMeta?.courseId || null,
        subjectName: subjectMeta?.subjectName || null,
        subjectNameAr: subjectMeta?.subjectNameAr || null,
        lectureId: scope === 'lecture' ? resolvedLectureId : null,
        tags: combinedTags,
        year: null,
        type: q.type || 'mcq',
        stemFormat: q.stemFormat || 'standard',
        stem: q.stem.trim(),
        choices: validChoices,
        correctAnswer: q.correctAnswer.trim(),
        explanation: q.explanation ? q.explanation.trim() : '',
        difficulty: q.difficulty || difficulty,
        isActive: true
      };
    });

    try {
      await batchAddBankQuestions(payloads, (saved) => {
        setCompletedSaves(saved);
      });

      const hasDoctorTag = payloads.some(p => p.tags?.includes('سؤال_الدكتور'));
      if (notifyStudents && hasDoctorTag && scope === 'lecture' && resolvedLectureId) {
        try {
          const lecObj = lectures.find(l => l.id === lectureId);
          const lecTitle = lecObj?.title || 'المحاضرة';
          await sendDoctorQuestionsNotification({
            lectureId: resolvedLectureId,
            lectureTitle: lecTitle,
            stageId: resolvedStageId || undefined,
            subjectId: subjectId || undefined,
          });
        } catch (notifErr) {
          console.error('[UploadExcelModal] Notification failed:', notifErr);
        }
      }

      setStage('done');
      setTimeout(() => {
        onAdded();
        onClose();
      }, 1800);
    } catch (err: any) {
      console.error('[UploadExcelModal] Batch save error:', err);
      setError('حدث خطأ أثناء الحفظ في بنك الأسئلة: ' + (err?.message || 'فشلت العملية'));
      setStage('review');
    }
  };

  if (!isOpen) return null;

  const validCount = questions.filter(q => q.isValid).length;
  const invalidCount = questions.length - validCount;

  const filteredQuestions = questions.filter(q => {
    if (reviewFilter === 'valid') return q.isValid;
    if (reviewFilter === 'invalid') return !q.isValid;
    return true;
  });

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-3 sm:p-4 bg-black/50 backdrop-blur-sm" dir="rtl">
      <motion.div 
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="bg-white dark:bg-zinc-900 w-full max-w-5xl rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh] border border-gray-100 dark:border-zinc-800"
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-100 dark:border-zinc-800 bg-sky-50 dark:bg-sky-950/30">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-sky-600 text-white rounded-xl shadow-sm">
              <FileSpreadsheet className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900 dark:text-white flex items-center gap-2">
                استيراد الأسئلة من ملف Excel
                {stage === 'review' && (
                  <span className="text-xs font-normal bg-sky-100 dark:bg-sky-900/50 text-sky-800 dark:text-sky-300 px-2.5 py-0.5 rounded-full">
                    مراجعة {questions.length} سؤال
                  </span>
                )}
              </h2>
              <p className="text-xs text-gray-500 dark:text-zinc-400">
                استيراد دفعات الأسئلة وقوالب الـ MCQ وصح/خطأ مع التحقق الفوري
              </p>
            </div>
          </div>

          <button 
            onClick={onClose} 
            disabled={['saving'].includes(stage)} 
            className="p-2 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-full transition-colors text-gray-500 disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          <AnimatePresence mode="wait">
            {/* STAGE 1: UPLOAD & SETUP */}
            {stage === 'upload' && (
              <motion.div
                key="upload"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="space-y-6"
              >
                {/* Download Template Banner */}
                <div className="p-4 bg-gradient-to-r from-sky-50 to-indigo-50 dark:from-sky-950/40 dark:to-indigo-950/40 rounded-2xl border border-sky-100 dark:border-sky-900/40 flex flex-col sm:flex-row items-center justify-between gap-4">
                  <div className="flex items-center gap-3.5">
                    <div className="p-3 bg-white dark:bg-zinc-800 text-sky-600 rounded-xl shadow-sm border border-sky-100 dark:border-zinc-700">
                      <Download className="w-6 h-6" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-gray-900 dark:text-white">
                        هل تحتاج إلى نموذج Excel جاهز ومنسق؟
                      </h3>
                      <p className="text-xs text-gray-600 dark:text-zinc-300 mt-0.5">
                        حمّل القالب المعتمد الذي يتضمن أعمدة الأسئلة، الخيارات (A-E)، الإجابات الصحيحة، وأمثلة توضيحية.
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => downloadQuestionBankTemplate()}
                    className="w-full sm:w-auto px-4 py-2.5 bg-sky-600 hover:bg-sky-700 text-white rounded-xl text-xs font-bold transition-all shadow-sm flex items-center justify-center gap-2 whitespace-nowrap shrink-0"
                  >
                    <Download className="w-4 h-4" />
                    تحميل القالب المعتمد (.xlsx)
                  </button>
                </div>

                {/* Scope & Metadata Selection */}
                <div className="bg-gray-50 dark:bg-zinc-800/60 p-4 sm:p-5 rounded-2xl border border-gray-200 dark:border-zinc-700 space-y-4">
                  <div className="flex items-center justify-between border-b border-gray-200 dark:border-zinc-700 pb-3">
                    <span className="text-sm font-bold text-gray-800 dark:text-zinc-200">
                      1. تحديد نطاق ومادة الأسئلة
                    </span>
                    <div className="flex items-center gap-1 bg-white dark:bg-zinc-800 p-1 rounded-xl border border-gray-200 dark:border-zinc-700 text-xs font-bold">
                      <button
                        type="button"
                        onClick={() => setScope('subject')}
                        className={`px-3 py-1.5 rounded-lg transition-colors ${
                          scope === 'subject'
                            ? 'bg-sky-600 text-white shadow-sm'
                            : 'text-gray-600 dark:text-zinc-400 hover:text-gray-900'
                        }`}
                      >
                        مادة كاملة
                      </button>
                      <button
                        type="button"
                        onClick={() => setScope('lecture')}
                        className={`px-3 py-1.5 rounded-lg transition-colors ${
                          scope === 'lecture'
                            ? 'bg-sky-600 text-white shadow-sm'
                            : 'text-gray-600 dark:text-zinc-400 hover:text-gray-900'
                        }`}
                      >
                        محاضرة محددة
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-bold text-gray-700 dark:text-zinc-300 mb-1.5">
                        المادة الدراسية <span className="text-red-500">*</span>
                      </label>
                      <select 
                        value={subjectId} 
                        onChange={e => setSubjectId(e.target.value)}
                        className="w-full p-2.5 rounded-xl border border-gray-300 dark:border-zinc-700 bg-white dark:bg-zinc-850 text-sm focus:ring-2 focus:ring-sky-500 transition-all"
                      >
                        <option value="">-- اختر المادة الدراسية --</option>
                        {hasCurriculum
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
                          : CATEGORIES.map(c => <option key={c.value} value={c.value}>{TRANSLATIONS['ar'][c.labelKey]}</option>)}
                      </select>
                    </div>

                    {scope === 'lecture' && (
                      <div>
                        <label className="block text-xs font-bold text-gray-700 dark:text-zinc-300 mb-1.5">
                          المحاضرة <span className="text-red-500">*</span>
                        </label>
                        <select 
                          value={lectureId} 
                          onChange={e => setLectureId(e.target.value)}
                          className="w-full p-2.5 rounded-xl border border-gray-300 dark:border-zinc-700 bg-white dark:bg-zinc-850 text-sm focus:ring-2 focus:ring-sky-500 transition-all"
                        >
                          <option value="">-- اختر محاضرة --</option>
                          {lectures.filter(l => subjectSlugOf(l) === subjectId).map(l => (
                            <option key={l.id} value={l.id}>{l.title}</option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>

                  {/* Difficulty & Tags */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                    <div>
                      <label className="block text-xs font-bold text-gray-700 dark:text-zinc-300 mb-1.5">
                        الصعوبة الافتراضية (إذا لم تكن محددة بالملف)
                      </label>
                      <select 
                        value={difficulty} 
                        onChange={e => setDifficulty(e.target.value as Difficulty)}
                        className="w-full p-2.5 rounded-xl border border-gray-300 dark:border-zinc-700 bg-white dark:bg-zinc-850 text-sm"
                      >
                        <option value="easy">سهل (Easy)</option>
                        <option value="medium">متوسط (Medium)</option>
                        <option value="hard">صعب (Hard)</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-bold text-gray-700 dark:text-zinc-300 mb-1.5">
                        الوسوم الافتراضية
                      </label>
                      <div className="flex flex-wrap gap-1.5">
                        {ALL_TAGS.map(tag => (
                          <button
                            key={tag}
                            type="button"
                            onClick={() => toggleTag(tag)}
                            className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all border ${
                              tags.has(tag) 
                              ? 'border-sky-500 bg-sky-50 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300' 
                              : 'border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-gray-600 dark:text-zinc-400'
                            }`}
                          >
                            {tag.replace('_', ' ')}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Dropzone */}
                <div>
                  <div className="text-sm font-bold text-gray-800 dark:text-zinc-200 mb-2">
                    2. رفع ملف الـ Excel
                  </div>
                  <div
                    onDragOver={e => e.preventDefault()}
                    onDrop={handleDrop}
                    className="border-2 border-dashed border-gray-300 dark:border-zinc-700 hover:border-sky-500 dark:hover:border-sky-500 rounded-2xl p-8 text-center transition-all bg-gray-50/50 dark:bg-zinc-800/30 flex flex-col items-center justify-center cursor-pointer group"
                    onClick={() => document.getElementById('excel-file-input')?.click()}
                  >
                    <input
                      id="excel-file-input"
                      type="file"
                      accept=".xlsx,.xls,.csv,.ods"
                      className="hidden"
                      onChange={e => {
                        if (e.target.files && e.target.files[0]) {
                          handleFileProcess(e.target.files[0]);
                        }
                      }}
                    />

                    {isParsing ? (
                      <div className="flex flex-col items-center gap-3">
                        <Loader2 className="w-10 h-10 text-sky-600 animate-spin" />
                        <span className="text-sm font-bold text-gray-700 dark:text-zinc-300">
                          جاري قراءة وتحليل أعمدة ملف الـ Excel...
                        </span>
                      </div>
                    ) : (
                      <>
                        <div className="p-4 bg-sky-50 dark:bg-sky-900/30 text-sky-600 dark:text-sky-400 rounded-2xl mb-3 group-hover:scale-105 transition-transform">
                          <Upload className="w-8 h-8" />
                        </div>
                        <h4 className="text-sm font-bold text-gray-800 dark:text-zinc-200">
                          اسحب ملف Excel هنا أو اضغط للاختيار من جهازك
                        </h4>
                        <p className="text-xs text-gray-500 dark:text-zinc-400 mt-1">
                          يدعم صيغ .xlsx و .xls و .csv (حتى 500 سؤال في الملف الواحد)
                        </p>
                      </>
                    )}
                  </div>
                </div>

                {error && (
                  <div className="p-3.5 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl text-xs text-red-600 dark:text-red-400 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}
              </motion.div>
            )}

            {/* STAGE 2: REVIEW & VALIDATION */}
            {stage === 'review' && (
              <motion.div
                key="review"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="space-y-4"
              >
                {/* Review Header Controls */}
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 bg-gray-50 dark:bg-zinc-800/80 p-3.5 rounded-2xl border border-gray-200 dark:border-zinc-700">
                  {/* Status Pills */}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setReviewFilter('all')}
                      className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${
                        reviewFilter === 'all'
                          ? 'bg-slate-800 text-white dark:bg-white dark:text-slate-900'
                          : 'bg-white dark:bg-zinc-700 text-slate-700 dark:text-zinc-300 border border-gray-200 dark:border-zinc-600'
                      }`}
                    >
                      الكل ({questions.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setReviewFilter('valid')}
                      className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 ${
                        reviewFilter === 'valid'
                          ? 'bg-emerald-600 text-white'
                          : 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800'
                      }`}
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      صالحة ({validCount})
                    </button>
                    {invalidCount > 0 && (
                      <button
                        type="button"
                        onClick={() => setReviewFilter('invalid')}
                        className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 ${
                          reviewFilter === 'invalid'
                            ? 'bg-red-600 text-white'
                            : 'bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800'
                        }`}
                      >
                        <AlertTriangle className="w-3.5 h-3.5" />
                        تحتاج مراجعة ({invalidCount})
                      </button>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 self-end sm:self-auto">
                    {invalidCount > 0 && (
                      <button
                        onClick={removeAllInvalid}
                        className="px-3 py-1.5 text-xs font-bold text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-xl transition-colors flex items-center gap-1"
                        title="حذف جميع الأسئلة غير الصالحة دفعة واحدة"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        حذف غير الصالحة ({invalidCount})
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setStage('upload');
                        setQuestions([]);
                      }}
                      className="px-3 py-1.5 text-xs font-bold text-gray-600 dark:text-zinc-300 hover:bg-gray-200 dark:hover:bg-zinc-700 rounded-xl transition-colors flex items-center gap-1"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      ملف آخر
                    </button>
                  </div>
                </div>

                {error && (
                  <div className="p-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl text-xs text-red-600 dark:text-red-400">
                    {error}
                  </div>
                )}

                {/* Questions List */}
                <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-1">
                  {filteredQuestions.length === 0 ? (
                    <div className="p-8 text-center text-gray-400 text-xs">
                      لا توجد أسئلة ضمن هذا الفلتر.
                    </div>
                  ) : (
                    filteredQuestions.map((q, idx) => {
                      const isExpanded = expandedIndex === idx;
                      return (
                        <div 
                          key={q.id}
                          className={`p-4 rounded-xl border transition-all ${
                            q.isValid
                              ? 'bg-white dark:bg-zinc-800/80 border-gray-200 dark:border-zinc-700'
                              : 'bg-red-50/50 dark:bg-red-950/20 border-red-200 dark:border-red-900/50'
                          }`}
                        >
                          {/* Question Card Top Row */}
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-gray-100 dark:bg-zinc-700 text-gray-600 dark:text-zinc-300">
                                #{q.rowNumber}
                              </span>
                              {q.isValid ? (
                                <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/30 px-2 py-0.5 rounded">
                                  <CheckCircle2 className="w-3 h-3" /> صالح
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 text-[11px] font-bold text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-900/40 px-2 py-0.5 rounded">
                                  <AlertTriangle className="w-3 h-3" /> خطأ
                                </span>
                              )}
                              <span className="text-[11px] px-2 py-0.5 rounded bg-sky-50 dark:bg-sky-900/30 text-sky-700 dark:text-sky-300 font-bold">
                                {q.type === 'true_false' ? 'صح/خطأ' : 'MCQ'}
                              </span>
                              <span className="text-[11px] text-gray-400">
                                {q.difficulty}
                              </span>
                            </div>

                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => setExpandedIndex(isExpanded ? null : idx)}
                                className="text-xs text-sky-600 hover:text-sky-700 font-bold flex items-center gap-0.5"
                              >
                                {isExpanded ? (
                                  <>إغلاق التعديل <ChevronUp className="w-3.5 h-3.5" /></>
                                ) : (
                                  <>تعديل سريع <ChevronDown className="w-3.5 h-3.5" /></>
                                )}
                              </button>
                              <button
                                onClick={() => deleteQuestion(q.id)}
                                className="p-1 text-gray-400 hover:text-red-600 rounded transition-colors"
                                title="حذف هذا السؤال"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>

                          {/* Errors Alert if Invalid */}
                          {!q.isValid && q.errors.length > 0 && (
                            <div className="mt-2.5 p-2 bg-red-100/70 dark:bg-red-950/60 rounded-lg text-xs text-red-700 dark:text-red-300 space-y-0.5">
                              {q.errors.map((err, errIdx) => (
                                <div key={errIdx} className="flex items-center gap-1.5">
                                  <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
                                  <span>{err}</span>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Stem Display / Edit */}
                          <div className="mt-3">
                            {isExpanded ? (
                              <div>
                                <label className="block text-[11px] font-bold text-gray-500 mb-1">
                                  نص السؤال:
                                </label>
                                <textarea
                                  value={q.stem}
                                  onChange={e => updateQuestionField(q.id, 'stem', e.target.value)}
                                  className="w-full p-2.5 text-sm rounded-xl border border-gray-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-gray-900 dark:text-white"
                                  rows={2}
                                />
                              </div>
                            ) : (
                              <p className="text-sm font-semibold text-gray-800 dark:text-zinc-200 line-clamp-2" dir="auto">
                                {q.stem || <span className="text-red-500 italic">بدون نص سؤال</span>}
                              </p>
                            )}
                          </div>

                          {/* Choices Preview / Edit */}
                          <div className="mt-3 space-y-1.5">
                            <span className="text-[11px] font-bold text-gray-500 block mb-1">
                              الخيارات (انقر لتحديد الإجابة الصحيحة):
                            </span>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                              {q.choices.map((c, cIdx) => {
                                const isCorrect = q.correctAnswer.trim().toLowerCase() === c.text.trim().toLowerCase() && c.text.trim() !== '';
                                return (
                                  <div
                                    key={cIdx}
                                    onClick={() => !isExpanded && selectCorrectAnswer(q.id, c.text)}
                                    className={`p-2 rounded-xl text-xs flex items-center gap-2 border transition-all ${
                                      !isExpanded ? 'cursor-pointer hover:border-sky-400' : ''
                                    } ${
                                      isCorrect
                                        ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-500 text-emerald-800 dark:text-emerald-300 font-bold'
                                        : 'bg-gray-50 dark:bg-zinc-800/40 border-gray-200 dark:border-zinc-700 text-gray-700 dark:text-zinc-300'
                                    }`}
                                  >
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        selectCorrectAnswer(q.id, c.text);
                                      }}
                                      className={`w-5 h-5 rounded-full flex items-center justify-center font-bold text-[10px] shrink-0 ${
                                        isCorrect
                                          ? 'bg-emerald-600 text-white'
                                          : 'bg-gray-200 dark:bg-zinc-700 text-gray-600 dark:text-zinc-300'
                                      }`}
                                    >
                                      {c.label}
                                    </button>

                                    {isExpanded ? (
                                      <input
                                        type="text"
                                        value={c.text}
                                        onChange={e => updateChoiceText(q.id, cIdx, e.target.value)}
                                        className="flex-1 bg-white dark:bg-zinc-900 border border-gray-300 dark:border-zinc-700 rounded-lg p-1 text-xs"
                                        placeholder={`نص الخيار ${c.label}`}
                                      />
                                    ) : (
                                      <span className="flex-1 truncate" dir="auto">
                                        {c.text || <span className="text-gray-400 italic">فارغ</span>}
                                      </span>
                                    )}

                                    {isCorrect && (
                                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300 font-bold shrink-0">
                                        الإجابة الصحيحة
                                      </span>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>

                          {/* Explanation if present or in edit mode */}
                          {isExpanded && (
                            <div className="mt-3">
                              <label className="block text-[11px] font-bold text-gray-500 mb-1">
                                التفسير / الشرح (اختياري):
                              </label>
                              <input
                                type="text"
                                value={q.explanation}
                                onChange={e => updateQuestionField(q.id, 'explanation', e.target.value)}
                                className="w-full p-2 text-xs rounded-lg border border-gray-300 dark:border-zinc-700 bg-white dark:bg-zinc-900"
                                placeholder="اكتب تفسير السؤال هنا..."
                              />
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </motion.div>
            )}

            {/* STAGE 3: SAVING PROGRESS */}
            {stage === 'saving' && (
              <motion.div
                key="saving"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="py-12 flex flex-col items-center justify-center text-center space-y-4"
              >
                <div className="p-4 bg-sky-50 dark:bg-sky-900/30 text-sky-600 rounded-2xl animate-pulse">
                  <Loader2 className="w-12 h-12 animate-spin" />
                </div>
                <h3 className="text-base font-bold text-gray-900 dark:text-white">
                  جاري حفظ الأسئلة في بنك الأسئلة...
                </h3>
                <p className="text-xs text-gray-500 dark:text-zinc-400 max-w-sm">
                  يتم الحفظ بنظام الدفعات الآمن (Batch Commits) لضمان سرعة واستقرار البيانات وعدم فقدان أي سؤال.
                </p>

                {/* Progress Bar */}
                <div className="w-full max-w-md bg-gray-200 dark:bg-zinc-700 rounded-full h-3 overflow-hidden mt-2">
                  <div 
                    className="bg-sky-600 h-full transition-all duration-300 rounded-full"
                    style={{ width: `${totalToSave > 0 ? (completedSaves / totalToSave) * 100 : 0}%` }}
                  />
                </div>
                <span className="text-xs font-mono font-bold text-gray-600 dark:text-zinc-400">
                  تم حفظ {completedSaves} من {totalToSave} سؤال ({totalToSave > 0 ? Math.round((completedSaves / totalToSave) * 100) : 0}%)
                </span>
              </motion.div>
            )}

            {/* STAGE 4: DONE */}
            {stage === 'done' && (
              <motion.div
                key="done"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                className="py-12 flex flex-col items-center justify-center text-center space-y-3"
              >
                <div className="p-4 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 rounded-full shadow-sm">
                  <CheckCircle className="w-14 h-14" />
                </div>
                <h3 className="text-lg font-bold text-gray-900 dark:text-white">
                  تم الاستيراد بنجاح!
                </h3>
                <p className="text-xs text-gray-500 dark:text-zinc-400">
                  تمت إضافة {completedSaves} سؤال بنجاح إلى بنك الأسئلة.
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Modal Footer Controls */}
        <div className="p-4 border-t border-gray-100 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-850 flex items-center justify-between">
          <button
            onClick={onClose}
            disabled={stage === 'saving'}
            className="px-4 py-2 text-xs font-bold text-gray-600 dark:text-zinc-300 hover:bg-gray-200 dark:hover:bg-zinc-750 rounded-xl transition-colors disabled:opacity-50"
          >
            إلغاء
          </button>

          {stage === 'review' && (
            <div className="flex items-center gap-3">
              {(tags.has('سؤال_الدكتور') || questions.some(q => q.tags?.includes('سؤال_الدكتور'))) && scope === 'lecture' && (
                <label className="flex items-center gap-2 cursor-pointer bg-purple-50 dark:bg-purple-950/30 px-3 py-1.5 rounded-xl border border-purple-200 dark:border-purple-800">
                  <input
                    type="checkbox"
                    checked={notifyStudents}
                    onChange={e => setNotifyStudents(e.target.checked)}
                    className="rounded border-purple-300 text-purple-600 focus:ring-purple-500 w-3.5 h-3.5"
                  />
                  <span className="text-[11px] font-bold text-purple-900 dark:text-purple-200">
                    إشعار الطلاب (تعال ادرس)
                  </span>
                </label>
              )}
              <button
                onClick={handleSaveToBank}
                disabled={validCount === 0}
                className="px-5 py-2.5 bg-sky-600 hover:bg-sky-700 text-white rounded-xl text-xs font-bold transition-all shadow-sm flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Save className="w-4 h-4" />
                حفظ الأسئلة الصالحة ({validCount}) في البنك
              </button>
            </div>
          )}
        </div>
      </motion.div>
    </div>,
    document.body
  );
}

