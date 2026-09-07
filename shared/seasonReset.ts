/**
 * Season reset shared by both API surfaces.
 *
 * server.ts and api/index.ts are divergent copies of the same Express app, and
 * vercel.json routes production /api/* to api/index.ts. Logic that lives in only
 * one of them silently never runs in production, so this is defined once here
 * and imported by both.
 */

export interface SeasonResetResult {
  seasonId: string;
  streakArchived: number;
  mcqArchived: number;
}

/** Mirrors computeMcqRankScore in src/types/mcq.types.ts - keep the two in step. */
export function computeMcqRankScore(correct: number, answered: number): number | null {
  if (!answered || answered <= 0) return null;
  return Math.round((correct * correct * 100) / answered);
}

/** Ranks entries within each stage, highest value first. Returns rank by key. */
function rankWithinStages<T>(
  entries: T[],
  stageOf: (e: T) => string,
  valueOf: (e: T) => number,
  keyOf: (e: T) => string,
): Map<string, { rank: number; stageId: string }> {
  const byStage = new Map<string, T[]>();
  for (const e of entries) {
    const stage = stageOf(e) || 'unassigned';
    if (!byStage.has(stage)) byStage.set(stage, []);
    byStage.get(stage)!.push(e);
  }

  const ranks = new Map<string, { rank: number; stageId: string }>();
  for (const [stageId, group] of byStage) {
    group
      .slice()
      .sort((a, b) => valueOf(b) - valueOf(a))
      .forEach((e, i) => ranks.set(keyOf(e), { rank: i + 1, stageId }));
  }
  return ranks;
}

/**
 * Ends the current season and starts a fresh one.
 *
 * Archives BOTH boards into each student's own profile (with their final rank),
 * writes a per-stage top list for the record, and zeroes the live boards.
 *
 * Per-lecture MCQ answers (`userMCQAnswers`) are deliberately left untouched:
 * students keep their review history, and because the new season runs on a new
 * stage's lectures nobody can re-farm points from the old ones.
 */
