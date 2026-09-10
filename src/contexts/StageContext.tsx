import React, { createContext, useContext, useState, useEffect, useMemo, useRef, ReactNode } from 'react';
import {
  Stage, UserProfile, StageGroupConfig, DEFAULT_GROUP_CONFIG,
  CourseId, COURSE_IDS, DEFAULT_COURSE_ID,
} from '../types';
import { db } from '../lib/firebase';
import { collection, getDocs, orderBy, query, setDoc, doc, updateDoc } from 'firebase/firestore';

// Canonical stage list. Kept in sync with scripts/migrateToStages.js so that
// seeding from either side produces identical documents.
export const DEFAULT_STAGES: Stage[] = [
  { id: 'stage_1', nameEn: 'First Stage', nameAr: 'المرحلة الأولى', order: 1 },
  { id: 'stage_2', nameEn: 'Second Stage', nameAr: 'المرحلة الثانية', order: 2 },
  { id: 'stage_3', nameEn: 'Third Stage', nameAr: 'المرحلة الثالثة', order: 3 },
  { id: 'stage_4', nameEn: 'Fourth Stage', nameAr: 'المرحلة الرابعة', order: 4 },
  { id: 'stage_5', nameEn: 'Fifth Stage', nameAr: 'المرحلة الخامسة', order: 5 },
];

/**
 * Why a stage load did not produce the server's list.
 *
 * `denied`  - the read was refused. On the login screen that is expected:
 *             StageProvider wraps <App/> at the root (src/main.tsx) and mounts
 *             before anyone is signed in, while firestore.rules gates `stages`
 *             behind isAuthenticated().
 * `offline` - resolved from an empty cache. A COLLECTION query does not reject
 *             offline the way a document get does, so this is NOT evidence that
 *             the collection is empty on the server.
 * `empty`   - the server really did return nothing, and we may not seed it.
 *
 * `stages` falls back to DEFAULT_STAGES in all three cases so the picker is
 * never blank; this is the only thing that tells a fallback from a real read.
 * Never seed, and never conclude "this stage does not exist", while it is set.
 */
export type StagesError = 'denied' | 'offline' | 'empty' | null;

interface StageContextType {
  stages: Stage[];
  /** The stage selected in the master-admin picker. Admin UI concern only. */
  currentAppStage: string | null;
  setCurrentAppStage: (stageId: string | null) => void;
  /**
   * The stage the signed-in user should actually see data for.
   * Master admin, support -> whatever the picker says.
   * Representative, moderator -> the stage they manage.
   * Everyone else -> their own stage.
   * Every stage-scoped query should filter on this, never on currentAppStage.
   */
  effectiveStageId: string | null;
  /** Called by App once the user profile is known, so the provider can resolve effectiveStageId. */
  setActiveUser: (user: UserProfile | null) => void;
  /** Group/subgroup structure of the effective stage. Never null - falls back to
   *  DEFAULT_GROUP_CONFIG so stages that were never configured behave as before. */
  groupConfig: StageGroupConfig;
  /** Persists a new group config onto the effective stage. */
  saveGroupConfig: (config: StageGroupConfig) => Promise<void>;
  /**
   * Which of the stage's two courses the user is currently browsing.
   * Shared rather than component-local so Subjects and Records agree - a control
   * in only one of them would strand the other course's content.
   */
  activeCourseId: CourseId;
  setActiveCourseId: (courseId: CourseId) => void;
  isLoadingStages: boolean;
  /** Why `stages` is a local fallback rather than the server's list, or null
   *  when it is the real thing. See StagesError. */
  stagesError: StagesError;
}

const StageContext = createContext<StageContextType | undefined>(undefined);

