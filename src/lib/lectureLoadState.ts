export type LectureLoadState = 'loading' | 'ready' | 'error' | 'waiting-auth' | 'missing-stage';

export interface LectureLoadDecision {
  state: LectureLoadState;
  shouldSubscribe: boolean;
  scope: string | null;
}

/**
 * Keeps cache hydration separate from a permission-denied Firestore query.
 * A restored Firebase UID changes this decision even when the profile's group
 * and stage remain unchanged, which is the iOS recovery case.
 */
export function resolveLectureLoadDecision(input: {
  profileUid?: string | null;
  authenticatedUid?: string | null;
  isAuthReady: boolean;
  effectiveStageId?: string | null;
  canBrowseLectures: boolean;
}): LectureLoadDecision {
  if (!input.canBrowseLectures || !input.profileUid) {
    return { state: 'waiting-auth', shouldSubscribe: false, scope: null };
  }
  if (!input.effectiveStageId) {
    return { state: 'missing-stage', shouldSubscribe: false, scope: null };
  }
  const scope = `${input.profileUid}:${input.effectiveStageId}`;
  if (!input.isAuthReady || input.authenticatedUid !== input.profileUid) {
    return { state: 'waiting-auth', shouldSubscribe: false, scope };
  }
  return { state: 'loading', shouldSubscribe: true, scope };
}
