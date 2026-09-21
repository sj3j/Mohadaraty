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

/**
 * Does this user doc carry streak state from before `termStart`?
 *
 * The one definition of "stale", shared by openSeason and by
 * scripts/streakAudit.ts's preseason pass so a dry-run report and the repair it
 * previews can never disagree about who is affected.
 */
export function hasPreTermStreakState(u: any, termStart: string): boolean {
  const streakCount = u?.streakCount || 0;
  const longestStreak = u?.longestStreak || 0;
  const hasPending = u?.hasPendingStreakReset === true;
  // Nothing to clear.
  if (streakCount <= 0 && longestStreak <= 0 && !hasPending) return false;

  let lastActiveDate: string | null = u?.lastActiveDate ?? null;
  if (lastActiveDate && lastActiveDate.includes('T')) {
    lastActiveDate = lastActiveDate.split('T')[0];
  }
  // Credited on or after the term opened, so it belongs to THIS season.
  if (lastActiveDate && lastActiveDate >= termStart) return false;
  return true;
}

/**
 * Did the year-opening bridge already fire on this account?
 *
 * The counterpart to hasPreTermStreakState, for the accounts it cannot see. The
 * buggy write that inflated the counter ALSO moved lastActiveDate onto the
 * opening day, so the "credited on or after the term opened, so it belongs to
 * THIS season" test above reads the row as legitimate and skips it. The
 * selectivity that makes openSeason safe to run mid-term is exactly what blinds
 * it to the rows already damaged.
 *
 * `yearOpens` is terms[0].startDate and NOTHING ELSE - see seasonOpeningDay.
 * Keyed on the running term's start this would wipe the cohort on term 2's
 * first day, where a streak carried across the break is correct.
 *
 * longestStreak is tested as well as streakCount because a stale SEASON PEAK is
 * its own variant: an account at streakCount 0 with longestStreak 9 gets a
 * correct streakCount of 1 from the bridge and keeps the 9, which no
 * streakCount-only predicate sees and which the board prints as
 * "أطول هذا الموسم: 9".
 */
export function hasBridgedSeasonOpen(u: any, yearOpens: string): boolean {
  let lastActiveDate: string | null = u?.lastActiveDate ?? null;
  if (lastActiveDate && lastActiveDate.includes('T')) {
    lastActiveDate = lastActiveDate.split('T')[0];
  }
  // Only the opening day is provably capped at 1.
  if (lastActiveDate !== yearOpens) return false;
  return (u?.streakCount || 0) > 1
      || (u?.longestStreak || 0) > 1
      || u?.hasPendingStreakReset === true;
}

export interface SeasonOpenResult {
  termId: string;
  /** Accounts whose stale pre-term counters were zeroed. */
  cleared: number;
  /** Accounts already credited for the opening day, clamped to 1 rather than
   *  zeroed. See the comment on the clamp arm below. */
  bridged: number;
}

/**
 * Opens a term's season, clearing streak state left over from before it.
 *
 * startNewSeason closes a season; nothing opened one. closableTerm() only ever
 * returns a term whose live end is already past, so the FIRST term of a
 * calendar - which has no predecessor - can never be closed, startNewSeason
 * never fires at the year's open, and whatever counters an account carried into
 * the new year survive into day 1. Combined with activeDaysBetween reporting a
 * gap of ONE across the whole paused preseason, that is how a student read 2 on
 * the opening day of term 1 while every other student read 1.
 *
 * Writes no archive cards. A term that genuinely ended was already archived by
 * startNewSeason in the same rollover pass; the pre-calendar window is not a
 * season and has no board worth filing.
 *
 * SELECTIVE BY DESIGN. It touches only accounts whose last credited day
 * predates the term, so it is safe to deploy in the middle of an already
 * running term: a student who earned today's streak legitimately has
 * lastActiveDate >= termStart and is left alone. A blanket zeroing would wipe
 * the day for the whole cohort.
 *
 * Idempotent per term via app_settings/streak.seasonOpenedFor, mirroring
 * seasonClosedFor.
 */
