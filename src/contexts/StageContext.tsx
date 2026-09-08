import React, { createContext, useContext, useState, useEffect, useMemo, ReactNode } from 'react';
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

interface StageContextType {
  stages: Stage[];
  /** The stage selected in the master-admin picker. Admin UI concern only. */
  currentAppStage: string | null;
  setCurrentAppStage: (stageId: string | null) => void;
  /**
   * The stage the signed-in user should actually see data for.
   * Master admin -> whatever the picker says.
   * Representative -> the stage they manage.
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
}

const StageContext = createContext<StageContextType | undefined>(undefined);

export function StageProvider({ children }: { children: ReactNode }) {
  const [stages, setStages] = useState<Stage[]>([]);
  const [activeUser, setActiveUser] = useState<UserProfile | null>(null);
  const [currentAppStage, setCurrentAppStage] = useState<string | null>(() => {
    return localStorage.getItem('selectedAdminStage') || null;
  });
  const [isLoadingStages, setIsLoadingStages] = useState(true);

  useEffect(() => {
    const fetchStages = async () => {
      try {
        const stagesRef = collection(db, 'stages');
        const q = query(stagesRef, orderBy('order', 'asc'));
        const snapshot = await getDocs(q);

        // A COLLECTION query does not reject offline the way a document get does -
        // it resolves EMPTY from cache. So `snapshot.empty` alone is not evidence
        // that the collection is empty on the server, and acting on it offline
        // seeded DEFAULT_STAGES over five real documents, `groupConfig` included.
        //
        // It also hung: `await setDoc` does not settle until the server acks, so
        // the loop stalled on stage_1 and `isLoadingStages` never cleared. That
        // used to be self-limiting because the mutation queue died with the tab;
        // now that firebase.ts enables a persistent cache the queue SURVIVES and
        // flushes on reconnect, so this guard is what stops it destroying data.
        if (snapshot.empty && !snapshot.metadata.fromCache) {
          console.log("No stages found. Seeding default stages...");
          // Not awaited: setDoc resolves on server ack, and blocking the boot on
          // it is what stalled this loop. The writes still land.
          await Promise.all(
            DEFAULT_STAGES.map(s => setDoc(doc(db, 'stages', s.id), s).catch(err => {
              console.error(`Failed to seed stage ${s.id}:`, err);
            })),
          );

          setStages(DEFAULT_STAGES);
          if (!currentAppStage) {
            setCurrentAppStage('stage_3');
          }
        } else if (snapshot.empty) {
          // Offline with nothing cached. Render the known stage shape so the app
          // is navigable, but write NOTHING.
          console.warn('Stages unavailable offline; using defaults locally without seeding.');
          setStages(DEFAULT_STAGES);
          if (!currentAppStage) {
            setCurrentAppStage('stage_3');
          }
        } else {
          const stagesData = snapshot.docs.map(doc => doc.data() as Stage);
          setStages(stagesData);
          if (!currentAppStage && stagesData.length > 0) {
            setCurrentAppStage(stagesData[2]?.id || stagesData[0].id); // default to stage 3 or first
          }
        }
      } catch (error) {
        console.error("Failed to fetch stages:", error);
      } finally {
        setIsLoadingStages(false);
      }
    };
    fetchStages();
  }, []);

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
    // Viewing stage (StageSettings).
    if (activeUser.isMasterAdmin) return currentAppStage;
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