export async function startNewSeason(
  db: FirebaseFirestore.Firestore,
  FieldValue: { serverTimestamp(): any; delete(): any },
  opts: {
    seasonName: string;
    performedBy: string;
    /** Term whose season this closes. Makes the rollover idempotent per term. */
    closedTermId?: string;
  },
): Promise<SeasonResetResult> {
  const { seasonName, performedBy, closedTermId } = opts;

  // Derived from the term when the calendar closes a season, so a retry after a
  // partial failure reuses the same document ids instead of creating a second
  // set. Combined with the "already zeroed students are no longer ranked"
  // filter below, that makes a resumed run land exactly where the first stopped:
  // students already archived keep their card, the rest get theirs.
  const seasonId = closedTermId ? `season_${closedTermId}` : `season_${Date.now()}`;

  const [usersSnap, statsSnap] = await Promise.all([
    db.collection('users').get(),
    db.collection('userMCQStats').get(),
  ]);

  const users = usersSnap.docs.map(d => ({ uid: d.id, ref: d.ref, ...(d.data() as any) }));
  const stats = statsSnap.docs.map(d => ({ uid: d.id, ref: d.ref, ...(d.data() as any) }));

  // Stage lookup for stats docs, which may predate stageId being written.
  const stageByUid = new Map(users.map(u => [u.uid, u.stageId || 'unassigned']));

  const streakRanks = rankWithinStages(
    users.filter(u => (u.streakCount || 0) > 0 || (u.longestStreak || 0) > 0),
    u => u.stageId,
    u => u.streakCount || 0,
    u => u.uid,
  );

  const rankedStats = stats
    .map(s => ({
      ...s,
      _score: computeMcqRankScore(s.totalFirstAttemptCorrect || 0, s.totalFirstAttemptAnswered || 0) ?? 0,
    }))
    .filter(s => (s.totalFirstAttemptAnswered || 0) > 0);

  const mcqRanks = rankWithinStages(
    rankedStats,
    s => s.stageId || stageByUid.get(s.uid) || 'unassigned',
    s => s._score,
    s => s.uid,
  );

  // ---- per-student history + reset ----------------------------------------
  let batch = db.batch();
  let ops = 0;
  const flush = async (force = false) => {
    if (ops >= 400 || (force && ops > 0)) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  };

  for (const u of users) {
    const placing = streakRanks.get(u.uid);
    if (placing) {
      batch.set(u.ref.collection('streakHistory').doc(seasonId), {
        seasonId,
        semesterId: seasonId,      // legacy field name still read by older clients
        semesterName: seasonName,
        seasonName,
        stageId: placing.stageId,
        rank: placing.rank,
        finalStreak: u.streakCount || 0,
        longestStreak: u.longestStreak || 0,
        freezeTokensUsed: 3 - (u.freezeTokens ?? 3),
        archivedAt: FieldValue.serverTimestamp(),
      });
      ops++;
    }

    // bestStreakAllTime is deliberately NOT in this patch - it is the only streak
    // number that survives a rollover. Raise it from the season being closed here,
    // before longestStreak is zeroed, or the peak dies with it and "الأطول" can
    // never read higher than the running season (0 for the whole vacation).
    const seasonPeak = Math.max(u.longestStreak || 0, u.streakCount || 0);

    batch.update(u.ref, {
      streakCount: 0,
      longestStreak: 0,
      lastActiveDate: null,
      freezeTokens: 3,
      bestStreakAllTime: Math.max(u.bestStreakAllTime || 0, seasonPeak),
      // The flag guards a streak this reset has just archived and zeroed, so it
      // can no longer be forgiven into anything. Left behind it strands the
      // student on a permanent "you are about to lose your streak" banner -
      // 325 accounts sat that way for four months before this line existed.
      hasPendingStreakReset: FieldValue.delete(),
    });
    ops++;

    // Same reasoning, and nothing else ever drains this collection: the docs are
    // written with an expiresAt that no code reads, and the only other clear is a
    // manual per-student admin action. Deleting a missing doc is a no-op.
    batch.delete(db.collection('pending_streak_resets').doc(u.uid));
    ops++;

    await flush();
  }
  await flush(true);

  for (const s of rankedStats) {
    const placing = mcqRanks.get(s.uid);
    const answered = s.totalFirstAttemptAnswered || 0;
    const correct = s.totalFirstAttemptCorrect || 0;

    batch.set(db.collection('users').doc(s.uid).collection('mcqHistory').doc(seasonId), {
      seasonId,
      seasonName,
      stageId: placing?.stageId || 'unassigned',
      rank: placing?.rank ?? null,
      score: Math.round(s._score / 100),
      totalCorrect: correct,
      totalAnswered: answered,
      accuracy: answered > 0 ? (correct / answered) * 100 : 0,
      lecturesAttempted: s.lecturesAttempted || 0,
      subjectStats: s.subjectStats || {},
      archivedAt: FieldValue.serverTimestamp(),
    });
    ops++;

    // Zero the aggregate. userMCQAnswers is intentionally left alone.
    batch.update(s.ref, {
      totalFirstAttemptCorrect: 0,
      totalFirstAttemptAnswered: 0,
      lecturesAttempted: 0,
      mcqLeaderboardScore: 0,
      accuracy: 0,
      mcqRankScore: FieldValue.delete(),
      subjectStats: {},
      lastUpdated: FieldValue.serverTimestamp(),
    });
    ops++;
    await flush();
  }
  await flush(true);

  // ---- season record -------------------------------------------------------
  const topByStage = <T>(
    list: T[],
    ranks: Map<string, { rank: number; stageId: string }>,
    keyOf: (e: T) => string,
    build: (e: T, r: number, stageId: string) => any,
  ) => list
    .map(e => ({ e, r: ranks.get(keyOf(e)) }))
    .filter(x => x.r && x.r.rank <= 50)
    .map(x => build(x.e, x.r!.rank, x.r!.stageId));

  await db.collection('semesterArchives').doc(seasonId).set({
    seasonId,
    semesterId: seasonId,
    semesterName: seasonName,
    seasonName,
    archivedAt: FieldValue.serverTimestamp(),
    archivedBy: performedBy,
    topStudents: topByStage(users, streakRanks, u => u.uid, (u, rank, stageId) => ({
      rank, stageId, userId: u.uid, name: u.name,
      streakCount: u.streakCount || 0, longestStreak: u.longestStreak || 0,
    })),
    topMcqStudents: topByStage(rankedStats, mcqRanks, s => s.uid, (s, rank, stageId) => ({
      rank, stageId, userId: s.uid,
      score: Math.round(s._score / 100),
      totalCorrect: s.totalFirstAttemptCorrect || 0,
      totalAnswered: s.totalFirstAttemptAnswered || 0,
    })),
    totalStudents: users.length,
  });

  // Deliberately does NOT touch vacationMode. Whether the app is paused is the
  // calendar's call, never the archive's - callers follow this with
  // syncPhaseMirror(), which recomputes it from the resolved phase.
  const settings: Record<string, any> = {
    lastArchiveId: seasonId,
    currentSemesterName: seasonName,
  };
  if (closedTermId) settings.seasonClosedFor = closedTermId;

  await db.collection('app_settings').doc('streak').set(settings, { merge: true });

  return {
    seasonId,
    streakArchived: streakRanks.size,
    mcqArchived: rankedStats.length,
  };
}
