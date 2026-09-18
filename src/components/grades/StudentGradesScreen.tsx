import React, { useState, useEffect, useMemo } from 'react';
import { Award, Target, Trophy, Clock, Search, X } from 'lucide-react';
import { collection, query, onSnapshot, orderBy } from 'firebase/firestore';
import { db, auth, handleFirestoreError, OperationType } from '../../lib/firebase';
import { StudentDegree } from '../../types/grades.types';
import { Stage } from '../../types';
import { motion, AnimatePresence } from 'motion/react';
import { useStageContext } from '../../contexts/StageContext';
import { useStageSubjects } from '../../hooks/useStageSubjects';
import { resolveSubjectLabel, subjectSlugOf, canonicalSubjectSlug } from '../../lib/subjectDisplay';

/**
 * Year bucket for a degree written before yearLabel existed. Sorts last, and is
 * labelled rather than hidden - an unstamped degree is still a real result.
 */
const NO_YEAR = '';

export interface StudentGradesScreenProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function StudentGradesScreen({ isOpen, onClose }: StudentGradesScreenProps) {
  const [degrees, setDegrees] = useState<StudentDegree[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const { stages, effectiveStageId } = useStageContext();
  // Tier 2 only, and only for the CURRENT stage - which is why every degree
  // carries its own materialNameAr. These tabs span every stage the student has
  // been promoted through, and this list knows about exactly one of them.
  const { subjects } = useStageSubjects();

  useEffect(() => {
    if (!isOpen) return;
    const user = auth.currentUser;
    if (!user) return;

    const q = query(
      collection(db, `degrees/${user.uid}/exams`), 
      orderBy('createdAt', 'desc')
    );

    const unsub = onSnapshot(q, (snap) => {
      setDegrees(snap.docs.map(d => ({ ...d.data(), id: d.id } as StudentDegree)));
      setLoading(false);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, `degrees/${user.uid}/exams`);
      setLoading(false);
    });

    return () => unsub();
  }, [isOpen]);

  /**
   * One tab per stage the student has reached - the ladder up to and including
   * their current stage - so a promoted student keeps last year alongside this
   * year instead of watching it turn into an undifferentiated "archive".
   *
   * A stage that actually holds degrees is always given a tab even when it is
   * not on that ladder. That costs one Set and is what stops a degree becoming
   * invisible if a stageId is ever reassigned downward.
   */
  const stageTabs = useMemo(() => {
    const shown = new Map<string, Stage>();
    const current = stages.find(s => s.id === effectiveStageId);
    if (current) {
      for (const s of stages) if (s.order <= current.order) shown.set(s.id, s);
    }
    for (const d of degrees) {
      if (!d.stageId || shown.has(d.stageId)) continue;
      const s = stages.find(x => x.id === d.stageId);
      if (s) shown.set(s.id, s);
    }
    return Array.from(shown.values()).sort((a, b) => a.order - b.order);
  }, [stages, effectiveStageId, degrees]);

  const tabbedStageIds = useMemo(() => new Set(stageTabs.map(s => s.id)), [stageTabs]);
  const earliestTabId = stageTabs[0]?.id ?? null;

  /**
   * A degree with no stageId, or naming a stage with no tab, files under the
   * earliest tab rather than vanishing. Legacy degrees are older by definition,
   * so that is the least wrong home for them - but the real fix is
   * scripts/backfillDegreeYears.ts, after which there should be none.
   */
  const tabIdFor = (d: StudentDegree) =>
    d.stageId && tabbedStageIds.has(d.stageId) ? d.stageId : earliestTabId;

  /**
   * Which tab opens before the student picks one.
   *
   * Their current stage, because that is where new results land - but only once
   * it has any. A student promoted in the summer has an empty current stage
   * until the first upload of the new year, and opening on "no grades yet" hides
   * the year they just finished behind a tab they have no reason to press. So
   * fall back to the newest stage that actually has results.
   */
  const defaultStageId = (() => {
    const withDegrees = new Set(degrees.map(tabIdFor).filter(Boolean) as string[]);
    const current = stageTabs.find(s => s.id === effectiveStageId);
    if (current && withDegrees.has(current.id)) return current.id;
    for (let i = stageTabs.length - 1; i >= 0; i--) {
      if (withDegrees.has(stageTabs[i].id)) return stageTabs[i].id;
    }
    // Nothing anywhere: sit on their own stage, or the newest tab if it is unset.
    return current?.id ?? stageTabs[stageTabs.length - 1]?.id ?? null;
  })();

  // Null only when there are no stages at all, which shows every degree rather
  // than an empty screen.
  const activeStageId =
    selectedStageId && stageTabs.some(s => s.id === selectedStageId)
      ? selectedStageId
      : defaultStageId;

  const activeStage = stageTabs.find(s => s.id === activeStageId) || null;

  const filteredDegrees = degrees.filter(d => {
    const matchesSearch = d.examName.toLowerCase().includes(search.toLowerCase());
    const matchesStage = activeStageId === null || tabIdFor(d) === activeStageId;
    return matchesSearch && matchesStage;
  });