export async function openSeason(
  db: FirebaseFirestore.Firestore,
  FieldValue: { serverTimestamp(): any; delete(): any },
  opts: {
    termId: string;
    /** The term's startDate, 'YYYY-MM-DD'. The boundary that defines "stale". */
    termStart: string;
    /**
     * terms[0].startDate - the academic YEAR's opening day. When it equals
     * termStart this is the year's first term, and the bridged sweep below is
     * armed. Omitted or different, the sweep is off: on term 2's first day a
     * streak above 1 is legitimate.
     */
    yearOpens?: string | null;
    /**
     * Today as 'YYYY-MM-DD'. Enables the already-credited check, which is what
     * stops this zeroing a row that can no longer recompute itself today.
     */
    creditedDay?: string | null;
    performedBy?: string;
  },
): Promise<SeasonOpenResult> {
  const { termId, termStart, yearOpens, creditedDay, performedBy } = opts;
  const sweepBridged = !!yearOpens && yearOpens === termStart;

  const usersSnap = await db.collection('users').get();

  let batch = db.batch();
  let ops = 0;
  let cleared = 0;
  let bridged = 0;
  const flush = async (force = false) => {
    if (ops >= 400 || (force && ops > 0)) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  };

  for (const doc of usersSnap.docs) {
    const u = doc.data() as any;
    const stale = hasPreTermStreakState(u, termStart);
    const wasBridged = sweepBridged && hasBridgedSeasonOpen(u, yearOpens as string);
    if (!stale && !wasBridged) continue;

    const streakCount = u.streakCount || 0;
    const longestStreak = u.longestStreak || 0;

    // Bank the peak before zeroing it. bestStreakAllTime is the only streak
    // number that survives a rollover, and nothing may lower longestStreak
    // without raising it first or "الأطول" loses the record permanently.
    const seasonPeak = Math.max(longestStreak, streakCount);
    const bankedBest = Math.max(u.bestStreakAllTime || 0, seasonPeak);

    // Has this account already been credited for the day being opened?
    //
    // It matters because shared/streakApi.ts returns early when
    // streak_history/{uid}_{date} exists - only the heartbeat is refreshed, and
    // NOTHING recomputes the counters until tomorrow. Zero such a row and the
    // student reads 0 for the rest of the day they actually earned.
    //
    // This also closes a race the staleness arm has on its own: the users scan
    // above is a snapshot, so a student who visits between that read and this
    // write would otherwise take the zero patch over a row that has since
    // gained today's marker.
    let creditedToday = false;
    if (creditedDay) {
      const hist = await db.collection('streak_history').doc(`${doc.id}_${creditedDay}`).get();
      creditedToday = hist.exists;
    }

    if (wasBridged || creditedToday) {
      batch.update(doc.ref, {
        streakCount: 1,
        longestStreak: 1,
        // Set to the credited day, NEVER nulled. The other arm nulls it so the
        // next visit reads `!processedLastDate` and starts at 1; this account
        // has already had that visit today, so nulling it would strand it at 0
        // until tomorrow. Writing the day is not merely safe, it is the truth:
        // the streak_history marker we just read is the proof it was active
        // then. That also corrects the race case, whose stored date is still
        // the stale one this scan snapshotted.
        ...(creditedDay ? { lastActiveDate: creditedDay } : {}),
        freezeTokens: 3,
        bestStreakAllTime: bankedBest,
        hasPendingStreakReset: FieldValue.delete(),
      });
      ops++;
      bridged++;

      // Annotate the audit trail, never rewrite it. The original
      // method/streakBefore/streakAfter are the evidence that the buggy branch
      // ran; overwriting them would make the log agree with a state that never
      // happened. A row that carries only these fields - which is what a merge
      // creates where the dev surface wrote no trail at all - reads
      // unambiguously as a repair rather than a crediting event.
      //
      // Guarded on creditedDay: it is the document id, and a caller that armed
      // the sweep without passing a day would otherwise throw here.
      if (creditedDay) {
        batch.set(
          db.collection('streakLog').doc(doc.id).collection('days').doc(creditedDay),
          {
            date: creditedDay,
            repairedAt: FieldValue.serverTimestamp(),
            repairReason: 'preseason_bridge',
            repairedFrom: streakCount,
            repairedTo: 1,
            ...(performedBy ? { repairedBy: performedBy } : {}),
          },
          { merge: true },
        );
        ops++;
      }
    } else {
      batch.update(doc.ref, {
        streakCount: 0,
        longestStreak: 0,
        lastActiveDate: null,
        freezeTokens: 3,
        bestStreakAllTime: bankedBest,
        hasPendingStreakReset: FieldValue.delete(),
      });
      ops++;
      cleared++;
    }

    // The flag guarded a streak this has just zeroed, so it can no longer be
    // forgiven into anything. Left behind it strands the student on a permanent
    // "you are about to lose your streak" banner.
    batch.delete(db.collection('pending_streak_resets').doc(doc.id));
    ops++;

    await flush();
  }
  await flush(true);

  await db.collection('app_settings').doc('streak').set(
    {
      seasonOpenedFor: termId,
      seasonOpenedAt: FieldValue.serverTimestamp(),
      ...(performedBy ? { seasonOpenedBy: performedBy } : {}),
    },
    { merge: true },
  );

  return { termId, cleared, bridged };
}
