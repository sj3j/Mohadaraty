import React, { useState, useEffect, useMemo } from 'react';
import {
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  deleteDoc,
  doc,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../lib/firebase';
import { Lecture, RecordItem, Language, UserProfile, TRANSLATIONS } from '../../types';
import {
  Radio,
  Plus,
  Clock,
  HardDrive,
  CheckCircle2,
  Trash2,
  Edit2,
  Loader2,
  AlertCircle,
  FileAudio,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import AudioPlayer from '../AudioPlayer';
import AdminRecordUpload from '../AdminRecordUpload';
import { useStageContext } from '../../contexts/StageContext';
import { canManage } from '../../lib/permissions';
import { subjectSlugOf } from '../../lib/subjectDisplay';

export interface LectureRecordingsSectionProps {
  lecture: Lecture;
  user: UserProfile | null;
  lang: Language;
  highlightedRecordId?: string | null;
}

/**
 * Deterministically checks whether a Firestore RecordItem belongs to the given Lecture.
 */
export function recordBelongsToLecture(
  record: RecordItem,
  lecture: Lecture,
  fallbackStageId?: string
): boolean {
  // 1. Direct foreign key link has absolute priority
  if (record.lectureId) {
    if (record.lectureId === lecture.id) return true;
    if (lecture.translationOf && record.lectureId === lecture.translationOf) return true;
    return false;
  }

  // 2. Stage match
  const lectureStage = lecture.stageId || fallbackStageId;
  const recordStage = record.stageId || fallbackStageId;
  if (lectureStage && recordStage && lectureStage !== recordStage) {
    return false;
  }

  // 3. Subject match (checking subjectId, legacy category, and computed slug)
  const recSlug = subjectSlugOf(record);
  const lecSlug = subjectSlugOf(lecture);
  const subjectMatches =
    (record.subjectId && lecture.subjectId && record.subjectId === lecture.subjectId) ||
    (record.category && lecture.category && record.category === lecture.category) ||
    (recSlug && lecSlug && recSlug === lecSlug);

  if (!subjectMatches) return false;

  // 4. Type match (theoretical vs practical)
  if (record.type && lecture.type && record.type !== lecture.type) {
    return false;
  }

  // 5. Lecture number match
  if (record.number != null && lecture.number != null) {
    return Number(record.number) === Number(lecture.number);
  }

  // 6. Title fallback if number is not defined on one side
  if (record.title && lecture.title) {
    const cleanR = record.title.toLowerCase().trim();
    const cleanL = lecture.title.toLowerCase().trim();
    if (cleanR.includes(cleanL) || cleanL.includes(cleanR)) return true;
  }

  return false;
}

export default function LectureRecordingsSection({
  lecture,
  user,
  lang,
  highlightedRecordId,
}: LectureRecordingsSectionProps) {
  const isRtl = lang === 'ar';
  const t = TRANSLATIONS[lang];
  const { effectiveStageId } = useStageContext();

  const [records, setRecords] = useState<RecordItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [showUploadModal, setShowUploadModal] = useState<boolean>(false);
  const [recordToEdit, setRecordToEdit] = useState<RecordItem | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);

  const isStaff = canManage(user, 'manageRecords');
  const targetStageId = lecture.stageId || effectiveStageId;

  // Real-time synchronization with Firestore records collection
  useEffect(() => {
    if (!targetStageId) {
      setRecords([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    const q = query(
      collection(db, 'records'),
      where('stageId', '==', targetStageId),
      orderBy('createdAt', 'desc')
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const loaded = snapshot.docs.map(
          (d) =>
            ({
              id: d.id,
              ...d.data({ serverTimestamps: 'estimate' }),
            } as RecordItem)
        );
        setRecords(loaded);
        setIsLoading(false);
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, 'records');
        setIsLoading(false);
      }
    );

    return () => unsubscribe();
  }, [targetStageId]);

  // Filter records belonging strictly to this lecture
  const lectureRecords = useMemo(() => {
    return records
      .filter((rec) => recordBelongsToLecture(rec, lecture, effectiveStageId))
      .sort((a, b) => {
        const numA = a.number != null ? Number(a.number) : 0;
        const numB = b.number != null ? Number(b.number) : 0;
        if (numA !== numB) return numA - numB;
        const timeA = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
        const timeB = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
        return timeB - timeA;
      });
  }, [records, lecture, effectiveStageId]);

  // Delete handler
  const handleDeleteRecord = async (recordId: string) => {
    setIsDeleting(true);
    try {
      await deleteDoc(doc(db, 'records', recordId));
      setDeletingId(null);
    } catch (err) {
      console.error('Failed to delete recording:', err);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="pt-4 mt-2 border-t border-slate-100 dark:border-zinc-800 space-y-3.5">
      {/* Subsection Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="p-2 rounded-xl bg-sky-50 dark:bg-sky-950/40 text-sky-600 dark:text-sky-400 border border-sky-100 dark:border-sky-900/40 shadow-xs">
            <Radio className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h4 className="text-xs sm:text-sm font-bold text-slate-900 dark:text-stone-100">
                {isRtl ? 'تسجيلات المحاضرة الصوتية' : 'Lecture Audio Recordings'}
              </h4>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300">
                {lectureRecords.length}
              </span>
            </div>
            <p className="text-[10px] text-slate-400 dark:text-slate-500">
              {isRtl
                ? 'استمع للتسجيل الصوتي للشرح مع التحكم الكامل في السرعة والتشغيل'
                : 'Listen to explanations with full speed and playback controls'}
            </p>
          </div>
        </div>

        {isStaff && (
          <button
            type="button"
            onClick={() => {
              setRecordToEdit(null);
              setShowUploadModal(true);
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-sky-500 hover:bg-sky-600 active:scale-95 text-white text-xs font-bold transition-all shadow-xs cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{isRtl ? 'إضافة تسجيل' : 'Add Recording'}</span>
          </button>
        )}
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="space-y-2 py-1">
          {[1, 2].map((k) => (
            <div
              key={k}
              className="h-24 rounded-2xl bg-slate-100 dark:bg-zinc-800 animate-pulse"
            />
          ))}
        </div>
      )}

      {/* Recordings List */}
      {!isLoading && lectureRecords.length > 0 && (
        <div className="space-y-3">
          <AnimatePresence>
            {lectureRecords.map((record) => {
              const isHighlighted = highlightedRecordId === record.id;
              return (
                <motion.div
                  key={record.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className={`bg-white dark:bg-zinc-900/90 rounded-2xl p-3.5 sm:p-4 border transition-all shadow-xs space-y-3 ${
                    isHighlighted
                      ? 'border-sky-400 dark:border-sky-500 ring-2 ring-sky-300/60 dark:ring-sky-500/30'
                      : 'border-slate-200/90 dark:border-zinc-800 hover:border-slate-300 dark:hover:border-zinc-700'
                  }`}
                >
                  {/* Record Metadata & Admin Actions */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h5 className="text-xs sm:text-sm font-bold text-slate-900 dark:text-stone-100 truncate">
                          {record.title}
                        </h5>

                        {record.type && (
                          <span
                            className={`px-2 py-0.5 rounded-md text-[10px] font-bold ${
                              record.type === 'theoretical'
                                ? 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 border border-indigo-100 dark:border-indigo-900/40'
                                : 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 border border-emerald-100 dark:border-emerald-900/40'
                            }`}
                          >
                            {isRtl
                              ? record.type === 'theoretical'
                                ? 'نظري'
                                : 'عملي'
                              : record.type}
                          </span>
                        )}

                        {record.number != null && (
                          <span className="text-[10px] font-semibold text-slate-400">
                            {isRtl ? `محاضرة ${record.number}` : `Lec ${record.number}`}
                          </span>
                        )}
                      </div>

                      {record.description && (
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-2">
                          {record.description}
                        </p>
                      )}

                      <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-400 dark:text-slate-500 pt-0.5">
                        {record.createdAt?.toDate && (
                          <div className="flex items-center gap-1 bg-slate-50 dark:bg-zinc-800 px-2 py-0.5 rounded-md">
                            <Clock className="w-3 h-3" />
                            <span>
                              {record.createdAt.toDate().toLocaleDateString(
                                lang === 'ar' ? 'ar-EG' : 'en-US'
                              )}
                            </span>
                          </div>
                        )}

                        {record.size && (
                          <div className="flex items-center gap-1 bg-slate-50 dark:bg-zinc-800 px-2 py-0.5 rounded-md">
                            <HardDrive className="w-3 h-3" />
                            <span>{record.size} MB</span>
                          </div>
                        )}

                        {record.uploaderName && (
                          <div className="flex items-center gap-1 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-600 dark:text-emerald-400 px-2 py-0.5 rounded-md">
                            <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                            <span>{record.uploaderName}</span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Admin Actions */}
                    {isStaff && (
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            setRecordToEdit(record);
                            setShowUploadModal(true);
                          }}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-sky-600 hover:bg-sky-50 dark:hover:bg-sky-950/40 transition-colors"
                          title={isRtl ? 'تعديل التسجيل' : 'Edit Recording'}
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>

                        {deletingId === record.id ? (
                          <div className="flex items-center gap-1 bg-slate-100 dark:bg-zinc-800 p-1 rounded-lg">
                            <button
                              type="button"
                              onClick={() => handleDeleteRecord(record.id)}
                              disabled={isDeleting}
                              className="px-2 py-0.5 text-[10px] font-bold bg-rose-600 text-white hover:bg-rose-700 rounded-md transition-colors"
                            >
                              {isDeleting ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : isRtl ? (
                                'تأكيد'
                              ) : (
                                'Confirm'
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeletingId(null)}
                              disabled={isDeleting}
                              className="px-2 py-0.5 text-[10px] font-bold text-slate-500 hover:bg-slate-200 dark:hover:bg-zinc-700 rounded-md transition-colors"
                            >
                              {isRtl ? 'إلغاء' : 'Cancel'}
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setDeletingId(record.id)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors"
                            title={isRtl ? 'حذف التسجيل' : 'Delete Recording'}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Inline Audio Player (100% controls preserved) */}
                  <div className="pt-2 border-t border-slate-100 dark:border-zinc-800">
                    <AudioPlayer
                      id={record.id}
                      src={record.audioUrl}
                      title={record.title}
                    />
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}

      {/* Empty State */}
      {!isLoading && lectureRecords.length === 0 && (
        <div className="p-4 sm:p-5 text-center bg-slate-50 dark:bg-zinc-800/40 rounded-2xl border border-dashed border-slate-200 dark:border-zinc-700/80">
          <div className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-zinc-800 text-slate-400 mx-auto flex items-center justify-center mb-2">
            <FileAudio className="w-5 h-5 text-slate-400" />
          </div>
          <p className="text-xs font-bold text-slate-700 dark:text-stone-300 mb-0.5">
            {isRtl
              ? 'لا توجد تسجيلات صوتية لهذه المحاضرة بعد'
              : 'No audio recordings for this lecture yet'}
          </p>
          <p className="text-[11px] text-slate-400 mb-2.5 max-w-sm mx-auto">
            {isRtl
              ? 'عند توفر تسجيل صوتي لشرح هذه المحاضرة سيظهر هنا مباشرة مع المشغل الصوتي'
              : 'Lecture audio recordings will appear here with the inline audio player once uploaded'}
          </p>
          {isStaff && (
            <button
              type="button"
              onClick={() => {
                setRecordToEdit(null);
                setShowUploadModal(true);
              }}
              className="px-3.5 py-1.5 rounded-xl bg-sky-500 hover:bg-sky-600 active:scale-95 text-white text-xs font-bold transition-all shadow-xs cursor-pointer"
            >
              {isRtl ? 'إضافة تسجيل لهذه المحاضرة' : 'Add Recording for this Lecture'}
            </button>
          )}
        </div>
      )}

      {/* Admin Record Upload / Edit Modal */}
      {showUploadModal && (
        <AdminRecordUpload
          isOpen={showUploadModal}
          onClose={() => {
            setShowUploadModal(false);
            setRecordToEdit(null);
          }}
          lang={lang}
          recordToEdit={recordToEdit}
          user={user}
        />
      )}
    </div>
  );
}
