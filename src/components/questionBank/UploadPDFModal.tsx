import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { db } from '../../lib/firebase';
import { collection, query, getDocs } from 'firebase/firestore';
import { addBankQuestion } from '../../services/questionBankService';
import { extractMCQsFromStoragePath } from '../../services/mcqGenerationService';
import { storage } from '../../lib/firebase';
import { ref as storageRef, uploadBytes, deleteObject } from 'firebase/storage';
import { X, Upload, Loader2, Edit3, Save, CheckCircle, FileText, ChevronDown, ChevronUp } from 'lucide-react';
import { QuestionScope, QuestionTag, QuestionType, Difficulty } from '../../types/questionBank.types';
import { motion, AnimatePresence } from 'motion/react';
import { CATEGORIES, TRANSLATIONS } from '../../types';

const ALL_TAGS: QuestionTag[] = ['وزاري', 'سنين_سابقة', 'سؤال_الدكتور', 'مهم', 'متوقع'];

const PDF_EXTRACTION_PROMPT = `
You are an expert educational assistant designed to extract questions from documents.
Extract ALL multiple-choice questions (MCQs) and normal questions from the provided document.
The document may be in Arabic or English. Please preserve the original language and text.

CRITICAL RULES:
1. Extract the question text (stem).
2. Extract the choices/options for the question. If no choices exist, infer reasonable choices or simply label them A, B, C, D of blank.
3. If an answer is indicated, mark it as "correctAnswer". Otherwise, just pick the first option as fallback.
4. "choices" MUST be an array of objects with "label" (A,B,C,D) and "text" (the actual choice text string).
5. If the document indicates an exam session or year (e.g., الدور الأول 2024, or الدور 1 2024), extract it into a "session" field. Otherwise leave it empty.
6. Output MUST be ONLY a JSON object with a "questions" array.

Return strictly in this format:
{
  "questions": [
    {
      "stem": "Question text...",
      "choices": [
        {"label": "A", "text": "Choice A text"},
        {"label": "B", "text": "Choice B text"}
      ],
      "correctAnswer": "Exact text of the correct choice",
      "explanation": "Optional explanation or empty string",
      "session": "Optional session string like الدور 1 2024 or empty string"
    }
  ]
}
`;



interface UploadPDFModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdded: () => void;
}

type Stage = 'upload' | 'processing' | 'review' | 'saving' | 'done';

