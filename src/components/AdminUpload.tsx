import React, { useState, useRef, useEffect } from 'react';
import { X, Upload, AlertCircle, Loader2, FileUp, CheckCircle2 } from 'lucide-react';
import { db, auth, storage, handleFirestoreError, OperationType } from '../lib/firebase';
import { collection, addDoc, doc, updateDoc, serverTimestamp, getDocs, query, where } from 'firebase/firestore';
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { CATEGORIES, Category, LectureType, Language, TRANSLATIONS, Lecture, UserProfile } from '../types';
import { motion, AnimatePresence } from 'motion/react';
import { logAdminAction } from '../services/adminLogService';
import { generateMCQsForLecture } from '../services/mcqGenerationService';
import { useStageContext } from '../contexts/StageContext';
import { useStageSubjects } from '../hooks/useStageSubjects';
import { COURSE_IDS, COURSE_LABELS, CourseId } from '../types';

interface AdminUploadProps {
  isOpen: boolean;
  onClose: () => void;
  lang: Language;
  lectureToEdit?: Lecture | null;
  user?: UserProfile | null;
}

export default function AdminUpload({ isOpen, onClose, lang, lectureToEdit, user }: AdminUploadProps) {
  const t = TRANSLATIONS[lang];
  const isRtl = lang === 'ar';
  const { effectiveStageId, activeCourseId } = useStageContext();
  const { subjects } = useStageSubjects();

  // Curriculum picker replaces the legacy CATEGORIES dropdown wherever a stage
  // actually has subjects; stages not yet set up keep the old behaviour.
  const hasCurriculum = subjects.length > 0;
  const [courseFilter, setCourseFilter] = useState<CourseId>(activeCourseId);
  const [subjectId, setSubjectId] = useState<string>('');
  const courseSubjects = subjects.filter(sub => sub.courseId === courseFilter);

  // subjectName is denormalised so LectureCard can label the badge without
  // loading the subjects collection.
  const subjectMeta = (id?: string) => {
    const sub = subjects.find(x => x.id === id);
    if (!sub) return {};
    return { subjectId: sub.id, courseId: sub.courseId, subjectName: sub.nameEn };
  };

  const [title, setTitle] = useState('');
  const [lectureNumber, setLectureNumber] = useState('');
  const [category, setCategory] = useState<Category>('pharmacology');
  const [type, setType] = useState<LectureType>('theoretical');
  const [description, setDescription] = useState('');
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [version, setVersion] = useState<'original' | 'translated'>('original');
  // The original this translation came from, so the pair shares one question
  // bank. Only meaningful when version === 'translated'; '' means unlinked,
  // which is allowed - the lecture just keeps its own separate bank.
  const [translationOf, setTranslationOf] = useState<string>('');
  const [originalCandidates, setOriginalCandidates] = useState<any[]>([]);
  const [isWeekly, setIsWeekly] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [fileConfigs, setFileConfigs] = useState<any[]>([]);
  const [currentFileIndex, setCurrentFileIndex] = useState(0);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  // How many uploads are still generating MCQs in this tab. Drives the "don't
  // close the tab" banner, since generation is browser-side and dies with it.
  const [pendingMCQCount, setPendingMCQCount] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * Kick off MCQ generation for a lecture that was just created.
   *
   * Deliberately NOT awaited into the submit path: generation takes 10-30s, and
   * the upload has already succeeded by this point - blocking on it would make a
   * successful upload look like a hang. Previously the first student to open the
   * lecture paid that wait instead (MCQOverlay), so this only moves the cost off
   * a student and onto the machine that is already sitting there.
   *
   * Failure is not fatal and is deliberately not surfaced as an upload error:
   * the 90s staleness fall-through in mcqGenerationService regenerates on the
   * next student open, so this self-heals if the admin closes the tab.
   */
  const kickOffMCQGeneration = (lectureId: string, data: any) => {
    // Translated lectures never get AI MCQs - they are raw source material.
    if (data.version === 'translated') return;
    if (!data.pdfUrl) return;

    // Only the id travels. The server reads subjectId and pdfUrl from the
    // lecture document itself, which is both why the old undefined-subjectId
    // crash cannot recur and why no caller can point it at another URL.
    setPendingMCQCount(n => n + 1);
    generateMCQsForLecture(lectureId)
      .catch(err => {
        console.warn('[AdminUpload] MCQ generation failed for', lectureId, err);
      })
      .finally(() => setPendingMCQCount(n => Math.max(0, n - 1)));
  };

  useEffect(() => {
    if (lectureToEdit) {
      setTitle(lectureToEdit.title);
      setLectureNumber(lectureToEdit.number ? String(lectureToEdit.number) : '');
      setCategory(lectureToEdit.category);
      setType(lectureToEdit.type);
      setDescription(lectureToEdit.description || '');
      setYoutubeUrl(lectureToEdit.youtubeUrl || '');
      setVersion(lectureToEdit.version || 'original');
      setTranslationOf(lectureToEdit.translationOf || '');
      setIsWeekly(lectureToEdit.isWeekly || false);
      setFiles([]); // Optional to upload a new file
      setFileConfigs([]);
      setCurrentFileIndex(0);
    } else {
      resetForm();
    }
  }, [lectureToEdit, isOpen]);

  // Candidate originals for the "translated from" picker. Scoped to the same
  // stage and subject, because that is the only place a matching original can
  // be - and it keeps the list short enough to be a usable dropdown.
  //
  // Deliberately NOT matched on lecture number: AdminUpload writes
  // `number: null` whenever the field is left blank, so a number-based auto-pair
  // silently fails on exactly the lectures that already exist.
  useEffect(() => {
    if (!isOpen || version !== 'translated') {
      setOriginalCandidates([]);
      return;
    }
    let active = true;
    getDocs(query(collection(db, 'lectures'), where('stageId', '==', effectiveStageId)))
      .then(snap => {
        if (!active) return;
        const rows = snap.docs
          .map(d => ({ id: d.id, ...(d.data() as any) }))
          .filter(l => l.version !== 'translated')
          .filter(l => (hasCurriculum ? l.subjectId === subjectId : true))
          .filter(l => l.id !== lectureToEdit?.id)
          .sort((a, b) => (a.number ?? 9999) - (b.number ?? 9999));
        setOriginalCandidates(rows);
      })
      .catch(err => console.error('Failed to load original lectures', err));
    return () => { active = false; };
  }, [isOpen, version, subjectId, effectiveStageId, hasCurriculum, lectureToEdit]);

  const loadConfig = (index: number, configs: any[]) => {
    if (!configs || !configs[index]) return;
    const c = configs[index];
    setTitle(c.title);
    setLectureNumber(c.lectureNumber);
    setCategory(c.category);
    setSubjectId(c.subjectId || '');
    setType(c.type);
    setDescription(c.description);
    setYoutubeUrl(c.youtubeUrl);
    setVersion(c.version);
    setTranslationOf(c.translationOf || '');
    setIsWeekly(c.isWeekly);
  };

  const saveCurrentConfig = (configs: any[]) => {
    if (configs.length === 0) return configs;
    const newConfigs = [...configs];
    newConfigs[currentFileIndex] = {
      title,
      lectureNumber,
      category,
      subjectId,
      type,
      description,
      youtubeUrl,
      version,
      translationOf,
      isWeekly
    };
    return newConfigs;
  };

  const processFiles = (selectedFiles: FileList | null) => {
    if (!selectedFiles) return;
    
    // Save current config before advancing
    let currentConfigs = saveCurrentConfig(fileConfigs);
    
    const validFiles: File[] = [];
    let hasError = false;
    
    for (let i = 0; i < selectedFiles.length; i++) {
      const selectedFile = selectedFiles[i];
      if (selectedFile.type !== 'application/pdf') {
        setError(isRtl ? 'يرجى اختيار ملفات PDF فقط' : 'Please select PDF files only');
        hasError = true;
        break;
      }
      if (selectedFile.size > 10 * 1024 * 1024) { // 10MB limit
        setError(t.maxSize);
        hasError = true;
        break;
      }
      validFiles.push(selectedFile);
    }
    
    if (!hasError && validFiles.length > 0) {
      const newConfigs = validFiles.map((f, i) => {
        const nameWithoutExt = f.name.replace(/\.[^/.]+$/, "");
        const cleanTitle = nameWithoutExt.replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim();
        return {
          title: cleanTitle,
          lectureNumber: '',
          category: category,
          type: type,
          description: '',
          youtubeUrl: '',
          version: 'original',
          isWeekly: false
        };
      });
      
      const updatedConfigs = [...currentConfigs, ...newConfigs];
      
      setFiles(prev => [...prev, ...validFiles]);
      setFileConfigs(updatedConfigs);
      setError(null);

      if (files.length === 0) {
         loadConfig(0, updatedConfigs);
      }
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    processFiles(e.target.files);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    processFiles(e.dataTransfer.files);
  };

  const resetForm = () => {
    setTitle('');
    setLectureNumber('');
    setDescription('');
    setYoutubeUrl('');
    setVersion('original');
    setTranslationOf('');
    setIsWeekly(false);
    setFiles([]);
    setFileConfigs([]);
    setCurrentFileIndex(0);
    setUploadProgress(null);
    setShowSuccess(false);
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!auth.currentUser) return;
    if (!lectureToEdit && files.length === 0 && !youtubeUrl) return;

    setIsSubmitting(true);
    setError(null);
    setUploadProgress(0);

    try {
      if (lectureToEdit || files.length === 0) {
        // Edit mode OR Youtube only creation mode
        let downloadUrl = lectureToEdit?.pdfUrl || '';
        const currentFile = files.length > 0 ? files[0] : null;

        if (currentFile) {
          const safeFileName = currentFile.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
          const storagePath = `lectures/${Date.now()}_${safeFileName}`;
          const storageRef = ref(storage, storagePath);
          const uploadTask = uploadBytesResumable(storageRef, currentFile);

          downloadUrl = await new Promise<string>((resolve, reject) => {
            uploadTask.on('state_changed', 
              (snapshot) => setUploadProgress((snapshot.bytesTransferred / snapshot.totalBytes) * 100), 
              reject, 
              async () => {
                try {
                  const url = await getDownloadURL(uploadTask.snapshot.ref);
                  resolve(url);
                } catch (e) {
                  reject(e);
                }
              }
            );
          });
        }

        const subjectFields = subjectMeta(subjectId);
        const lectureData: any = {
          title,
          ...(hasCurriculum ? subjectFields : { category }),
          type,
          description,
          youtubeUrl: youtubeUrl || null,
          pdfUrl: downloadUrl,
          uploadedBy: lectureToEdit?.uploadedBy || auth.currentUser.uid,
          uploaderName: lectureToEdit?.uploaderName || user?.name || auth.currentUser?.displayName || 'Admin',
          version,
          // Only meaningful on a translation. Written as null rather than
          // omitted on originals so re-saving a lecture that was previously
          // translated actually clears the stale link.
          translationOf: version === 'translated' && translationOf ? translationOf : null,
          isWeekly,
          // Without this the lecture fails every stage-filtered query and is
          // invisible to everyone, including the admin who uploaded it.
          stageId: lectureToEdit?.stageId || effectiveStageId,
        };
        
        if (lectureNumber) lectureData.number = parseInt(lectureNumber, 10);
        else lectureData.number = null; 

        if (lectureToEdit) {
          await updateDoc(doc(db, 'lectures', lectureToEdit.id), lectureData);
          await logAdminAction('UPDATE_LECTURE', `Updated lecture: ${lectureData.title}`, lectureToEdit.id);
        } else {
          lectureData.createdAt = serverTimestamp();
          const docRef = await addDoc(collection(db, 'lectures'), lectureData);
          await logAdminAction('CREATE_LECTURE', `Created lecture: ${lectureData.title}`, docRef.id);
          kickOffMCQGeneration(docRef.id, lectureData);
        }
      } else {
        // Multiple files creation mode
        const finalConfigs = saveCurrentConfig(fileConfigs);
        
        for (let i = 0; i < files.length; i++) {
          const currentFile = files[i];
          const config = finalConfigs[i];
          
          const safeFileName = currentFile.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
          const storagePath = `lectures/${Date.now()}_${safeFileName}`;
          const storageRef = ref(storage, storagePath);
          const uploadTask = uploadBytesResumable(storageRef, currentFile);

          const downloadUrl = await new Promise<string>((resolve, reject) => {
            uploadTask.on('state_changed', 
              (snapshot) => {
                const fileProgress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
                const totalProgress = ((i + (fileProgress / 100)) / files.length) * 100;
                setUploadProgress(totalProgress);
              }, 
              reject, 
              async () => resolve(await getDownloadURL(uploadTask.snapshot.ref))
            );
          });

          const lectureData: any = {
            title: config.title,
            ...(hasCurriculum ? subjectMeta(config.subjectId) : { category: config.category }),
            type: config.type,
            description: config.description,
            youtubeUrl: config.youtubeUrl || null,
            pdfUrl: downloadUrl,
            uploadedBy: auth.currentUser?.uid,
            uploaderName: user?.name || auth.currentUser?.displayName || 'Admin',
            version: config.version,
            translationOf: config.version === 'translated' && config.translationOf ? config.translationOf : null,
            isWeekly: config.isWeekly,
            createdAt: serverTimestamp(),
            stageId: effectiveStageId,
          };
          
          if (config.lectureNumber) {
            lectureData.number = parseInt(config.lectureNumber, 10);
          } else {
            lectureData.number = null;
          }

          const docRef = await addDoc(collection(db, 'lectures'), lectureData);
          await logAdminAction('CREATE_LECTURE_BATCH', `Batch created lecture: ${lectureData.title}`, docRef.id);
          kickOffMCQGeneration(docRef.id, lectureData);
        }
      }

      setShowSuccess(true);
    } catch (err: any) {
      console.error('Submit error details:', err);
      
      let errorMessage = t.errorUnknown;
      
      // Handle Firebase Storage and Firestore error codes
      if (err.code) {
        switch (err.code) {
          case 'storage/unauthorized':
          case 'permission-denied':
            errorMessage = t.errorUnauthorized;
            break;
          case 'storage/retry-limit-exceeded':
            errorMessage = t.errorNetwork;
            break;
          case 'storage/quota-exceeded':
            errorMessage = t.errorQuota;
            break;
          case 'storage/canceled':
            return; // Don't show error if user canceled
          default:
            errorMessage = err.message || t.errorUnknown;
        }
      } else if (err instanceof Error) {
        errorMessage = err.message;
      }

      setError(errorMessage);
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectedCategoryData = CATEGORIES.find(c => c.value === category);

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" dir={isRtl ? 'rtl' : 'ltr'}>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          />
          
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            className="relative w-full max-w-lg bg-white dark:bg-zinc-900 rounded-3xl shadow-2xl overflow-hidden border border-slate-200 dark:border-zinc-800 max-h-[90vh] flex flex-col"
          >
            <div className="px-6 py-4 border-b border-slate-100 dark:border-zinc-800 flex justify-between items-center bg-sky-50/50 dark:bg-sky-900/10 shrink-0">
              <h2 className="text-xl font-bold text-slate-900 dark:text-stone-100 flex items-center gap-2">
                <Upload className="w-5 h-5 text-sky-600 dark:text-sky-400" />
                {lectureToEdit ? t.editLecture : t.publishLecture}
              </h2>
              <button onClick={onClose} className="p-2 hover:bg-white dark:hover:bg-zinc-800 rounded-full transition-colors">
                <X className="w-5 h-5 text-slate-500 dark:text-slate-400" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto">
              {showSuccess ? (
                <motion.div 
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="py-12 flex flex-col items-center text-center space-y-6"
                >
                  <div className="w-20 h-20 bg-sky-50 dark:bg-sky-900/30 rounded-full flex items-center justify-center">
                    <CheckCircle2 className="w-10 h-10 text-sky-500 dark:text-sky-400" />
                  </div>
                  <div>
                    <h3 className="text-2xl font-black text-slate-900 dark:text-stone-100 mb-2">
                      {lectureToEdit ? t.editSuccess : t.success}
                    </h3>
                    <p className="text-slate-500 dark:text-slate-400">{t.lectureTitle}: <span className="font-bold text-slate-700 dark:text-slate-300">{title}</span></p>
                  </div>

                  {pendingMCQCount > 0 && (
                    <div className="w-full flex items-start gap-3 p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-900/50 rounded-2xl text-start">
                      <Loader2 className="w-5 h-5 text-blue-500 shrink-0 animate-spin mt-0.5" />
                      <p className="text-sm text-blue-700 dark:text-blue-300 leading-relaxed">
                        {isRtl
                          ? `جاري توليد أسئلة MCQ لـ ${pendingMCQCount} محاضرة. لا تغلق هذه الصفحة حتى ينتهي التوليد.`
                          : `Generating MCQs for ${pendingMCQCount} lecture(s). Keep this page open until it finishes.`}
                      </p>
                    </div>
                  )}
                  <div className="flex flex-col w-full gap-3 pt-4">
                    {!lectureToEdit && (
                      <button
                        onClick={resetForm}
                        className="w-full py-4 bg-sky-600 dark:bg-sky-500 text-white dark:text-zinc-900 rounded-2xl font-bold hover:bg-sky-700 dark:hover:bg-sky-600 transition-all shadow-lg shadow-sky-100 dark:shadow-none"
                      >
                        {t.uploadAnother}
                      </button>
                    )}
                    <button
                      onClick={onClose}
                      className="w-full py-4 bg-slate-50 dark:bg-zinc-800 text-slate-600 dark:text-slate-300 rounded-2xl font-bold hover:bg-slate-100 dark:hover:bg-zinc-700 transition-all"
                    >
                      {t.close}
                    </button>
                  </div>
                </motion.div>
              ) : (
                <form onSubmit={handleSubmit} className="space-y-5">
                  <AnimatePresence>
                    {error && (
                      <motion.div 
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="p-4 bg-red-50 dark:bg-red-900/30 border border-red-100 dark:border-red-900/50 text-red-700 dark:text-red-400 rounded-2xl flex items-start gap-3 text-sm font-medium"
                      >
                        <AlertCircle className="w-5 h-5 text-red-500 dark:text-red-400 shrink-0 mt-0.5" />
                        <div className="flex-1">
                          <p>{error}</p>
                        </div>
                        <button 
                          type="button"
                          onClick={() => setError(null)}
                          className="p-1 hover:bg-red-100 dark:hover:bg-red-900/50 rounded-lg transition-colors"
                        >
                          <X className="w-4 h-4 text-red-400" />
                        </button>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-sm font-semibold text-slate-700 dark:text-slate-300 ml-1">{t.lectureTitle}</label>
                      <input
                        required
                        type="text"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        className="w-full px-4 py-2.5 bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-900 dark:text-stone-100 rounded-xl focus:ring-2 focus:ring-sky-500 dark:focus:ring-sky-500 focus:border-transparent transition-all outline-none"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-sm font-semibold text-slate-700 dark:text-slate-300 ml-1">{t.lectureNumber}</label>
                      <input
                        type="number"
                        min="1"
                        value={lectureNumber}
                        onChange={(e) => setLectureNumber(e.target.value)}
                        className="w-full px-4 py-2.5 bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-900 dark:text-stone-100 rounded-xl focus:ring-2 focus:ring-sky-500 dark:focus:ring-sky-500 focus:border-transparent transition-all outline-none"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-sm font-semibold text-slate-700 dark:text-slate-300 ml-1">{t.type}</label>
                      <select
                        value={type}
                        onChange={(e) => {
                          const newType = e.target.value as LectureType;
                          setType(newType);
                          const currentCatData = CATEGORIES.find(c => c.value === category);
                          if (currentCatData && !currentCatData.types.includes(newType)) {
                            // Find first category that supports this type
                            const validCat = CATEGORIES.find(c => c.types.includes(newType));
                            if (validCat) setCategory(validCat.value);
                          }
                        }}
                        className="w-full px-4 py-2.5 bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-900 dark:text-stone-100 rounded-xl focus:ring-2 focus:ring-sky-500 dark:focus:ring-sky-500 outline-none transition-all"
                      >
                        <option value="theoretical">{t.theoretical}</option>
                        <option value="practical">{t.practical}</option>
                      </select>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-sm font-semibold text-slate-700 dark:text-slate-300 ml-1">
                        {hasCurriculum ? (isRtl ? 'الكورس' : 'Course') : t.category}
                      </label>
                      {hasCurriculum ? (
                        <select
                          value={courseFilter}
                          onChange={(e) => {
                            setCourseFilter(e.target.value as CourseId);
                            setSubjectId(''); // subject list changes with the course
                          }}
                          className="w-full px-4 py-2.5 bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-900 dark:text-stone-100 rounded-xl focus:ring-2 focus:ring-sky-500 dark:focus:ring-sky-500 outline-none transition-all"
                        >
                          {COURSE_IDS.map(id => (
                            <option key={id} value={id}>
                              {isRtl ? COURSE_LABELS[id].ar : COURSE_LABELS[id].en}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <select
                          value={category}
                          onChange={(e) => setCategory(e.target.value as Category)}
                          className="w-full px-4 py-2.5 bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-900 dark:text-stone-100 rounded-xl focus:ring-2 focus:ring-sky-500 dark:focus:ring-sky-500 outline-none transition-all"
                        >
                          {CATEGORIES.filter(c => c.types.includes(type)).map((c) => (
                            <option key={c.value} value={c.value}>{t[c.labelKey]}</option>
                          ))}
                        </select>
                      )}
                    </div>
                  </div>

                  {hasCurriculum && (
                    <div className="space-y-1.5">
                      <label className="text-sm font-semibold text-slate-700 dark:text-slate-300 ml-1">
                        {isRtl ? 'المادة' : 'Subject'}
                      </label>
                      <select
                        required
                        value={subjectId}
                        onChange={(e) => setSubjectId(e.target.value)}
                        className="w-full px-4 py-2.5 bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-900 dark:text-stone-100 rounded-xl focus:ring-2 focus:ring-sky-500 dark:focus:ring-sky-500 outline-none transition-all"
                      >
                        <option value="">{isRtl ? 'اختر المادة' : 'Select subject'}</option>
                        {courseSubjects.map(sub => (
                          <option key={sub.id} value={sub.id}>
                            {isRtl ? sub.nameAr : sub.nameEn}
                          </option>
                        ))}
                      </select>
                      {courseSubjects.length === 0 && (
                        <p className="text-xs text-amber-600 dark:text-amber-400 ml-1">
                          {isRtl ? 'لا توجد مواد في هذا الكورس' : 'No subjects in this course'}
                        </p>
                      )}
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-sm font-semibold text-slate-700 dark:text-slate-300 ml-1">{isRtl ? 'النسخة' : 'Version'}</label>
                      <select
                        value={version}
                        onChange={(e) => setVersion(e.target.value as 'original' | 'translated')}
                        className="w-full px-4 py-2.5 bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-900 dark:text-stone-100 rounded-xl focus:ring-2 focus:ring-sky-500 dark:focus:ring-sky-500 outline-none transition-all"
                      >
                        <option value="original">{t.original}</option>
                        <option value="translated">{t.translated}</option>
                      </select>
                    </div>

                    {version === 'translated' && (
                      <div className="space-y-1.5">
                        <label className="text-sm font-semibold text-slate-700 dark:text-slate-300 ml-1">
                          {isRtl ? 'مترجمة عن' : 'Translated from'}
                        </label>
                        <select
                          value={translationOf}
                          onChange={(e) => setTranslationOf(e.target.value)}
                          className="w-full px-4 py-2.5 bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-900 dark:text-stone-100 rounded-xl focus:ring-2 focus:ring-sky-500 dark:focus:ring-sky-500 outline-none transition-all"
                        >
                          <option value="">{isRtl ? '— بدون ربط —' : '— Not linked —'}</option>
                          {originalCandidates.map(l => (
                            <option key={l.id} value={l.id}>
                              {l.number ? `${l.number}. ` : ''}{l.title}
                            </option>
                          ))}
                        </select>
                        <p className="text-xs text-slate-500 dark:text-slate-400 ml-1">
                          {isRtl
                            ? 'الربط يجعل المحاضرتين تشتركان في نفس بنك الأسئلة.'
                            : 'Linking makes both lectures share one question bank.'}
                        </p>
                        {originalCandidates.length === 0 && (
                          <p className="text-xs text-amber-600 dark:text-amber-400 ml-1">
                            {isRtl ? 'لا توجد محاضرات أصلية في هذه المادة' : 'No original lectures in this subject'}
                          </p>
                        )}
                      </div>
                    )}

                    <div className="flex items-center mt-6">
                      <label className="flex items-center gap-3 cursor-pointer">
                        <div className="relative">
                          <input 
                            type="checkbox" 
                            className="sr-only" 
                            checked={isWeekly}
                            onChange={(e) => setIsWeekly(e.target.checked)}
                          />
                          <div className={`block w-10 h-6 rounded-full transition-colors ${isWeekly ? 'bg-sky-600 dark:bg-sky-500' : 'bg-slate-300 dark:bg-zinc-700'}`}></div>
                          <div className={`dot absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform ${isWeekly ? 'transform translate-x-4' : ''}`}></div>
                        </div>
                        <span className="text-sm font-bold text-slate-700 dark:text-slate-300">{t.addToWeekly}</span>
                      </label>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-sm font-semibold text-slate-700 dark:text-slate-300 ml-1">{isRtl ? 'رابط يوتيوب (اختياري)' : 'YouTube URL (Optional)'}</label>
                    <input
                      type="url"
                      value={youtubeUrl}
                      onChange={(e) => setYoutubeUrl(e.target.value)}
                      placeholder="https://youtube.com/watch?v=..."
                      className="w-full px-4 py-2.5 bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-900 dark:text-stone-100 rounded-xl focus:ring-2 focus:ring-sky-500 dark:focus:ring-sky-500 focus:border-transparent transition-all outline-none"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-sm font-semibold text-slate-700 dark:text-slate-300 ml-1">{t.pdfFile}</label>
                    <div 
                      onClick={() => fileInputRef.current?.click()}
                      onDragOver={handleDragOver}
                      onDragLeave={handleDragLeave}
                      onDrop={handleDrop}
                      className={`border-2 border-dashed rounded-2xl p-6 flex flex-col items-center justify-center gap-2 cursor-pointer transition-all ${
                        isDragging ? 'border-sky-500 dark:border-sky-500 bg-sky-50 dark:bg-sky-900/30 scale-[1.02]' : 
                        files.length > 0 ? 'border-sky-200 dark:border-sky-700 bg-sky-50 dark:bg-sky-900/30' : 
                        'border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800 hover:border-sky-300 dark:hover:border-sky-500 hover:bg-sky-50 dark:hover:bg-sky-900/10'
                      }`}
                    >
                      <input
                        type="file"
                        ref={fileInputRef}
                        onChange={handleFileChange}
                        accept=".pdf"
                        multiple={!lectureToEdit}
                        className="hidden"
                      />
                      {files.length > 0 ? (
                        <>
                          <CheckCircle2 className="w-8 h-8 text-sky-500 dark:text-sky-400" />
                          <span className="text-sm font-bold text-sky-700 dark:text-sky-300 truncate max-w-xs">{files.length === 1 ? files[0].name : isRtl ? `تم تحديد ${files.length} ملفات` : `${files.length} files selected`}</span>
                          <span className="text-xs text-sky-600 dark:text-sky-500">
                            {files.length === 1 
                              ? `${(files[0].size / 1024 / 1024).toFixed(2)} MB` 
                              : `${(files.reduce((acc, f) => acc + f.size, 0) / 1024 / 1024).toFixed(2)} MB total`
                            }
                          </span>
                        </>
                      ) : (
                        <>
                          <FileUp className={`w-8 h-8 ${isDragging ? 'text-sky-500 dark:text-sky-400 animate-bounce' : 'text-slate-400 dark:text-slate-500'}`} />
                          <span className="text-sm font-bold text-slate-600 dark:text-slate-400">{t.clickToUpload} {lectureToEdit ? '' : isRtl ? '(يمكنك اختيار عدة ملفات)' : '(Multiple files allowed)'}</span>
                          <span className="text-xs text-slate-400 dark:text-slate-500">{t.dragDrop}</span>
                          <span className="text-[10px] text-slate-300 dark:text-slate-600 uppercase tracking-widest mt-1">{t.maxSize}</span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-sm font-semibold text-slate-700 dark:text-slate-300 ml-1">{t.description}</label>
                    <textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      className="w-full px-4 py-2.5 bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-900 dark:text-stone-100 rounded-xl focus:ring-2 focus:ring-sky-500 dark:focus:ring-sky-500 outline-none transition-all min-h-[80px] resize-none"
                    />
                  </div>

                  {uploadProgress !== null && (
                    <div className="space-y-2">
                      <div className="flex justify-between text-xs font-bold text-slate-500 dark:text-slate-400">
                        <span>{isRtl ? 'جاري الرفع...' : 'Uploading...'}</span>
                        <span>{Math.round(uploadProgress)}%</span>
                      </div>
                      <div className="w-full bg-slate-100 dark:bg-zinc-800 rounded-full h-2 overflow-hidden">
                        <motion.div 
                          initial={{ width: 0 }}
                          animate={{ width: `${uploadProgress}%` }}
                          className="bg-sky-600 dark:bg-sky-500 h-full"
                        />
                      </div>
                    </div>
                  )}

                  {files.length > 1 && !isSubmitting && (
                    <div className="flex items-center justify-between pb-2">
                      <button
                        type="button"
                        onClick={() => {
                          const updated = saveCurrentConfig(fileConfigs);
                          setFileConfigs(updated);
                          const nextIdx = currentFileIndex - 1;
                          setCurrentFileIndex(nextIdx);
                          loadConfig(nextIdx, updated);
                        }}
                        disabled={currentFileIndex === 0}
                        className="px-4 py-2 text-sm font-bold bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-700 dark:text-slate-300 rounded-xl disabled:opacity-50"
                      >
                        {isRtl ? 'السابق' : 'Previous'}
                      </button>
                      <span className="text-sm font-bold text-slate-500 dark:text-slate-400">
                        {currentFileIndex + 1} / {files.length}
                        <br />
                        <span className="text-xs font-normal">
                          {files[currentFileIndex]?.name}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          const updated = saveCurrentConfig(fileConfigs);
                          setFileConfigs(updated);
                          const nextIdx = currentFileIndex + 1;
                          setCurrentFileIndex(nextIdx);
                          loadConfig(nextIdx, updated);
                        }}
                        disabled={currentFileIndex === files.length - 1}
                        className="px-4 py-2 text-sm font-bold bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-700 dark:text-slate-300 rounded-xl disabled:opacity-50"
                      >
                        {isRtl ? 'التالي' : 'Next'}
                      </button>
                    </div>
                  )}

                  <button
                    disabled={isSubmitting || (!lectureToEdit && files.length === 0 && !youtubeUrl)}
                    type="button"
                    onClick={(e) => {
                       // Force saving the current config state before submission
                       if (files.length > 1) {
                         setFileConfigs(saveCurrentConfig(fileConfigs));
                       }
                       handleSubmit(e);
                    }}
                    className="w-full py-3.5 bg-sky-600 dark:bg-sky-500 text-white dark:text-zinc-900 rounded-xl font-bold hover:bg-sky-700 dark:hover:bg-sky-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg shadow-sky-200 dark:shadow-none"
                  >
                    {isSubmitting ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                        {t.uploading}
                      </>
                    ) : (
                      <>
                        <Upload className="w-5 h-5" />
                        {lectureToEdit ? t.saveChanges : (files.length > 1 ? (isRtl ? `رفع الكل (${files.length})` : `Upload All (${files.length})`) : t.publishLecture)}
                      </>
                    )}
                  </button>
                </form>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
