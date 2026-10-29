import React, { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { ArrowLeft, ArrowRight, BookOpen, Loader2, Lock, SearchX } from 'lucide-react';
import { db } from '../lib/firebase';
import { Language, Lecture, Subject, UserProfile } from '../types';
import { hasLiveSubscription } from '../../shared/subscriptionAccess';
import LectureCard from './LectureCard';

interface TahmeelSubjectsViewProps {
  user: UserProfile;
  lang: Language;
  searchQuery: string;
  onOpenMCQ?: (lecture: Lecture) => void;
  onOpenReader?: (lecture: Lecture) => void;
  onShowPaywall?: () => void;
}

export default function TahmeelSubjectsView({
  user,
  lang,
  searchQuery,
  onOpenMCQ,
  onOpenReader,
  onShowPaywall,
}: TahmeelSubjectsViewProps) {
  const isRtl = lang === 'ar';
  const ids = useMemo(() => Array.from(new Set(user.tahmeelSubjects || [])).slice(0, 20), [user.tahmeelSubjects]);
  const sourceStageId = user.tahmeelStageId || '';
  const subscribed = hasLiveSubscription(user);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [lectures, setLectures] = useState<Lecture[]>([]);
  const [selectedSubject, setSelectedSubject] = useState<string | null>(null);
  const [loadingSubjects, setLoadingSubjects] = useState(true);
  const [loadingLectures, setLoadingLectures] = useState(false);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSelectedSubject(null);
    if (!sourceStageId || ids.length === 0) {
      setSubjects([]);
      setLoadingSubjects(false);
      return;
    }
    setLoadingSubjects(true);
    getDocs(query(collection(db, 'subjects'), where('stageId', '==', sourceStageId)))
      .then(snapshot => {
        if (cancelled) return;
        const selected = new Set(ids);
        setSubjects(snapshot.docs
          .map(doc => doc.data() as Subject)
          .filter(subject => subject.isActive !== false && selected.has(subject.id))
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)));
      })
      .catch(error => {
        console.error('Could not load carried subjects:', error);
        if (!cancelled) setLoadError(true);
      })
      .finally(() => { if (!cancelled) setLoadingSubjects(false); });
    return () => { cancelled = true; };
  }, [sourceStageId, ids.join('|')]);

  useEffect(() => {
    setLectures([]);
    setLoadError(false);
    if (!subscribed || !sourceStageId || ids.length === 0) return;
    setLoadingLectures(true);
    const carriedQuery = query(
      collection(db, 'lectures'),
      where('stageId', '==', sourceStageId),
      where('subjectId', 'in', ids),
      orderBy('createdAt', 'desc'),
    );
    return onSnapshot(carriedQuery, snapshot => {
      setLectures(snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data({ serverTimestamps: 'estimate' }) } as Lecture))
        .filter(lecture => !(lecture as any).archived));
      setLoadingLectures(false);
    }, error => {
      console.error('Could not load carried lectures:', error);
      setLoadError(true);
      setLoadingLectures(false);
    });
  }, [subscribed, sourceStageId, ids.join('|')]);

  const term = searchQuery.trim().toLocaleLowerCase(isRtl ? 'ar' : 'en');
  const visibleSubjects = subjects.filter(subject => {
    if (!term) return true;
    return `${subject.nameAr} ${subject.nameEn}`.toLocaleLowerCase(isRtl ? 'ar' : 'en').includes(term)
      || lectures.some(lecture => lecture.subjectId === subject.id
        && `${lecture.title} ${lecture.description || ''}`.toLocaleLowerCase(isRtl ? 'ar' : 'en').includes(term));
  });

  if (loadingSubjects) {
    return <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-sky-500" /></div>;
  }

  if (!sourceStageId) {
    return (
      <div className="py-16 text-center text-sm text-slate-500 dark:text-slate-400">
        {isRtl ? 'يجب تحديث بيانات مواد التحميل قبل عرضها.' : 'Carry-over data needs to be updated before it can be displayed.'}
      </div>
    );
  }

  if (selectedSubject) {
    const subject = subjects.find(item => item.id === selectedSubject);
    const selectedLectures = lectures.filter(lecture => lecture.subjectId === selectedSubject && (
      !term || `${lecture.title} ${lecture.description || ''}`.toLocaleLowerCase(isRtl ? 'ar' : 'en').includes(term)
    ));
    return (
      <div>
        <button
          type="button"
          onClick={() => setSelectedSubject(null)}
          className="mb-5 flex items-center gap-2 text-sm font-bold text-sky-600 dark:text-sky-400"
        >
          {isRtl ? <ArrowRight className="w-4 h-4" /> : <ArrowLeft className="w-4 h-4" />}
          {isRtl ? 'مواد التحميل' : 'Carry-over subjects'}
        </button>
        <h2 className="text-xl font-black text-slate-900 dark:text-white mb-5">{isRtl ? subject?.nameAr : subject?.nameEn}</h2>
        {loadingLectures ? (
          <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-sky-500" /></div>
        ) : selectedLectures.length === 0 ? (
          <div className="py-16 text-center rounded-3xl border border-dashed border-slate-200 dark:border-zinc-700">
            <BookOpen className="w-10 h-10 mx-auto mb-3 text-slate-300 dark:text-zinc-600" />
            <p className="text-sm text-slate-500 dark:text-slate-400">{isRtl ? 'لا توجد محاضرات في هذه المادة بعد.' : 'No lectures have been added to this subject yet.'}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4">
            {selectedLectures.map(lecture => (
              <LectureCard key={lecture.id} lecture={lecture} lang={lang} user={user}
                onOpenMCQ={onOpenMCQ} onOpenReader={onOpenReader} onShowPaywall={onShowPaywall} />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (visibleSubjects.length === 0) {
    return (
      <div className="py-16 text-center">
        <SearchX className="w-10 h-10 mx-auto mb-3 text-slate-300 dark:text-zinc-600" />
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {loadError ? (isRtl ? 'تعذّر تحميل مواد التحميل.' : 'Could not load carry-over subjects.') : (isRtl ? 'لا توجد نتائج.' : 'No results.')}
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4">
      {visibleSubjects.map(subject => {
        const count = lectures.filter(lecture => lecture.subjectId === subject.id).length;
        return (
          <button
            key={subject.id}
            type="button"
            onClick={() => subscribed ? setSelectedSubject(subject.id) : onShowPaywall?.()}
            className="flex items-center justify-between gap-4 p-5 text-start bg-white dark:bg-zinc-800 rounded-2xl shadow-sm border border-amber-100 dark:border-amber-900/30"
          >
            <div className="flex items-center gap-4 min-w-0">
              <div className="p-3 rounded-xl bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400">
                {subscribed ? <BookOpen className="w-6 h-6" /> : <Lock className="w-6 h-6" />}
              </div>
              <div className="min-w-0">
                <h3 className="font-bold text-slate-900 dark:text-white truncate">{isRtl ? subject.nameAr : subject.nameEn}</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  {subscribed
                    ? `${count} ${isRtl ? 'محاضرة' : 'lectures'}`
                    : (isRtl ? 'متاحة ضمن الاشتراك' : 'Available with subscription')}
                </p>
              </div>
            </div>
            {!subscribed && <Lock className="w-4 h-4 shrink-0 text-amber-500" />}
          </button>
        );
      })}
    </div>
  );
}