export function StageProvider({ children }: { children: ReactNode }) {
  const [stages, setStages] = useState<Stage[]>([]);
  const [activeUser, setActiveUser] = useState<UserProfile | null>(null);
  const [currentAppStage, setCurrentAppStage] = useState<string | null>(() => {
    return localStorage.getItem('selectedAdminStage') || null;
  });
  const [isLoadingStages, setIsLoadingStages] = useState(true);
  const [stagesError, setStagesError] = useState<StagesError>(null);
  /** True only once a real SERVER read has produced the list. A fallback never
   *  sets it, so signing in still triggers the retry below. */
  const loadedRef = useRef(false);

  // Re-runs when a user appears, NOT once on mount.
  //
  // StageProvider wraps <App/> at the root (src/main.tsx), so the first attempt
  // happens on the login screen, where firestore.rules refuses `stages`. That
  // rejection used to be swallowed into a console.error inside an effect with
  // `[]` dependencies, so nothing ever refetched: `stages` stayed [] for the
  // whole session and every downstream stages.find(...) returned undefined -
  // the master admin's viewing-stage picker rendered zero buttons and the
  // profile stage tile read '—'. A hard refresh while already signed in
  // happened to work, which is why it looked intermittent.
  //
  // App.tsx pushes the profile in through setActiveUser, so its uid is the
  // signal that the read can now succeed. loadedRef keeps a later profile
  // snapshot from refetching a list that has already arrived.
  const activeUid = activeUser?.uid ?? null;

  useEffect(() => {
    if (loadedRef.current) return;
    let cancelled = false;

    /**
     * Adopts a stage list and reconciles the picker against it.
     *
     * currentAppStage comes from localStorage, which the client controls: a
     * stale id that matches no stage produces exactly the same '—' as an empty
     * list, so it is validated here rather than trusted.
     */
    const applyStageList = (list: Stage[]) => {
      setStages(list);
      setCurrentAppStage(prev => {
        if (prev && list.some(st => st.id === prev)) return prev;
        // Nothing stored yet. A support account promoted from a representative
        // opens on the stage it used to represent - a home stage, not a limit -
        // rather than being dropped on stage_3 with no idea why.
        const home = activeUser?.role === 'support' ? activeUser.managedStageId : null;
        if (home && list.some(st => st.id === home)) return home;
        return list.find(st => st.id === 'stage_3')?.id || list[0]?.id || null;
      });
    };

    const fetchStages = async () => {
      try {
        const stagesRef = collection(db, 'stages');
        const q = query(stagesRef, orderBy('order', 'asc'));
        const snapshot = await getDocs(q);
        if (cancelled) return;

        if (!snapshot.empty) {
          loadedRef.current = true;
          setStagesError(null);
          applyStageList(snapshot.docs.map(d => d.data() as Stage));
          return;
        }

        // A COLLECTION query does not reject offline the way a document get
        // does - it resolves EMPTY from cache. So `snapshot.empty` alone is not
        // evidence that the collection is empty on the server, and acting on it
        // offline seeded DEFAULT_STAGES over five real documents, `groupConfig`
        // included.
        //
        // It also hung: `await setDoc` does not settle until the server acks, so
        // the loop stalled on stage_1 and `isLoadingStages` never cleared. That
        // used to be self-limiting because the mutation queue died with the tab;
        // now that firebase.ts enables a persistent cache the queue SURVIVES and
        // flushes on reconnect, so this guard is what stops it destroying data.
        if (snapshot.metadata.fromCache) {
          console.warn('Stages unavailable offline; using defaults locally without seeding.');
          setStagesError('offline');
          applyStageList(DEFAULT_STAGES);
          return;
        }

        // Genuinely empty on the server. Only a master admin may seed it -
        // firestore.rules restricts `stages` writes to isMasterAdmin(), so
        // letting anyone else try just throws a second time behind the first.
        if (activeUser?.isMasterAdmin) {
          console.log('No stages found. Seeding default stages...');
          await Promise.all(
            DEFAULT_STAGES.map(st => setDoc(doc(db, 'stages', st.id), st).catch(err => {
              console.error(`Failed to seed stage ${st.id}:`, err);
            })),
          );
          if (cancelled) return;
          loadedRef.current = true;
          setStagesError(null);
          applyStageList(DEFAULT_STAGES);
          return;
        }

        setStagesError('empty');
        applyStageList(DEFAULT_STAGES);
      } catch (error) {
        if (cancelled) return;
        // Do NOT let this look like "there are no stages". loadedRef stays
        // false, so signing in retries; the fallback list is for display only
        // and is never written anywhere.
        console.error('Failed to fetch stages:', error);
        setStagesError('denied');
        applyStageList(DEFAULT_STAGES);
      } finally {
        // Cleared even on failure. StageSettings renders a spinner while this
        // is true, and holding it forever would trade a blank picker for a
        // permanent one; stagesError is what records that the list is a
        // fallback.
        if (!cancelled) setIsLoadingStages(false);
      }
    };

    fetchStages();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeUid]);

  const handleSetCurrentStage = (stageId: string | null) => {
    setCurrentAppStage(stageId);
    if (stageId) {
      localStorage.setItem('selectedAdminStage', stageId);
    } else {
      localStorage.removeItem('selectedAdminStage');
    }
  };

  const effectiveStageId = useMemo(() => {
    if (!activeUser) return null;
    // Master admin drives the whole app from Settings -> Administration ->
    // Viewing stage (StageSettings). A support account is cross-stage and gets
    // the same picker.
    //
    // ORDER IS LOAD-BEARING. Support has to be answered HERE, before the
    // admin/moderator arm below, because a support account promoted from a
    // representative still carries managedStageId. Falling through would return
    // that id and pin them to the single stage they used to represent, which is
    // precisely the reach the role exists to remove - and it would look like the
    // role simply does not work rather than like a bug in this file.
    if (activeUser.isMasterAdmin || activeUser.role === 'support') return currentAppStage;
    // A representative, and any moderator they appointed, is locked to the stage
    // they manage. Staff with NO assignment resolve to null and see nothing.
    //
    // This used to fall back to currentAppStage so the admin tools were not
    // empty, but currentAppStage is localStorage the client controls, so an
    // unassigned representative silently operated on - and uploaded into -
    // whichever stage the picker happened to hold. firestore.rules refuses their
    // writes anyway once managedStageId is required, so an empty screen is the
    // honest reflection of what they may do. Run
    // scripts/assignStageRepresentatives.mjs to pin every staff account.
    if (activeUser.role === 'admin' || activeUser.role === 'moderator') {
      return activeUser.managedStageId || null;
    }
    // Students only ever see their own stage.
    return activeUser.stageId || null;
  }, [activeUser, currentAppStage]);

  const groupConfig = useMemo<StageGroupConfig>(() => {
    const stage = stages.find(s => s.id === effectiveStageId);
    const groups = stage?.groupConfig?.groups;
    if (!groups || groups.length === 0) return DEFAULT_GROUP_CONFIG;
    return { groups };
  }, [stages, effectiveStageId]);

  const saveGroupConfig = async (config: StageGroupConfig) => {
    if (!effectiveStageId) throw new Error('No stage selected');
    await updateDoc(doc(db, 'stages', effectiveStageId), { groupConfig: config });
    // Keep the local copy in step so the UI updates without a refetch.
    setStages(prev => prev.map(s => (s.id === effectiveStageId ? { ...s, groupConfig: config } : s)));
  };

  // Remembered per stage, so switching stage and back keeps your place.
  const [activeCourseId, setActiveCourseIdState] = useState<CourseId>(DEFAULT_COURSE_ID);

  useEffect(() => {
    if (!effectiveStageId) return;
    const saved = localStorage.getItem(`activeCourse:${effectiveStageId}`);
    setActiveCourseIdState(
      (COURSE_IDS as readonly string[]).includes(saved || '') ? (saved as CourseId) : DEFAULT_COURSE_ID
    );
  }, [effectiveStageId]);

  const setActiveCourseId = (courseId: CourseId) => {
    setActiveCourseIdState(courseId);
    if (effectiveStageId) {
      localStorage.setItem(`activeCourse:${effectiveStageId}`, courseId);
    }
  };

  return (
    <StageContext.Provider value={{
      stages,
      currentAppStage,
      setCurrentAppStage: handleSetCurrentStage,
      effectiveStageId,
      setActiveUser,
      groupConfig,
      saveGroupConfig,
      activeCourseId,
      setActiveCourseId,
      isLoadingStages,
      stagesError,
    }}>
      {children}
    </StageContext.Provider>
  );
}

export function useStageContext() {
  const context = useContext(StageContext);
  if (context === undefined) {
    throw new Error('useStageContext must be used within a StageProvider');
  }
  return context;
}
