export type RankedMcqRow<T> = T & { _rank: number };

/** Assigns competition ranks to rows already sorted by points, accuracy, UID. */
export function assignMcqCompetitionRanks<T extends { mcqLeaderboardScore?: number }>(
  rows: T[],
): RankedMcqRow<T>[] {
  let previousScore: number | null = null;
  let competitionRank = 0;
  return rows.map((row, index) => {
    const score = Number(row.mcqLeaderboardScore || 0);
    if (previousScore === null || score !== previousScore) competitionRank = index + 1;
    previousScore = score;
    return { ...row, _rank: competitionRank };
  });
}
