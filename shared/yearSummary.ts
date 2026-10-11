/**
 * The one thing a student keeps when the year is wiped.
 *
 * The year-end wipe throws away the raw material - every MCQ answer, every
 * question-bank answer, every lecture. This runs FIRST and reduces all of it to
 * three numbers per student, written to `users/{uid}/yearHistory/{yearLabel}`:
 * their score, how many MCQs they solved, and how many bank questions they
 * answered. Nothing else about the year survives.
 *
 * Ordering matters twice over:
 * Run it before `wipeYear`, which resets MCQ aggregates and deletes
 * `userBankAnswers`.
 *
 * Lives in shared/ for the usual reason: server.ts and api/index.ts are
 * divergent copies and vercel.json routes production to api/index.ts, so logic
 * in only one of them silently never runs.
 */

export interface YearSummary {
  yearLabel: string;
  stageId: string;
  /** Same scale as the mcqHistory card written by seasonReset, so the two agree. */
  score: number;
  /** First-attempt MCQ questions answered. */
  mcqSolved: number;
  mcqCorrect: number;
  /** Questions answered from the question bank. */
  bankAnswered: number;
  /** Percentage, 0-100. */
  accuracy: number;
}

export interface YearSummaryResult {
  yearLabel: string;
  /** Students who had something worth recording. */
  summarised: number;
  /** Students skipped because they did nothing all year. */
  skipped: number;
}

/** Mirrors computeMcqRankScore in shared/seasonReset.ts - keep the three in step. */
function rankScore(correct: number, answered: number): number {
  if (!answered || answered <= 0) return 0;
  return Math.round((correct * correct * 100) / answered);
}

/**
 * Counts each user's question-bank answers in one pass.
 *
 * A collection-group query is used rather than one aggregation per user: there
 * are hundreds of users and almost all of them have no bank answers at all, so
 * per-user counting is hundreds of round trips to learn mostly zero. `select()`
 * fetches ids only.
 *
 * The path guard matters - a collection group matches ANY subcollection called
 * `questions`, so anything added later under a different parent would otherwise
 * be silently counted as bank answers.
 */
async function countBankAnswersByUser(
  db: FirebaseFirestore.Firestore,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const snap = await db.collectionGroup('questions').select().get();

  for (const doc of snap.docs) {
    const questionsRef = doc.ref.parent;          // .../userBankAnswers/{uid}/questions
    const userDoc = questionsRef.parent;          // .../userBankAnswers/{uid}
    if (!userDoc || userDoc.parent.id !== 'userBankAnswers') continue;
    const uid = userDoc.id;
    counts.set(uid, (counts.get(uid) || 0) + 1);
  }

  return counts;
}

/**
 * Writes one year card per student who was active.
 *
 * Idempotent: the card id is the year label and an existing card is immutable.
 * This is important after the annual aggregate reset: if a later wipe step
 * fails, retrying must not replace the real snapshot with zeroes.
 */
export async function summariseYear(
  db: FirebaseFirestore.Firestore,
  FieldValue: { serverTimestamp(): any },
  opts: { yearLabel: string },
): Promise<YearSummaryResult> {
  const { yearLabel } = opts;
  if (!yearLabel) throw new Error('summariseYear needs a yearLabel');

  const [statsSnap, bankCounts] = await Promise.all([
    db.collection('userMCQStats').get(),
    countBankAnswersByUser(db),
  ]);

  const statsByUid = new Map<string, any>();
  for (const d of statsSnap.docs) statsByUid.set(d.id, d.data() || {});

  // Everyone who did either kind of question. Driven off the two activity
  // sources rather than the users collection, so we never write a card for a
  // student who did nothing.
  const uids = new Set<string>([...statsByUid.keys(), ...bankCounts.keys()]);

  let batch = db.batch();
  let ops = 0;
  const flush = async (force = false) => {
    if (ops >= 400 || (force && ops > 0)) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  };

  let summarised = 0;
  let skipped = 0;

  for (const uid of uids) {
    const stats = statsByUid.get(uid) || {};
    const mcqSolved = stats.totalFirstAttemptAnswered || 0;
    const mcqCorrect = stats.totalFirstAttemptCorrect || 0;
    const bankAnswered = bankCounts.get(uid) || 0;

    if (mcqSolved === 0 && bankAnswered === 0) {
      skipped++;
      continue;
    }

    const summary: YearSummary = {
      yearLabel,
      stageId: stats.stageId || 'unassigned',
      score: Math.round(rankScore(mcqCorrect, mcqSolved) / 100),
      mcqSolved,
      mcqCorrect,
      bankAnswered,
      accuracy: mcqSolved > 0 ? (mcqCorrect / mcqSolved) * 100 : 0,
    };

    const historyRef = db.collection('users').doc(uid).collection('yearHistory').doc(yearLabel);
    if ((await historyRef.get()).exists) {
      skipped++;
      continue;
    }
    batch.set(historyRef, { ...summary, archivedAt: FieldValue.serverTimestamp() });
    ops++;
    summarised++;
    await flush();
  }

  await flush(true);

  return { yearLabel, summarised, skipped };
}
