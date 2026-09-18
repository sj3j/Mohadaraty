import React, { useState, useEffect, useRef } from 'react';
import { collection, query, onSnapshot, orderBy, addDoc, serverTimestamp, getDocs, getDoc, doc, setDoc, updateDoc, arrayUnion, arrayRemove, deleteDoc, where } from 'firebase/firestore';
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { db, storage, handleFirestoreError, OperationType } from '../lib/firebase';
import { Lecture, Language, TRANSLATIONS, UserProfile, CATEGORIES, Homework } from '../types';
import { Loader2, ClipboardCheck, Plus, X, BookOpen, AlertCircle, Calendar, Camera, Image as ImageIcon, Trash2, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import SpotlightTooltip from './SpotlightTooltip';
import { useStageContext } from '../contexts/StageContext';
import { useStageSubjects } from '../hooks/useStageSubjects';
import {
  resolveSubjectLabel, subjectMetaFrom, subjectSlugOf, subjectsForCourse,
} from '../lib/subjectDisplay';
import { COURSE_IDS, COURSE_LABELS } from '../types';
import { canManage } from '../lib/permissions';

interface WeeklyListScreenProps {
  lang: Language;
  user: UserProfile | null;
}

/** Timetable photo doc for a stage. The pre-multi-stage build wrote one global
 *  `settings/weekly_schedule`, which meant each stage's representative
 *  overwrote every other stage's timetable. */
const schedulePhotoDocId = (stageId: string) => `weekly_schedule_${stageId}`;

export default function WeeklyListScreen({ lang, user }: WeeklyListScreenProps) {
  const t = TRANSLATIONS[lang];
  const isRtl = lang === 'ar';

  const { subjects } = useStageSubjects();
  // A stage with no curriculum yet (stage 1 seeds none) keeps the legacy list.
  const hasCurriculum = subjects.length > 0;

  const [homeworks, setHomeworks] = useState<Homework[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  
  // Schedule photo state
  const [schedulePhotoUrl, setSchedulePhotoUrl] = useState<string | null>(null);
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // Admin form state
  const [showAdminForm, setShowAdminForm] = useState(false);
  // Starts EMPTY and is required. It used to default to CATEGORIES[0] -
  // 'pharmacology' - so a representative who never touched the dropdown filed
  // their stage's homework under a stage-3 subject without noticing.
  const [subject, setSubject] = useState<string>('');
  const [type, setType] = useState<'theoretical' | 'practical' | 'both'>('theoretical');
  const [note, setNote] = useState('');
  const [dueDate, setDueDate] = useState<string>('');
  const [selectedLectures, setSelectedLectures] = useState<{ label: string; lectureId: string }[]>([]);
  
  // Lecture search state
  const [allLectures, setAllLectures] = useState<Lecture[]>([]);
  const [lectureSearch, setLectureSearch] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [homeworkToDelete, setHomeworkToDelete] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  
  // Image viewer state
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [zoomLevel, setZoomLevel] = useState(1);

  const { effectiveStageId } = useStageContext();

  useEffect(() => {
    // Load homeworks. With no resolved stage there is no safe query to run -
    // the old unfiltered fallback listed every stage's homework.
    let unsubscribe = () => {};
    if (!effectiveStageId) {
      setHomeworks([]);
      setIsLoading(false);
    } else {
      const q = query(collection(db, 'homeworks'), where('stageId', '==', effectiveStageId), orderBy('dueDate', 'asc'));
      unsubscribe = onSnapshot(q, (snapshot) => {
        const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data({ serverTimestamps: 'estimate' }) } as Homework));
        setHomeworks(docs);
        setIsLoading(false);
      }, (error) => {
        handleFirestoreError(error, OperationType.LIST, 'homeworks');
      });
    }

    // Load schedule photo. The timetable is per stage; the pre-multi-stage app
    // kept a single global doc, so fall back to it when this stage has no photo
    // of its own yet. Writes always go to the per-stage doc.
    let unsubscribeSettings = () => {};
    if (effectiveStageId) {
      unsubscribeSettings = onSnapshot(doc(db, 'settings', schedulePhotoDocId(effectiveStageId)), async (docSnap) => {
        if (docSnap.exists()) {
          setSchedulePhotoUrl(docSnap.data().photoUrl);
          return;
        }
        try {
          const legacy = await getDoc(doc(db, 'settings', 'weekly_schedule'));
          setSchedulePhotoUrl(legacy.exists() ? legacy.data().photoUrl : null);
        } catch {
          setSchedulePhotoUrl(null);
        }
      }, (error) => {
        handleFirestoreError(error, OperationType.GET, 'settings/weekly_schedule');
      });
    } else {
      setSchedulePhotoUrl(null);
    }

    // Lectures for the link picker and the admin dropdown. Scoped to this stage:
    // an unscoped read let a representative attach another stage's lecture to
    // their homework.
    const fetchLectures = async () => {
      if (!effectiveStageId) {
        setAllLectures([]);
        return;
      }
      try {
        const lecturesSnapshot = await getDocs(
          query(collection(db, 'lectures'), where('stageId', '==', effectiveStageId))
        );
        const lecturesData = lecturesSnapshot.docs
          .map(doc => ({ id: doc.id, ...doc.data() } as Lecture))
          // Wiped-year stubs have no PDF to attach - see the filter in App.tsx.
          .filter(l => !(l as any).archived);
        setAllLectures(lecturesData);
      } catch (error) {
        console.error('Error fetching lectures:', error);
      }
    };
    fetchLectures();

    return () => {
      unsubscribe();
      unsubscribeSettings();
    };
  }, [user?.uid, user?.role, user?.group, effectiveStageId]);

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;
    // Without a stage we cannot tell which stage's timetable this replaces.
    if (!effectiveStageId) {
      alert(isRtl ? 'لم يتم تحديد المرحلة. أعد تحميل الصفحة.' : 'No stage resolved. Please reload.');
      return;
    }

    setIsUploadingPhoto(true);
    try {
      // Stage-scoped prefix, mirroring announcements/{stageId}/{fileName}. The
      // flat path it replaces had no stage in it, so storage.rules could not
      // tell one stage's timetable from another's.
      const storageRef = ref(storage, `schedules/${effectiveStageId}/weekly_${Date.now()}`);
      const uploadTask = uploadBytesResumable(storageRef, file);

      uploadTask.on('state_changed', 
        null,
        (error) => {
          console.error("Upload error:", error);
          setIsUploadingPhoto(false);
          alert(t.errorUnknown);
        },
        async () => {
          const downloadURL = await getDownloadURL(uploadTask.snapshot.ref);
          await setDoc(doc(db, 'settings', schedulePhotoDocId(effectiveStageId)), {
            photoUrl: downloadURL,
            stageId: effectiveStageId,
            updatedAt: serverTimestamp(),
            updatedBy: user.uid
          });
          setIsUploadingPhoto(false);
        }
      );
    } catch (error) {
      console.error("Error uploading photo:", error);
      setIsUploadingPhoto(false);
      alert(t.errorUnknown);
    }
  };

  const handleAddLecture = (lecture: Lecture) => {
    if (!selectedLectures.find(l => l.lectureId === lecture.id)) {
      setSelectedLectures([...selectedLectures, { 
        label: `Lec ${lecture.number || ''} ${lecture.title}`, 
        lectureId: lecture.id 
      }]);
    }
    setLectureSearch('');
  };

  const handleRemoveLecture = (id: string) => {
    setSelectedLectures(selectedLectures.filter(l => l.lectureId !== id));
  };

  const handleEditClick = (hw: Homework) => {
    setEditingId(hw.id);
    setSubject(hw.subject);
    setType(hw.type as 'theoretical' | 'practical' | 'both');
    setNote(hw.note || '');
    setSelectedLectures(hw.lectures);
    if (hw.dueDate) {
       const dateObj = hw.dueDate?.toDate ? hw.dueDate.toDate() : new Date(hw.dueDate);
       setDueDate(dateObj.toISOString().split('T')[0]);
    } else {
       setDueDate('');
    }
    setShowAdminForm(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setSubject('');
    setType('theoretical');
    setNote('');
    setDueDate('');
    setSelectedLectures([]);
    setShowAdminForm(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Refuse rather than guess. This used to default to 'stage_3', so a
    // representative whose stage had not resolved posted homework into someone
    // else's stage.
    if (!effectiveStageId) {
      alert(isRtl ? 'لم يتم تحديد المرحلة. أعد تحميل الصفحة.' : 'No stage resolved. Please reload.');
      return;
    }

    if (!subject) {
      alert(isRtl ? 'اختر المادة أولاً.' : 'Please choose a subject first.');
      return;
    }

    setIsSubmitting(true);
    try {
      let finalDueDate = null;
      if (dueDate) {
         finalDueDate = new Date(dueDate);
         finalDueDate.setHours(23, 59, 59, 999);
      }

      // The subject NAME rides along, so functions/index.js can title the push
      // notification without a second hardcoded copy of the subject list, and so
      // a hidden or renamed subject still names its homework.
      const meta = subjectMetaFrom(subjects, subject);

      const homeworkData: Partial<Homework> = {
        subject,
        type,
        note,
        lectures: selectedLectures,
        stageId: effectiveStageId,
        ...(meta ? {
          subjectId: meta.subjectId,
          courseId: meta.courseId,
          subjectName: meta.subjectName,
          subjectNameAr: meta.subjectNameAr,
        } : {}),
      };

      if (finalDueDate) {
         homeworkData.dueDate = finalDueDate;
      }

      if (editingId) {
        await setDoc(doc(db, 'homeworks', editingId), homeworkData, { merge: true });
        alert(isRtl ? 'تم التعديل بنجاح!' : 'Edited successfully!');
      } else {
        homeworkData.createdAt = serverTimestamp();
        await addDoc(collection(db, 'homeworks'), homeworkData);
      }

      // Reset form
      handleCancelEdit();
      
      // Note: Cloud function will handle the push notification for new ones
    } catch (error) {
      console.error('Error saving homework:', error);
      alert(t.errorUnknown);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggleComplete = async (homeworkId: string) => {
    if (!user) return;
    const isCompleted = user.completedWeeklyTasks?.includes(homeworkId);
    try {
      const userRef = doc(db, 'users', user.uid);
      if (isCompleted) {
        await setDoc(userRef, { completedWeeklyTasks: arrayRemove(homeworkId) }, { merge: true });
      } else {
        await setDoc(userRef, { completedWeeklyTasks: arrayUnion(homeworkId) }, { merge: true });
      }
    } catch (error) {
      console.error('Error toggling complete:', error);
    }
  };

  const handleToggleStudied = async (lectureId: string) => {
    if (!user) return;
    const isStudied = user.studied?.includes(lectureId);
    try {
      const userRef = doc(db, 'users', user.uid);
      if (isStudied) {
        await setDoc(userRef, { studied: arrayRemove(lectureId) }, { merge: true });
      } else {
        await setDoc(userRef, { studied: arrayUnion(lectureId) }, { merge: true });
      }
    } catch (error) {
      console.error('Error toggling studied:', error);
    }
  };

  const handleDeleteHomework = async () => {
    if (!homeworkToDelete) return;
    setIsDeleting(true);
    try {
      await deleteDoc(doc(db, 'homeworks', homeworkToDelete));
      setHomeworkToDelete(null);
    } catch (error) {
      console.error('Error deleting homework:', error);
      alert(t.errorUnknown);
    } finally {
      setIsDeleting(false);
    }
  };

  const filteredLectures = allLectures.filter(l => {
    if (!lectureSearch) return false;
    const searchLower = lectureSearch.toLowerCase();
    return (
      l.title.toLowerCase().includes(searchLower) || 
      (l.number && l.number.toString().includes(searchLower))
    ) && subjectSlugOf(l) === subject && l.type === type;
  });

  const [showCompleted, setShowCompleted] = useState(false);

  // Group homeworks
  const completedHomeworks = homeworks.filter(hw => user?.completedWeeklyTasks?.includes(hw.id));
  const incompleteHomeworks = homeworks.filter(hw => !user?.completedWeeklyTasks?.includes(hw.id));

  return (
    <div className="max-w-3xl mx-auto px-4 pt-6" dir={isRtl ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-sky-100 dark:bg-sky-900/30 rounded-2xl text-sky-600 dark:text-sky-400">
            <ClipboardCheck className="w-6 h-6" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-stone-100">{t.weeklyTasks}</h1>
        </div>
        
        {canManage(user, 'manageHomeworks') && (
          <button
            onClick={() => setShowAdminForm(!showAdminForm)}
            className="flex items-center gap-2 px-4 py-2 bg-sky-600 text-white rounded-xl font-bold hover:bg-sky-700 transition-colors"
          >
            {showAdminForm ? <X className="w-5 h-5" /> : <Plus className="w-5 h-5" />}
            <span className="hidden sm:inline">{showAdminForm ? t.close : t.postHomework}</span>
          </button>
        )}
      </div>

      {/* Schedule Photo Section */}
      <div className="mb-8 bg-white dark:bg-zinc-800 rounded-3xl p-4 border border-slate-200 dark:border-zinc-700 shadow-sm">
        <div className="flex items-center justify-between mb-4 px-2">
          <h2 className="text-lg font-bold text-slate-900 dark:text-stone-100 flex items-center gap-2">
            <ImageIcon className="w-5 h-5 text-sky-600 dark:text-sky-400" />
            {isRtl ? 'جدول المحاضرات' : 'Lectures Schedule'}
          </h2>
          {canManage(user, 'manageHomeworks') && (
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploadingPhoto}
              className="flex items-center gap-2 px-3 py-1.5 bg-sky-50 dark:bg-sky-900/30 text-sky-600 dark:text-sky-400 rounded-lg text-sm font-bold hover:bg-sky-100 dark:hover:bg-sky-900/50 transition-colors disabled:opacity-50"
            >
              {isUploadingPhoto ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}
              {isRtl ? 'تحديث الجدول' : 'Update Schedule'}
            </button>
          )}
        </div>
        
        <input 
          type="file" 
          ref={fileInputRef} 
          onChange={handlePhotoUpload} 
          accept="image/*" 
          className="hidden" 
        />

        <div className="w-full bg-slate-50 dark:bg-zinc-900 rounded-2xl overflow-hidden border border-slate-100 dark:border-zinc-800 min-h-[200px] flex items-center justify-center">
          {schedulePhotoUrl ? (
            <img 
              src={schedulePhotoUrl} 
              alt="Schedule" 
              className="w-full h-auto object-contain max-h-[500px] cursor-pointer hover:opacity-90 transition-opacity" 
              referrerPolicy="no-referrer" 
              onClick={() => setSelectedImage(schedulePhotoUrl)}
            />
          ) : (
            <div className="text-center p-8 text-slate-400 dark:text-slate-500">
              <ImageIcon className="w-12 h-12 mx-auto mb-2 opacity-50" />
              <p>{isRtl ? 'لم يتم رفع جدول بعد' : 'No schedule uploaded yet'}</p>
            </div>
          )}
        </div>
      </div>

      <AnimatePresence>
        {selectedImage && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-black/95 flex items-center justify-center p-4 sm:p-8 cursor-zoom-out"
            onClick={() => {
              setSelectedImage(null);
              setZoomLevel(1);
            }}
          >
            <button 
              className="absolute top-4 end-4 p-3 bg-white/10 hover:bg-white/20 rounded-full text-white transition-colors z-10"
              onClick={(e) => {
                e.stopPropagation();
                setSelectedImage(null);
                setZoomLevel(1);
              }}
            >
              <X className="w-6 h-6" />
            </button>
            <div className="w-full h-full flex items-center justify-center overflow-auto">
              <motion.img
                src={selectedImage}
                alt="Schedule Fullscreen"
                className={`max-w-full max-h-full object-contain transition-transform duration-300 ${zoomLevel > 1 ? 'cursor-zoom-out' : 'cursor-zoom-in'}`}
                style={{ scale: zoomLevel, transformOrigin: 'center center' }}
                onClick={(e) => {
                  e.stopPropagation();
                  setZoomLevel(prev => prev === 1 ? 2.5 : 1);
                }}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {homeworkToDelete && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white dark:bg-zinc-800 rounded-3xl p-6 max-w-sm w-full shadow-xl border border-slate-200 dark:border-zinc-700"
            >
              <div className="w-12 h-12 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center mb-4 mx-auto">
                <Trash2 className="w-6 h-6 text-red-600 dark:text-red-400" />
              </div>
              <h3 className="text-xl font-bold text-center text-slate-900 dark:text-stone-100 mb-2">
                {isRtl ? 'حذف الواجب' : 'Delete Homework'}
              </h3>
              <p className="text-center text-slate-500 dark:text-slate-400 mb-6">
                {t.confirmDeleteHomework || (isRtl ? 'هل أنت متأكد من حذف هذا الواجب؟' : 'Are you sure you want to delete this homework?')}
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setHomeworkToDelete(null)}
                  disabled={isDeleting}
                  className="flex-1 py-3 px-4 rounded-xl font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-zinc-700 hover:bg-slate-200 dark:hover:bg-zinc-600 transition-colors"
                >
                  {t.close || (isRtl ? 'إلغاء' : 'Cancel')}
                </button>
                <button
                  onClick={handleDeleteHomework}
                  disabled={isDeleting}
                  className="flex-1 py-3 px-4 rounded-xl font-bold text-white bg-red-600 hover:bg-red-700 transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {isDeleting ? <Loader2 className="w-5 h-5 animate-spin" /> : <Trash2 className="w-5 h-5" />}
                  {t.delete || (isRtl ? 'حذف' : 'Delete')}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showAdminForm && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden mb-8"
          >
            <form onSubmit={handleSubmit} className="bg-white dark:bg-zinc-800 p-6 rounded-3xl border border-slate-200 dark:border-zinc-700 shadow-sm space-y-6">
              <h2 className="text-lg font-bold text-slate-900 dark:text-stone-100">{t.postHomework}</h2>
              
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">{t.category}</label>
                  <select
                    value={subject}
                    onChange={(e) => setSubject(e.target.value as any)}
                    className="w-full bg-slate-50 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 rounded-xl px-4 py-3 outline-none focus:border-sky-500 dark:text-stone-100"
                  >
                    <option value="" disabled>{isRtl ? 'اختر المادة...' : 'Select subject...'}</option>
                    {hasCurriculum
                      ? COURSE_IDS.map(courseId => {
                          const courseSubjects = subjectsForCourse(subjects, courseId);
                          if (courseSubjects.length === 0) return null;
                          return (
                            <optgroup key={courseId} label={isRtl ? COURSE_LABELS[courseId].ar : COURSE_LABELS[courseId].en}>
                              {courseSubjects.map(sub => (
                                <option key={sub.id} value={sub.id}>{isRtl ? sub.nameAr : sub.nameEn}</option>
                              ))}
                            </optgroup>
                          );
                        })
                      : CATEGORIES.map(cat => (
                          <option key={cat.value} value={cat.value}>{t[cat.labelKey]}</option>
                        ))}
                  </select>
                </div>
                
                <div>
                  <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">{t.dueDate || 'تاريخ التسليم'}</label>
                  <input
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    className="w-full bg-slate-50 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 rounded-xl px-4 py-3 outline-none focus:border-sky-500 dark:text-stone-100"
                  />
                </div>

                <div className="sm:col-span-2 lg:col-span-1">
                  <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">{t.type}</label>
                  <div className="flex gap-2 bg-slate-50 dark:bg-zinc-900 p-1 rounded-xl border border-slate-200 dark:border-zinc-700">
                    <button
                      type="button"
                      onClick={() => setType('theoretical')}
                      className={`flex-1 py-2 px-2 rounded-lg text-xs sm:text-sm font-bold transition-all ${
                        type === 'theoretical'
                          ? 'bg-white dark:bg-zinc-700 text-sky-600 dark:text-sky-400 shadow-sm'
                          : 'text-slate-500 dark:text-slate-400'
                      }`}
                    >
                      {t.theoretical}
                    </button>
                    <button
                      type="button"
                      onClick={() => setType('practical')}
                      className={`flex-1 py-2 px-2 rounded-lg text-xs sm:text-sm font-bold transition-all ${
                        type === 'practical'
                          ? 'bg-white dark:bg-zinc-700 text-sky-600 dark:text-sky-400 shadow-sm'
                          : 'text-slate-500 dark:text-slate-400'
                      }`}
                    >
                      {t.practical}
                    </button>
                    <button
                      type="button"
                      onClick={() => setType('both')}
                      className={`flex-1 py-2 px-2 rounded-lg text-xs sm:text-sm font-bold transition-all ${
                        type === 'both'
                          ? 'bg-white dark:bg-zinc-700 text-sky-600 dark:text-sky-400 shadow-sm'
                          : 'text-slate-500 dark:text-slate-400'
                      }`}
                    >
                      {t.both || (isRtl ? 'عملي ونظري' : 'Both')}
                    </button>
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">{t.examLectures}</label>
                
                {/* Selected Lectures */}
                {selectedLectures.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-3">
                    {selectedLectures.map(lec => (
                      <div key={lec.lectureId} className="flex items-center gap-2 bg-sky-50 dark:bg-sky-900/30 text-sky-700 dark:text-sky-300 px-3 py-1.5 rounded-lg text-sm font-medium border border-sky-100 dark:border-sky-800">
                        <span>{lec.label}</span>
                        <button type="button" onClick={() => handleRemoveLecture(lec.lectureId)} className="hover:text-red-500">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="relative">
                  <input
                    type="text"
                    value={lectureSearch}
                    onChange={(e) => setLectureSearch(e.target.value)}
                    placeholder={isRtl ? 'ابحث برقم المحاضرة أو العنوان...' : 'Search by lecture number or title...'}
                    className="w-full bg-slate-50 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 rounded-xl px-4 py-3 outline-none focus:border-sky-500 dark:text-stone-100"
                  />
                  
                  {lectureSearch && (
                    <div className="absolute z-10 w-full mt-2 bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded-xl shadow-lg max-h-48 overflow-y-auto">
                      {filteredLectures.length > 0 ? (
                        filteredLectures.map(lec => (
                          <button
                            key={lec.id}
                            type="button"
                            onClick={() => handleAddLecture(lec)}
                            className="w-full text-start px-4 py-3 hover:bg-slate-50 dark:hover:bg-zinc-700 border-b border-slate-100 dark:border-zinc-700 last:border-0 dark:text-stone-100"
                          >
                            <div className="font-bold">Lec {lec.number}</div>
                            <div className="text-sm text-slate-500 truncate">{lec.title}</div>
                          </button>
                        ))
                      ) : (
                        <div className="px-4 py-3 text-slate-500 text-sm text-center">
                          {isRtl ? 'لا توجد نتائج' : 'No results found'}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">{t.additionalNote}</label>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 rounded-xl px-4 py-3 outline-none focus:border-sky-500 dark:text-stone-100 min-h-[100px] resize-y"
                  placeholder={isRtl ? 'مثال: ادرس فقط الأجزاء المظللة...' : 'Example: Study only highlighted parts...'}
                />
              </div>

              <div className="flex items-center gap-3 mt-6">
                {editingId && (
                  <button
                    type="button"
                    onClick={handleCancelEdit}
                    className="flex-1 py-3 bg-slate-100 text-slate-700 dark:bg-zinc-700 dark:text-slate-300 rounded-xl font-bold hover:bg-slate-200 dark:hover:bg-zinc-600 transition-colors"
                  >
                    {t.close || (isRtl ? 'إلغاء' : 'Cancel')}
                  </button>
                )}
                <button
                  type="submit"
                  disabled={isSubmitting || selectedLectures.length === 0}
                  className="flex-[2] py-3 bg-sky-600 text-white rounded-xl font-bold hover:bg-sky-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isSubmitting ? <Loader2 className="w-5 h-5 animate-spin" /> : <ClipboardCheck className="w-5 h-5" />}
                  {editingId ? t.editHomework : t.publishPost}
                </button>
              </div>
            </form>
          </motion.div>
        )}
      </AnimatePresence>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-8 h-8 text-sky-600 dark:text-sky-400 animate-spin" />
        </div>
      ) : homeworks.length > 0 ? (
        <div className="space-y-6">
          <div className="space-y-4">
            {incompleteHomeworks.map((hw, index) => {
              const createdAt = hw.createdAt?.toMillis ? hw.createdAt.toMillis() : Date.now();
              const deadlineObj = hw.dueDate?.toMillis ? hw.dueDate.toMillis() : (hw.dueDate ? new Date(hw.dueDate).getTime() : createdAt + 7 * 24 * 60 * 60 * 1000);
              const deadline = deadlineObj;
              
              // Calculate calendar days left ignoring specific times (e.g. today to tomorrow is exactly 1 day)
              const now = new Date();
              const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
              const deadlineDate = new Date(deadline);
              const examDayStart = new Date(deadlineDate.getFullYear(), deadlineDate.getMonth(), deadlineDate.getDate()).getTime();
              
              const daysLeft = Math.round((examDayStart - todayStart) / (1000 * 60 * 60 * 24));
              
              let chipColor = 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
              if (daysLeft < 0) chipColor = 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
              else if (daysLeft <= 1) chipColor = 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
              else if (daysLeft <= 3) chipColor = 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400';

              return (
              <motion.div
                layout
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                key={hw.id}
                className="bg-white dark:bg-zinc-800 p-4 sm:p-6 rounded-[16px] border border-slate-100 dark:border-zinc-700 shadow-[0_2px_12px_rgba(0,0,0,0.06)] relative overflow-hidden"
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                       <h3 className="text-lg font-black text-slate-900 dark:text-stone-100">
                         {resolveSubjectLabel(hw as any, subjects, lang)}
                       </h3>
                       <span className={`px-3 py-1 rounded-full text-xs font-bold uppercase ${
                         hw.type === 'theoretical' 
                           ? 'bg-[#2196F3]/10 text-[#2196F3] dark:bg-[#2196F3]/20 dark:text-sky-400'
                           : hw.type === 'practical' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                           : 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300'
                       }`}>
                         {hw.type === 'theoretical' ? t.theoretical : hw.type === 'practical' ? t.practical : (t.both || (isRtl ? 'عملي ونظري' : 'Both'))}
                       </span>
                    </div>
                    {/* Deadline Chip */}
                    <div id={index === 0 ? "homework-deadline-chip-0" : undefined} className={`inline-flex items-center w-fit gap-1 px-3 py-1 rounded-full text-xs font-bold ${chipColor}`}>
                      <Calendar className="w-3.5 h-3.5" />
                      {daysLeft < 0 ? (isRtl ? `متأخر ${Math.abs(daysLeft)} أيام` : `Overdue by ${Math.abs(daysLeft)} days`) : 
                       daysLeft === 0 ? (isRtl ? 'اليوم' : 'Today') : 
                       daysLeft === 1 ? (isRtl ? 'غداً' : 'Tomorrow') :
                       (isRtl ? `يتبقى ${daysLeft} أيام` : `${daysLeft} days left`)}
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-2">
                    {canManage(user, 'manageHomeworks') && (
                      <>
                        <button
                          onClick={() => handleEditClick(hw)}
                          className="p-2 rounded-full transition-colors bg-slate-50 dark:bg-zinc-700 text-slate-400 hover:bg-sky-50 hover:text-sky-500"
                          title={t.editHomework}
                        >
                          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                             <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                          </svg>
                        </button>
                        <button
                          onClick={() => setHomeworkToDelete(hw.id)}
                          className="p-2 rounded-full transition-colors bg-slate-50 dark:bg-zinc-700 text-slate-400 hover:bg-red-50 hover:text-red-500"
                          title={t.delete || (isRtl ? 'حذف' : 'Delete')}
                        >
                          <Trash2 className="w-5 h-5" />
                        </button>
                      </>
                    )}
                    {user && (
                      <button
                        onClick={() => handleToggleComplete(hw.id)}
                        className="p-2 rounded-full transition-colors bg-slate-50 dark:bg-zinc-700 text-slate-400 hover:bg-[#2196F3]/10 hover:text-[#2196F3]"
                      >
                        <ClipboardCheck className="w-6 h-6" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="bg-slate-50 dark:bg-zinc-900/50 rounded-2xl p-4 mb-4 border border-slate-100 dark:border-zinc-800">
                  <p className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-3 flex items-center gap-2">
                    <BookOpen className="w-4 h-4 text-[#2196F3]" />
                    {t.examIncludes}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {hw.lectures.map((lec, i) => {
                      const actualLecture = allLectures.find(l => l.id === lec.lectureId);
                      const isStudied = user?.studied?.includes(lec.lectureId) || false;
                      return (
                        <div key={`${lec.lectureId}-${i}`} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded-[12px] shadow-sm">
                          <button
                            title={t.studied}
                            onClick={() => handleToggleStudied(lec.lectureId)}
                            className={`p-1 rounded-full border transition-colors ${
                              isStudied 
                                ? 'bg-[#2196F3] border-[#2196F3] text-white' 
                                : 'border-slate-300 dark:border-zinc-600 hover:border-[#2196F3]'
                            }`}
                          >
                            <Check className={`w-3.5 h-3.5 ${isStudied ? 'opacity-100' : 'opacity-0'}`} strokeWidth={3} />
                          </button>
                          <a
                            href={actualLecture?.pdfUrl || '#'}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm font-bold text-[#2196F3] dark:text-sky-400 hover:text-sky-600 transition-colors"
                          >
                            {lec.label}
                          </a>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {hw.note && (
                  <div className="flex gap-3 p-4 bg-amber-50 dark:bg-amber-900/20 rounded-2xl border border-amber-100 dark:border-amber-900/50">
                    <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0" />
                    <p className="text-sm text-amber-800 dark:text-amber-200 font-medium leading-relaxed">
                      {hw.note}
                    </p>
                  </div>
                )}
              </motion.div>
            )})}
            <SpotlightTooltip targetSelector="#homework-deadline-chip-0" text="اللون الأحمر = تسليم قريب!" placement="top" tooltipKey="homework_deadline" />
          </div>

          {/* Completed Section */}
          {completedHomeworks.length > 0 && (
            <div className="pt-4">
              <button
                onClick={() => setShowCompleted(!showCompleted)}
                className="w-full flex items-center justify-between p-4 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 rounded-2xl font-bold"
              >
                <span>{isRtl ? `المكتملة (${completedHomeworks.length})` : `Completed (${completedHomeworks.length})`}</span>
                <span className="transform transition-transform" style={{ transform: showCompleted ? 'rotate(180deg)' : 'rotate(0)' }}>▼</span>
              </button>
              <AnimatePresence>
                {showCompleted && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="space-y-4 pt-4 overflow-hidden"
                  >
                     {completedHomeworks.map(hw => (
                      <div key={hw.id} className="bg-white dark:bg-zinc-800 p-4 sm:p-6 rounded-[16px] border border-emerald-200 dark:border-emerald-900/50 shadow-sm opacity-75">
                         <div className="flex items-start justify-between mb-2">
                           <div className="flex flex-col gap-1">
                             <h3 className="text-lg font-black text-slate-900 dark:text-stone-100 flex items-center gap-2">
                               <Check className="w-5 h-5 text-emerald-500" />
                               {resolveSubjectLabel(hw as any, subjects, lang)}
                             </h3>
                             <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase w-fit ${
                               hw.type === 'theoretical' 
                                 ? 'bg-[#2196F3]/10 text-[#2196F3] dark:bg-[#2196F3]/20 dark:text-sky-400'
                                 : hw.type === 'practical' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                                 : 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300'
                             }`}>
                               {hw.type === 'theoretical' ? t.theoretical : hw.type === 'practical' ? t.practical : (t.both || (isRtl ? 'عملي ونظري' : 'Both'))}
                             </span>
                           </div>
                           <button
                             onClick={() => handleToggleComplete(hw.id)}
                             className="p-2 rounded-full transition-colors bg-emerald-100 text-emerald-600 hover:bg-emerald-200"
                           >
                             <ClipboardCheck className="w-5 h-5" />
                           </button>
                         </div>
                      </div>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

        </div>
      ) : (
        <div className="text-center py-12 bg-white dark:bg-zinc-800 rounded-3xl border border-slate-200 dark:border-zinc-700 border-dashed">
          <ClipboardCheck className="w-12 h-12 text-slate-300 dark:text-zinc-600 mx-auto mb-3" />
          <p className="text-slate-500 dark:text-slate-400 font-medium">{t.noWeeklyTasks}</p>
        </div>
      )}
    </div>
  );
}
