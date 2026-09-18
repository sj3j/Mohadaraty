import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { collection, query, getDocs } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { X, Save } from 'lucide-react';
import { BankQuestion, QuestionScope, QuestionTag, QuestionType, StemFormat, Difficulty, BankChoice } from '../../types/questionBank.types';
import { addBankQuestion, editBankQuestion, bankLectureIdFor } from '../../services/questionBankService';
import { CATEGORIES, TRANSLATIONS, COURSE_IDS, COURSE_LABELS } from '../../types';
import { useStageSubjects } from '../../hooks/useStageSubjects';
import { useStageContext } from '../../contexts/StageContext';
import { subjectMetaFrom, subjectSlugOf, subjectsForCourse } from '../../lib/subjectDisplay';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onAdded: () => void;
  initialData?: BankQuestion | null;
}

const ALL_TAGS: QuestionTag[] = ['وزاري', 'سنين_سابقة', 'سؤال_الدكتور', 'مهم', 'متوقع'];

export default function AddBankQuestionModal({ isOpen, onClose, onAdded, initialData }: Props) {
  const { effectiveStageId } = useStageContext();
  const { subjects } = useStageSubjects();
  const hasCurriculum = subjects.length > 0;

  // 'subject' is now the narrowest a question can be. It used to default to
  // 'global', which wrote subjectId: null and showed the question to all five
  // stages - and it was the DEFAULT, so that happened unless staff changed it.
  const [scope, setScope] = useState<QuestionScope>('subject');
  // No legacy default either: CATEGORIES[0] is 'pharmacology', a stage-3
  // subject, so every stage's questions were pre-tagged with it.
  const [subjectId, setSubjectId] = useState<string>('');
  const [lectureId, setLectureId] = useState<string>('');
  
  const [tags, setTags] = useState<Set<QuestionTag>>(new Set());
  const [customTag, setCustomTag] = useState<string>('');
  const [year, setYear] = useState<string>('');

  const [type, setType] = useState<QuestionType>('mcq');
  const [stemFormat, setStemFormat] = useState<StemFormat>('standard');
  const [stem, setStem] = useState<string>('');
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');

  const [choices, setChoices] = useState<BankChoice[]>([
    { label: 'A', text: '' },
    { label: 'B', text: '' },
    { label: 'C', text: '' },
    { label: 'D', text: '' },
    { label: 'E', text: '' }
  ]);
  const [correctAnswerIndex, setCorrectAnswerIndex] = useState<number>(0);
  const [explanation, setExplanation] = useState<string>('');

  const addChoice = () => {
    const nextLabel = String.fromCharCode(65 + choices.length); // A, B, C...
    setChoices([...choices, { label: nextLabel, text: '' }]);
  };

  const removeChoice = (indexToRemove: number) => {
    if (choices.length <= 2) {
      alert("يجب أن يحتوي السؤال على خيارين على الأقل");
      return;
    }
    const newChoices = choices
      .filter((_, i) => i !== indexToRemove)
      .map((c, i) => ({ ...c, label: String.fromCharCode(65 + i) })); // Re-assign labels A, B, C...
    setChoices(newChoices);
    
    // adjust correct answer index if needed
    if (correctAnswerIndex === indexToRemove) {
      setCorrectAnswerIndex(0);
    } else if (correctAnswerIndex > indexToRemove) {
      setCorrectAnswerIndex(correctAnswerIndex - 1);
    }
  };
  
  const [lectures, setLectures] = useState<any[]>([]);
  const [submitting, setSubmitting] = useState<boolean>(false);

  useEffect(() => {
    if (isOpen) {
      if (initialData) {
        setScope(initialData.scope);
        setSubjectId(initialData.subjectId || '');
        setLectureId(initialData.lectureId || '');
        setTags(new Set(initialData.tags || []));
        setYear(initialData.year || '');
        setType(initialData.type);
        setStemFormat(initialData.stemFormat || 'standard');
        setStem(initialData.stem);
        setDifficulty(initialData.difficulty || 'medium');
        
        let newChoices = [...initialData.choices];
        while (newChoices.length < 5) {
            newChoices.push({ label: String.fromCharCode(65 + newChoices.length), text: '' });
        }
        setChoices(newChoices);
        
        const correctIndex = initialData.choices.findIndex(c => c.text === initialData.correctAnswer);
        setCorrectAnswerIndex(correctIndex >= 0 ? correctIndex : 0);
        setExplanation(initialData.explanation || '');
      } else {
        // Reset form
        setScope('subject');
        setSubjectId('');
        setLectureId('');
        setTags(new Set());
        setYear('');
        setType('mcq');
        setStemFormat('standard');
        setStem('');
        setDifficulty('medium');
        setChoices([
          { label: 'A', text: '' },
          { label: 'B', text: '' },
          { label: 'C', text: '' },
          { label: 'D', text: '' },
          { label: 'E', text: '' }
        ]);
        setCorrectAnswerIndex(0);
        setExplanation('');
      }

      getDocs(query(collection(db, 'lectures')))
        .then(snap => {
          setLectures(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        })
        .catch(err => {
          console.error("Failed to fetch lectures", err);
        });
    }
  }, [isOpen, initialData]);

  const toggleTag = (tag: QuestionTag) => {
    const newTags = new Set(tags);
    if (newTags.has(tag)) newTags.delete(tag);
    else newTags.add(tag);
    setTags(newTags);
  };

  const handleChoiceChange = (index: number, text: string) => {
    const newChoices = [...choices];
    newChoices[index].text = text;
    setChoices(newChoices);
  };

  const handleSubmit = async () => {
    if (!stem.trim()) return alert("يجب إدخال نص السؤال");
    
    let finalChoices = type === 'mcq' ? choices.filter(c => c.text.trim() !== '') : [
        { label: 'A', text: 'True' },
        { label: 'B', text: 'False' }
    ];

    if (type === 'mcq' && finalChoices.length < 2) {
      return alert("يجب إدخال خيارين على الأقل");
    }

    const _tags = Array.from(tags);
    if (_tags.includes('سنين_سابقة') && !year) {
      return alert("يجب إدخال السنة للإجابات من السنين السابقة");
    }

    if (scope === 'lecture' && !lectureId) {
      return alert("يجب اختيار محاضرة");
    }

    // Every question belongs to a subject, and through it to a stage. Without
    // one there is nowhere to file it and nobody it is meant for.
    if (!subjectId) {
      return alert("يجب اختيار المادة");
    }

    setSubmitting(true);
    try {
      // If the admin picked a TRANSLATED lecture, store the question against the
      // original's id so it is visible from both halves of the pair. Reading
      // uses the same helper, so the two ends cannot drift apart.
      const selectedLecture = lectures.find(l => l.id === lectureId);
      const resolvedLectureId = selectedLecture ? bankLectureIdFor(selectedLecture) : lectureId;

      const meta = subjectMetaFrom(subjects, subjectId);

      const payload: any = {
        scope,
        subjectId,
        // Denormalized so the bank can be filtered and named without joining
        // `subjects` - and so a question keeps its subject's name after a
        // rename. stageId is what makes the collection stage-scopable at all.
        stageId: effectiveStageId || null,
        courseId: meta?.courseId || null,
        subjectName: meta?.subjectName || null,
        subjectNameAr: meta?.subjectNameAr || null,
        lectureId: scope === 'lecture' ? resolvedLectureId : null,
        tags: _tags,
        year: _tags.includes('سنين_سابقة') ? year : null,
        type,
        stemFormat,
        stem,
        choices: finalChoices,
        correctAnswer: finalChoices[type === 'mcq' ? correctAnswerIndex : correctAnswerIndex].text,
        explanation,
        difficulty,
        isActive: true
      };

      if (initialData) {
        await editBankQuestion(initialData.id, payload);
      } else {
        await addBankQuestion(payload);
      }
      onAdded();
      onClose();
    } catch (e: any) {
      alert("خطأ: " + e.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" dir="rtl">
      <div className="bg-white dark:bg-zinc-900 w-full max-w-2xl rounded-2xl shadow-xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between p-4 border-b border-gray-100 dark:border-zinc-800 bg-sky-50 dark:bg-sky-900/10">
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">
            {initialData ? 'تعديل السؤال' : 'إضافة سؤال جديد'}
          </h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-full transition-colors text-gray-500">
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          
          {/* Scope */}
          <div>
            <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">النطاق (الظهور)</label>
            <div className="flex gap-2">
              <select 
                value={scope} 
                onChange={e => setScope(e.target.value as QuestionScope)}
                className="flex-1 p-3 rounded-xl border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-800"
              >
                <option value="subject">📚 مادة كاملة</option>
                <option value="lecture">📖 محاضرة محددة</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">المادة</label>
              <select 
                value={subjectId} 
                onChange={e => setSubjectId(e.target.value)}
                className="w-full p-3 rounded-xl border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-800"
              >
                <option value="" disabled>-- اختر المادة --</option>
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
                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">المحاضرة</label>
                <select 
                  value={lectureId} 
                  onChange={e => setLectureId(e.target.value)}
                  className="w-full p-3 rounded-xl border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-800"
                >
                  <option value="">-- اختر محاضرة --</option>
                  {lectures.filter(l => subjectSlugOf(l) === subjectId).map(l => (
                    <option key={l.id} value={l.id}>{l.title}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Tags */}
          <div>
            <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">التصنيف (اختياري)</label>
            <div className="flex flex-wrap gap-2">
              {ALL_TAGS.map(tag => (
                <button
                  key={tag}
                  onClick={() => toggleTag(tag)}
                  className={`px-3 py-1.5 rounded-full text-sm font-bold transition-colors border-2 ${
                    tags.has(tag) 
                    ? 'border-sky-500 bg-sky-50 text-sky-700 dark:bg-sky-900/30' 
                    : 'border-transparent bg-slate-100 text-slate-600 dark:bg-zinc-800'
                  }`}
                >
                  {tag.replace('_', ' ')}
                </button>
              ))}
              {Array.from(tags).filter((t: string) => !ALL_TAGS.includes(t)).map((tag: string) => (
                <button
                  key={tag}
                  onClick={() => toggleTag(tag)}
                  className="px-3 py-1.5 rounded-full text-sm font-bold transition-colors border-2 border-sky-500 bg-sky-50 text-sky-700 dark:bg-sky-900/30"
                >
                  {tag}
                </button>
              ))}
            </div>
            <div className="flex gap-2 mt-3">
              <input 
                type="text" 
                placeholder="إضافة تصنيف مخصص (مثال: الدور 1 2024)"
                value={customTag}
                onChange={e => setCustomTag(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (customTag.trim()) {
                      toggleTag(customTag.trim());
                      setCustomTag('');
                    }
                  }
                }}
                className="flex-1 p-3 rounded-xl border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-800"
              />
              <button
                onClick={(e) => {
                    e.preventDefault();
                    if (customTag.trim()) {
                      toggleTag(customTag.trim());
                      setCustomTag('');
                    }
                }}
                className="px-6 py-3 bg-sky-600 dark:bg-sky-500 text-white rounded-xl font-bold"
              >
                إضافة
              </button>
            </div>
            {tags.has('سنين_سابقة') && (
              <input 
                type="text" 
                placeholder="أدخل السنة (مثال: 2022)"
                value={year}
                onChange={e => setYear(e.target.value)}
                className="mt-3 w-full p-3 rounded-xl border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-800"
              />
            )}
          </div>

          {/* Type & Diff */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">النوع</label>
              <select 
                value={type} 
                onChange={e => setType(e.target.value as QuestionType)}
                className="w-full p-3 rounded-xl border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-800"
              >
                <option value="mcq">اختيار من متعدد (MCQ)</option>
                <option value="true_false">صح / خطأ</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">الصعوبة</label>
              <select 
                value={difficulty} 
                onChange={e => setDifficulty(e.target.value as Difficulty)}
                className="w-full p-3 rounded-xl border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-800"
              >
                <option value="easy">🟩 سهل</option>
                <option value="medium">🟨 متوسط</option>
                <option value="hard">🟥 صعب</option>
              </select>
            </div>
          </div>

          {/* Stem */}
          <div>
            <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">السؤال</label>
            <textarea 
              value={stem} 
              onChange={e => setStem(e.target.value)}
              placeholder="نص السؤال (يفضل باللغة الإنجليزية)"
              dir="ltr"
              className="w-full p-3 rounded-xl border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-800 min-h-[100px]"
            />
          </div>

          {/* Choices */}
          {type === 'mcq' && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300">الخيارات & الإجابة الصحيحة</label>
                <button 
                  onClick={addChoice} 
                  type="button" 
                  className="text-sm font-bold text-sky-600 hover:text-sky-700 dark:text-sky-400 dark:hover:text-sky-300 flex items-center gap-1"
                >
                  <span className="text-xl">+</span> إضافة خيار
                </button>
              </div>
              <div className="space-y-3">
                {choices.map((c, idx) => (
                  <div key={idx} className="flex gap-2 items-center relative group">
                    <input 
                      type="radio" 
                      name="correctChoice" 
                      checked={correctAnswerIndex === idx}
                      onChange={() => setCorrectAnswerIndex(idx)}
                      className="w-5 h-5 flex-shrink-0"
                    />
                    <span className="font-bold w-6 flex-shrink-0 text-center">{c.label}</span>
                    <input 
                      type="text" 
                      value={c.text} 
                      onChange={e => handleChoiceChange(idx, e.target.value)}
                      placeholder={`خيار ${c.label}`}
                      dir="ltr"
                      className="flex-1 p-2 rounded-lg border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-800"
                    />
                    {choices.length > 2 && (
                      <button 
                        type="button" 
                        onClick={() => removeChoice(idx)} 
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg flex-shrink-0"
                        title="حذف الخيار"
                      >
                        <X className="w-5 h-5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {type === 'true_false' && (
             <div>
              <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">الإجابة الصحيحة</label>
              <div className="flex gap-4">
                 <button onClick={() => setCorrectAnswerIndex(0)} className={`flex-1 p-3 rounded-xl border-2 font-bold ${correctAnswerIndex === 0 ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-transparent bg-slate-100 text-slate-600'}`}>True</button>
                 <button onClick={() => setCorrectAnswerIndex(1)} className={`flex-1 p-3 rounded-xl border-2 font-bold ${correctAnswerIndex === 1 ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-transparent bg-slate-100 text-slate-600'}`}>False</button>
              </div>
             </div>
          )}

          {/* Explanation */}
          <div>
            <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">التوضيح / الشرح (عربي)</label>
            <textarea 
              value={explanation} 
              onChange={e => setExplanation(e.target.value)}
              placeholder="شرح الإجابة لمساعدة الطالب"
              className="w-full p-3 rounded-xl border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-800 min-h-[80px]"
            />
          </div>

        </div>

        <div className="p-4 border-t border-gray-100 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900">
           <button 
             onClick={handleSubmit}
             disabled={submitting}
             className="w-full flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white p-4 rounded-xl font-bold transition-colors disabled:opacity-50"
           >
             {submitting ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save className="w-5 h-5" />}
             حفظ السؤال
           </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