  /**
   * Degrees in the open tab, split by academic year, newest first. A stage the
   * student repeated is the reason this exists: without it both years land in
   * one list with nothing to tell them apart.
   */
  const yearGroups: [string, StudentDegree[]][] = (() => {
    const byYear = new Map<string, StudentDegree[]>();
    for (const d of filteredDegrees) {
      const y = d.yearLabel || NO_YEAR;
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y)!.push(d);
    }
    return Array.from(byYear.entries()).sort(([a], [b]) => {
      if (a === NO_YEAR) return 1;
      if (b === NO_YEAR) return -1;
      return b.localeCompare(a);
    });
  })();

  /**
   * Sections for one year, keyed on the CANONICAL slug so a subject uploaded
   * under its legacy name last year and its curriculum name this year is one
   * section rather than two.
   */
  const groupByMaterial = (list: StudentDegree[]) => {
    const groups = new Map<string, StudentDegree[]>();
    for (const degree of list) {
      const key = canonicalSubjectSlug(subjectSlugOf(degree)) || 'other';
      const bucket = groups.get(key);
      if (bucket) bucket.push(degree);
      else groups.set(key, [degree]);
    }
    return Array.from(groups.entries()).map(([key, degrees]) => ({
      key,
      label: materialName(key, degrees),
      degrees,
    }));
  };

  /**
   * The heading for a section.
   *
   * Reads the DEGREES, not just the key: the name is denormalized onto each
   * document, which is the only tier that can name a subject from a stage this
   * student has already been promoted out of. Scans for the first row that
   * resolves to something better than its own slug, so a group mixing legacy
   * rows with newer ones still gets the real name.
   */
  const materialName = (key: string, degrees: StudentDegree[] = []) => {
    if (key === 'other') return 'أخرى';
    for (const degree of degrees) {
      const label = resolveSubjectLabel(degree as any, subjects, 'ar');
      if (label && label !== subjectSlugOf(degree)) return label;
    }
    return key;
  };

  const renderDegreeCard = (degree: StudentDegree) => {
    let passRateColor = 'bg-gray-200';
    let passRateTextColor = 'text-gray-500';
    
    const degNum = Number(degree.degree);
    const maxDegNum = Number(degree.maxDegree);
    
    const hasPassRate = typeof degree.passRate === 'number' && !isNaN(degree.passRate);
    const passRate = hasPassRate ? degree.passRate! : null;

    if (passRate !== null) {
      if (passRate >= 85) {
        passRateColor = 'bg-emerald-500';
        passRateTextColor = 'text-emerald-600 dark:text-emerald-400';
      } else if (passRate >= 65) {
        passRateColor = 'bg-sky-500';
        passRateTextColor = 'text-sky-600 dark:text-sky-400';
      } else if (passRate >= 50) {
        passRateColor = 'bg-amber-500';
        passRateTextColor = 'text-amber-600 dark:text-amber-400';
      } else {
        passRateColor = 'bg-red-500';
        passRateTextColor = 'text-red-600 dark:text-red-400';
      }
    }

    return (
      <div key={degree.id} className="shrink-0 w-[280px] sm:w-[320px] bg-white dark:bg-zinc-900 border border-gray-100 dark:border-zinc-800 rounded-2xl p-5 shadow-sm hover:shadow-md transition-shadow relative overflow-hidden group snap-start">
        <div className="absolute top-0 right-0 w-2 h-full bg-emerald-500 opacity-0 group-hover:opacity-100 transition-opacity"></div>
        
        <div className="flex items-start justify-between mb-4">
          <div className="w-10 h-10 bg-emerald-50 dark:bg-emerald-900/20 rounded-xl flex items-center justify-center">
            <Award className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
          </div>
          {degree.createdAt && (
            <div className="flex items-center gap-1 text-xs font-medium text-gray-400 dark:text-zinc-500">
              <Clock className="w-3 h-3" />
              {new Date((degree.createdAt as any)?.toDate ? (degree.createdAt as any).toDate() : degree.createdAt).toLocaleDateString('ar-EG')}
            </div>
          )}
        </div>
        
        <h3 className="font-bold text-gray-900 dark:text-white mb-1 line-clamp-1">{degree.examName}</h3>
        <p className="text-sm text-gray-500 dark:text-zinc-400 mb-4">النتيجة المعتمدة</p>
        
        <div className="bg-gray-50 dark:bg-zinc-800/50 rounded-xl p-4 flex flex-col gap-3 border border-gray-100 dark:border-zinc-700/50">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-600 dark:text-zinc-400 flex items-center gap-2">
              <Target className="w-4 h-4 text-emerald-500 dark:text-emerald-400" /> الدرجة:
            </span>
            <div className="flex items-baseline gap-1" dir="auto">
              <span className={`font-black ${!isNaN(degNum) && degree.degree !== '' ? 'font-mono text-xl text-gray-900 dark:text-white' : 'font-sans text-sm sm:text-base text-red-500 dark:text-red-400'}`}>
                {!isNaN(degNum) && degree.degree !== '' ? parseFloat(degNum.toFixed(4)) : degree.degree}
              </span>
              {!isNaN(degNum) && degree.degree !== '' && degree.maxDegree && (
                <span className="text-sm text-gray-400 dark:text-zinc-500 font-medium font-mono ml-1" dir="ltr">/ {!isNaN(maxDegNum) && degree.maxDegree !== '' ? parseFloat(maxDegNum.toFixed(4)) : degree.maxDegree}</span>
              )}
            </div>
          </div>
          
          {passRate !== null && (
            <div className="mt-1 space-y-2">
              <div className="flex justify-between items-center text-xs font-bold">
                <span className="text-gray-500 dark:text-zinc-400">نسبة نجاح الطلاب بالامتحان:</span>
                <span className={passRateTextColor} dir="ltr">{passRate.toFixed(1)}%</span>
              </div>
              <div className="w-full bg-gray-200 dark:bg-zinc-700 h-2 rounded-full overflow-hidden" dir="ltr">
                <div 
                  className={`h-full ${passRateColor} transition-all duration-1000`} 
                  style={{ width: `${Math.min(100, Math.max(0, passRate))}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderMaterialSections = (list: StudentDegree[]) => (
    <div className="space-y-8">
      {groupByMaterial(list).map(({ key, label, degrees }) => (
        <div key={key}>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
            <div className="w-2 h-6 bg-emerald-500 rounded-full"></div>
            {label}
          </h2>
          <div className="flex flex-nowrap overflow-x-auto pb-4 gap-4 sm:gap-6 snap-x aesthetic-scrollbar scroll-smooth">
            {degrees.map(degree => renderDegreeCard(degree))}
          </div>
        </div>
      ))}
    </div>
  );

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
              <div className="mb-5 sm:mb-6 mt-2">
                <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-white mb-2">السعيّات والدرجات</h1>
                <p className="text-gray-500 dark:text-zinc-400">سجل بجميع الدرجات المعتمدة من الكلية، مرحلة بمرحلة.</p>
              </div>

              {stageTabs.length > 0 && (
                <div className="mb-6 flex gap-1 overflow-x-auto bg-gray-100 dark:bg-zinc-800 p-1 rounded-xl aesthetic-scrollbar">
                  {stageTabs.map(stage => (
                    <button
                      key={stage.id}
                      onClick={() => setSelectedStageId(stage.id)}
                      className={`shrink-0 px-4 py-2 rounded-lg text-sm font-bold transition-all whitespace-nowrap ${
                        activeStageId === stage.id
                          ? 'bg-white dark:bg-zinc-700 text-emerald-600 dark:text-emerald-400 shadow-sm'
                          : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                      }`}
                    >
                      {stage.nameAr}
                      {stage.id === effectiveStageId && (
                        <span className="mr-1.5 inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 align-middle" />
                      )}
                    </button>
                  ))}
                </div>
              )}

      <div className="mb-8 relative">
        <input 
          type="text"
          placeholder="ابحث عن اسم اختبار..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-800 rounded-2xl py-4 pr-12 pl-4 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 shadow-sm transition-all dark:text-white"
        />
        <Search className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
      </div>

      {loading ? (
        <div className="flex flex-nowrap overflow-x-auto pb-4 gap-4 aesthetic-scrollbar">
          {[1, 2, 3].map(i => (
            <div key={i} className="shrink-0 w-[280px] sm:w-[320px] animate-pulse bg-white dark:bg-zinc-900 h-40 rounded-2xl border border-gray-100 dark:border-zinc-800"></div>
          ))}
        </div>
      ) : filteredDegrees.length === 0 ? (
        <div className="text-center py-20 bg-white dark:bg-zinc-900 rounded-2xl border border-gray-100 dark:border-zinc-800 shadow-sm px-4">
          <Trophy className="w-16 h-16 text-emerald-100 dark:text-emerald-900/50 mx-auto mb-4" />
          {degrees.length > 0 && activeStage ? (
            <>
              <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-2">لا توجد درجات في {activeStage.nameAr}</h2>
              <p className="text-gray-500 dark:text-zinc-400">اختر مرحلة أخرى من الأعلى.</p>
            </>
          ) : (
            <>
              <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-2">لم يتم رصد درجات بعد</h2>
              <p className="text-gray-500 dark:text-zinc-400">ستظهر السعيّات والنتائج هنا بمجرد اعتمادها من الإدارة.</p>
            </>
          )}
        </div>
      ) : yearGroups.length === 1 ? (
        // A single year needs no heading to disambiguate: this is the normal case,
        // and it renders exactly as the screen did before years existed.
        renderMaterialSections(yearGroups[0][1])
      ) : (
        <div className="space-y-10">
          {yearGroups.map(([year, yearDegrees]) => (
            <div key={year || 'no-year'}>
              <div className="flex items-center gap-3 mb-5">
                <span className="px-3 py-1 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 text-sm font-bold font-mono" dir="ltr">
                  {year || 'بدون سنة'}
                </span>
                <div className="flex-1 h-px bg-gray-200 dark:bg-zinc-800" />
              </div>
              {renderMaterialSections(yearDegrees)}
            </div>
          ))}
        </div>
      )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