export default function UploadPDFModal({ isOpen, onClose, onAdded }: UploadPDFModalProps) {
  const [stage, setStage] = useState<Stage>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  // Categorization
  const [scope, setScope] = useState<QuestionScope>('global');
  const [subjectId, setSubjectId] = useState<string>(CATEGORIES[0].value);
  const [lectureId, setLectureId] = useState<string>('');
  const [tags, setTags] = useState<Set<QuestionTag>>(new Set());
  const [customTag, setCustomTag] = useState<string>('');
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [lectures, setLectures] = useState<any[]>([]);
  
  // Review Data
  const [extractedQuestions, setExtractedQuestions] = useState<any[]>([]);
  const [expandedQuestionIndex, setExpandedQuestionIndex] = useState<number | null>(0);
  const [completedSaves, setCompletedSaves] = useState(0);

  useEffect(() => {
    if (isOpen) {
      setStage('upload');
      setFile(null);
      setError(null);
      setExtractedQuestions([]);
      setCompletedSaves(0);
      setScope('global');
      setSubjectId(CATEGORIES[0].value);
      setLectureId('');
      setTags(new Set());
      getDocs(query(collection(db, 'lectures')))
        .then(snap => {
          setLectures(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        })
        .catch(err => {
          console.error("Failed to fetch lectures", err);
        });
    }
  }, [isOpen]);

  const toggleTag = (tag: QuestionTag) => {
    const newTags = new Set(tags);
    if (newTags.has(tag)) newTags.delete(tag);
    else newTags.add(tag);
    setTags(newTags);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const selectedFile = e.target.files[0];
      if (selectedFile.type !== 'application/pdf') {
        setError('يجب أن يكون الملف بصيغة PDF فقط.');
        return;
      }
      if (selectedFile.size > 20 * 1024 * 1024) {
        setError('حجم الملف كبير جداً. الحد الأقصى 20MB');
        return;
      }
      setFile(selectedFile);
      setError(null);
    }
  };

  const handleExtract = async () => {
    if (!file) {
      setError('يرجى اختيار ملف PDF');
      return;
    }
    if (scope === 'lecture' && !lectureId) {
      setError('يجب اختيار محاضرة');
      return;
    }
    
    setStage('processing');
    setError(null);

    // Uploaded to Storage, then extracted server-side from the PATH.
    //
    // The old flow base64'd the file in the browser and called Gemini directly,
    // which only worked because the API key was in the bundle. Posting those
    // bytes to our own endpoint instead is not an option: Vercel caps request
    // bodies near 4.5MB and these are scans that regularly exceed it. A path
    // also means the server resolves the file against its own bucket and can
    // never be pointed at another host.
    let uploadedPath: string | null = null;
    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      uploadedPath = `bank-imports/${Date.now()}_${safeName}`;
      await uploadBytes(storageRef(storage, uploadedPath), file);

      const parsedQuestions = await extractMCQsFromStoragePath(uploadedPath);

      if (parsedQuestions.length === 0) {
        throw new Error('لم يتم العثور على أسئلة في الملف. حاول التأكد من محتوى الملف أو صيغته.');
      }

      setExtractedQuestions(parsedQuestions);
      setStage('review');
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'فشل استخراج الأسئلة من الملف');
      setStage('upload');
    } finally {
      // The upload is a courier, not a record. Questions are stored in
      // Firestore, so leaving scans in the bucket would accumulate the
      // college's exam papers for no one to read.
      if (uploadedPath) {
        deleteObject(storageRef(storage, uploadedPath)).catch(() => { /* orphan, not a failure */ });
      }
    }
  };

  const handleUpdateQuestion = (index: number, field: string, value: any) => {
    const updated = [...extractedQuestions];
    updated[index] = { ...updated[index], [field]: value };
    setExtractedQuestions(updated);
  };
  
  const handleUpdateChoice = (qIndex: number, cIndex: number, newText: string) => {
    const updated = [...extractedQuestions];
    updated[qIndex].choices[cIndex].text = newText;
    setExtractedQuestions(updated);
  };

  const handleSaveToBank = async () => {
    setStage('saving');
    setError(null);
    setCompletedSaves(0);

    const _tags = Array.from(tags) as QuestionTag[];
    try {
      for (const q of extractedQuestions) {
        // filter out empty choices
        const validChoices = q.choices.filter((c: any) => typeof c.text === 'string' && c.text.trim() !== '');
        
        const questionTags = [..._tags];
        if (q.session && q.session.trim()) {
          questionTags.push(q.session.trim());
        }

        await addBankQuestion({
          scope,
          subjectId: scope === 'global' ? null : subjectId,
          lectureId: scope === 'lecture' ? lectureId : null,
          tags: questionTags,
          year: null, // AI pdf extraction doesn't imply a specific year unless requested
          type: 'mcq',
          stemFormat: 'standard',
          stem: q.stem || 'بدون نص',
          choices: validChoices,
          correctAnswer: q.correctAnswer || (validChoices.length > 0 ? validChoices[0].text : 'A'),
          explanation: q.explanation || '',
          difficulty: difficulty,
          isActive: true
        });
        setCompletedSaves(prev => prev + 1);
      }
      setStage('done');
      setTimeout(() => {
        onAdded();
        onClose();
      }, 2000);
    } catch (err: any) {
      console.error(err);
      setError('حدث خطأ أثناء الحفظ. تم حفظ ' + completedSaves + ' سؤال.');
      setStage('review');
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" dir="rtl">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="bg-white dark:bg-zinc-900 w-full max-w-4xl rounded-2xl shadow-xl overflow-hidden flex flex-col max-h-[90vh]"
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-100 dark:border-zinc-800 bg-sky-50 dark:bg-sky-900/10">
          <h2 className="text-xl font-bold flex items-center gap-2 text-sky-800 dark:text-sky-300">
            {stage === 'upload' && <Upload className="w-5 h-5" />}
            {stage === 'processing' && <Loader2 className="w-5 h-5 animate-spin" />}
            {stage === 'review' && <Edit3 className="w-5 h-5" />}
            {stage === 'saving' && <Save className="w-5 h-5" />}
            {stage === 'done' && <CheckCircle className="w-5 h-5 text-emerald-500" />}
            استخراج الأسئلة من PDF
          </h2>
          <button onClick={onClose} disabled={['processing', 'saving'].includes(stage)} className="p-2 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-full transition-colors text-gray-500 disabled:opacity-50">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          <AnimatePresence mode="wait">
            {stage === 'upload' && (
              <motion.div
                key="upload"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="space-y-6"
              >
                {/* Categorization Form */}
                <div className="bg-gray-50 dark:bg-zinc-800/50 p-4 rounded-xl space-y-4 border border-gray-100 dark:border-zinc-800">
                  <h3 className="font-bold text-gray-700 dark:text-gray-300 text-sm">إعدادات التصنيف للأسئلة المستخرجة</h3>
                  
                  <div>
                    <label className="block text-xs font-bold text-slate-500 mb-1">النطاق (الظهور)</label>
                    <select 
                      value={scope} 
                      onChange={e => setScope(e.target.value as QuestionScope)}
                      className="w-full p-2.5 rounded-lg border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm"
                    >
                      <option value="global">🌐 عام (يظهر للكل)</option>
                      <option value="subject">📚 مادة كاملة</option>
                      <option value="lecture">📖 محاضرة محددة</option>
                    </select>
                  </div>

                  {scope !== 'global' && (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-bold text-slate-500 mb-1">المادة</label>
                        <select 
                          value={subjectId} 
                          onChange={e => setSubjectId(e.target.value)}
                          className="w-full p-2.5 rounded-lg border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm"
                        >
                          {CATEGORIES.map(c => <option key={c.value} value={c.value}>{TRANSLATIONS['ar'][c.labelKey]}</option>)}
                        </select>
                      </div>
                      {scope === 'lecture' && (
                        <div>
                          <label className="block text-xs font-bold text-slate-500 mb-1">المحاضرة</label>
                          <select 
                            value={lectureId} 
                            onChange={e => setLectureId(e.target.value)}
                            className="w-full p-2.5 rounded-lg border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm"
                          >
                            <option value="">-- اختر محاضرة --</option>
                            {lectures.filter(l => l.category === subjectId).map(l => (
                              <option key={l.id} value={l.id}>{l.title}</option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
                  )}

                  <div>
                    <label className="block text-xs font-bold text-slate-500 mb-1">التصنيف (اختياري)</label>
                    <div className="flex flex-wrap gap-2">
                      {ALL_TAGS.map(tag => (
                        <button
                          key={tag}
                          onClick={() => toggleTag(tag)}
                          className={`px-3 py-1 rounded-full text-xs font-bold transition-colors border ${
                            tags.has(tag) 
                            ? 'border-sky-500 bg-sky-50 text-sky-700 dark:bg-sky-900/30' 
                            : 'border-transparent bg-white text-slate-600 dark:bg-zinc-700'
                          }`}
                        >
                          {tag.replace('_', ' ')}
                        </button>
                      ))}
                      {Array.from(tags).filter((t: string) => !ALL_TAGS.includes(t)).map((tag: string) => (
                        <button
                          key={tag}
                          onClick={() => toggleTag(tag)}
                          className="px-3 py-1 rounded-full text-xs font-bold transition-colors border border-sky-500 bg-sky-50 text-sky-700 dark:bg-sky-900/30"
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                    <div className="flex gap-2 mt-2">
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
                         className="flex-1 p-2 rounded-lg border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm"
                       />
                       <button
                         onClick={(e) => {
                             e.preventDefault();
                             if (customTag.trim()) {
                               toggleTag(customTag.trim());
                               setCustomTag('');
                             }
                         }}
                         className="px-4 py-2 bg-sky-600 dark:bg-sky-500 text-white rounded-lg text-sm font-bold"
                       >
                         إضافة
                       </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-500 mb-1">الصعوبة الافتراضية</label>
                    <select 
                      value={difficulty} 
                      onChange={e => setDifficulty(e.target.value as Difficulty)}
                      className="w-full p-2.5 rounded-lg border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm"
                    >
                      <option value="easy">🟩 سهل</option>
                      <option value="medium">🟨 متوسط</option>
                      <option value="hard">🟥 صعب</option>
                    </select>
                  </div>
                </div>

                {!file ? (
                  <label className="flex flex-col items-center justify-center w-full h-40 border-2 border-dashed border-sky-300 dark:border-sky-800/50 rounded-2xl cursor-pointer hover:bg-sky-50 dark:hover:bg-sky-900/10 transition-colors">
                    <div className="flex flex-col items-center justify-center pt-5 pb-6">
                      <Upload className="w-10 h-10 text-sky-500 mb-3" />
                      <p className="mb-2 text-sm text-gray-500 dark:text-gray-400 font-semibold">اسحب وافلت ملف هنا أو اضغط لاختياره</p>
                      <p className="text-xs text-gray-400 dark:text-gray-500">PDF فقط (الحد الأقصى 20 ميجابايت)</p>
                    </div>
                    <input type="file" className="hidden" accept=".pdf" onChange={handleFileChange} />
                  </label>
                ) : (
                  <div className="flex items-center justify-between p-4 bg-sky-50 dark:bg-sky-900/20 border border-sky-200 dark:border-sky-800 rounded-xl">
                    <div className="flex items-center gap-3">
                      <FileText className="w-10 h-10 text-sky-600 dark:text-sky-400" />
                      <div>
                        <p className="font-bold text-slate-800 dark:text-slate-200">{file.name}</p>
                        <p className="text-xs text-slate-500">{(file.size / (1024 * 1024)).toFixed(2)} MB</p>
                      </div>
                    </div>
                    <button onClick={() => setFile(null)} className="p-2 text-slate-400 hover:text-red-500 transition-colors bg-white dark:bg-zinc-800 rounded-full shadow-sm">
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                )}

                {error && (
                  <div className="p-3 bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400 rounded-xl text-sm border border-red-100 dark:border-red-900/50">
                    {error}
                  </div>
                )}
              </motion.div>
            )}

            {stage === 'processing' && (
              <motion.div
                key="processing"
                initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
                className="flex flex-col items-center justify-center py-20 text-center"
              >
                <div className="relative w-20 h-20 mb-6">
                  <div className="absolute inset-0 border-4 border-sky-100 dark:border-zinc-800 rounded-full"></div>
                  <div className="absolute inset-0 border-4 border-sky-500 rounded-full border-t-transparent animate-spin"></div>
                  <FileText className="absolute inset-0 m-auto w-8 h-8 text-sky-500 animate-pulse" />
                </div>
                <h3 className="text-xl font-bold text-slate-800 dark:text-white mb-2">جاري المعالجة...</h3>
                <p className="text-slate-500 dark:text-slate-400 max-w-sm">يقوم الذكاء الاصطناعي الآن بقراءة الملف واستخراج الأسئلة وتنسيقها. قد يستغرق هذا بضع ثوانٍ.</p>
              </motion.div>
            )}

            {stage === 'review' && (
              <motion.div
                key="review"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                className="space-y-4"
              >
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-bold text-slate-700 dark:text-slate-300">تم استخراج <span className="text-sky-600 dark:text-sky-400">{extractedQuestions.length}</span> سؤال</p>
                  <p className="text-xs text-slate-500">الرجاء المراجعة قبل الحفظ</p>
                </div>
                
                {error && (
                  <div className="p-3 bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400 rounded-xl text-sm border border-red-100 dark:border-red-900/50 mb-4">
                    {error}
                  </div>
                )}

                <div className="space-y-3">
                  {extractedQuestions.map((q, qIndex) => {
                    const isExpanded = expandedQuestionIndex === qIndex;
                    return (
                      <div key={qIndex} className="bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-xl overflow-hidden transition-all">
                        <div 
                          className="flex items-start justify-between p-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-zinc-700/50"
                          onClick={() => setExpandedQuestionIndex(isExpanded ? null : qIndex)}
                        >
                          <div className="flex gap-3 items-start flex-1">
                            <span className="flex-shrink-0 w-8 h-8 flex items-center justify-center bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300 rounded-lg font-bold text-sm">
                              {qIndex + 1}
                            </span>
                            <div className="flex-1">
                              <p className="text-sm font-medium text-slate-800 dark:text-slate-200" dir="ltr">{q.stem}</p>
                              {!isExpanded && (
                                <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-1" dir="ltr">
                                  <span className="font-bold">Correct:</span> {q.correctAnswer}
                                </p>
                              )}
                            </div>
                          </div>
                          {isExpanded ? <ChevronUp className="w-5 h-5 text-gray-400" /> : <ChevronDown className="w-5 h-5 text-gray-400" />}
                        </div>

                        <AnimatePresence>
                          {isExpanded && (
                            <motion.div 
                              initial={{ height: 0 }} 
                              animate={{ height: 'auto' }} 
                              exit={{ height: 0 }}
                              className="overflow-hidden"
                            >
                              <div className="p-4 pt-0 border-t border-gray-100 dark:border-zinc-700 space-y-4">
                                <div>
                                  <label className="block text-xs font-bold text-slate-500 mb-2">تعديل السؤال</label>
                                  <textarea 
                                    value={q.stem} 
                                    onChange={(e) => handleUpdateQuestion(qIndex, 'stem', e.target.value)}
                                    className="w-full p-2.5 rounded-lg border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-900 text-sm min-h-[60px]"
                                    dir="ltr"
                                  />
                                </div>
                                
                                <div>
                                  <label className="block text-xs font-bold text-slate-500 mb-2">الخيارات (اختر الإجابة الصحيحة)</label>
                                  <div className="space-y-2 text-sm" dir="ltr">
                                    {q.choices.map((choice: any, cIndex: number) => (
                                      <div key={cIndex} className="flex gap-2 items-center">
                                        <input 
                                          type="radio" 
                                          name={`correctChoice-${qIndex}`} 
                                          checked={q.correctAnswer === choice.text}
                                          onChange={() => handleUpdateQuestion(qIndex, 'correctAnswer', choice.text)}
                                          className="w-4 h-4 text-emerald-600 focus:ring-emerald-500"
                                        />
                                        <span className="font-bold w-5">{choice.label}</span>
                                        <input 
                                          type="text"
                                          value={choice.text}
                                          onChange={(e) => handleUpdateChoice(qIndex, cIndex, e.target.value)}
                                          className="flex-1 p-2 rounded-md border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-900"
                                        />
                                      </div>
                                    ))}
                                  </div>
                                </div>

                                <div>
                                  <label className="block text-xs font-bold text-slate-500 mb-2">التوضيح (اختياري)</label>
                                  <textarea 
                                    value={q.explanation || ''} 
                                    onChange={(e) => handleUpdateQuestion(qIndex, 'explanation', e.target.value)}
                                    className="w-full p-2.5 rounded-lg border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-900 text-sm min-h-[50px]"
                                  />
                                </div>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            )}

            {stage === 'saving' && (
              <motion.div
                key="saving"
                initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
                className="flex flex-col items-center justify-center py-20 text-center"
              >
                <div className="relative w-20 h-20 mb-6 flex items-center justify-center">
                  <div className="absolute inset-0 border-4 border-sky-100 dark:border-zinc-800 rounded-full"></div>
                  <div className="absolute inset-0 border-4 border-sky-500 rounded-full border-t-transparent animate-spin"></div>
                  <span className="font-bold text-sky-600 dark:text-sky-400">{Math.round((completedSaves / extractedQuestions.length) * 100)}%</span>
                </div>
                <h3 className="text-xl font-bold text-slate-800 dark:text-white mb-2">جاري الحفظ في البنك...</h3>
                <p className="text-slate-500 dark:text-slate-400 max-w-sm">
                  تم حفظ {completedSaves} من {extractedQuestions.length}
                </p>
              </motion.div>
            )}

            {stage === 'done' && (
              <motion.div
                 key="done"
                 initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
                 className="flex flex-col items-center justify-center py-20 text-center"
              >
                <div className="w-20 h-20 bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400 rounded-full flex items-center justify-center mb-6">
                  <CheckCircle className="w-10 h-10" />
                </div>
                <h3 className="text-2xl font-bold text-slate-800 dark:text-white mb-2">تم الحفظ بنجاح!</h3>
                <p className="text-slate-500 dark:text-slate-400">تمت إضافة {extractedQuestions.length} سؤال إلى بنك الأسئلة.</p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="p-4 border-t border-gray-100 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900 flex justify-end gap-3">
          {stage === 'upload' && (
            <>
              <button 
                onClick={onClose}
                className="px-5 py-2.5 font-bold text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-zinc-800 rounded-xl transition-colors"
              >
                إلغاء
              </button>
              <button
                onClick={handleExtract}
                disabled={!file}
                className="px-6 py-2.5 bg-sky-600 hover:bg-sky-700 text-white font-bold rounded-xl flex items-center gap-2 disabled:opacity-50 transition-colors"
              >
                استخراج الأسئلة
              </button>
            </>
          )}

          {stage === 'review' && (
            <>
              <button 
                onClick={() => setStage('upload')}
                className="px-5 py-2.5 font-bold text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-zinc-800 rounded-xl transition-colors mr-auto"
              >
                عودة
              </button>
              <button 
                onClick={onClose}
                className="px-5 py-2.5 font-bold text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-zinc-800 rounded-xl transition-colors"
              >
                إلغاء
              </button>
              <button
                onClick={handleSaveToBank}
                className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl flex items-center gap-2 transition-colors"
              >
                <Save className="w-5 h-5" />
                حفظ {extractedQuestions.length} سؤال في البنك
              </button>
            </>
          )}
        </div>
      </motion.div>
    </div>,
    document.body
  );
}
