export type MCQStemFormat = 'standard' | 'except' | 'regarding' | 'true_false';
export type MCQDifficulty = 'easy' | 'medium' | 'hard';
export type MCQStatus = 'ready' | 'generating' | 'failed';

export interface MCQChoice {
  label: 'A' | 'B' | 'C' | 'D' | 'E';
  text: string;
}

export interface MCQQuestion {
  id: string;
  type: 'mcq' | 'true_false';
  stem: string;
  stemFormat: MCQStemFormat;
  choices: MCQChoice[];
  correctAnswer: 'A' | 'B' | 'C' | 'D' | 'E' | 'True' | 'False';
  explanation: string;
  difficulty: MCQDifficulty;
  addedBy: 'ai' | 'admin';
  createdAt: any; // Firestore Timestamp
  imageUrl?: string; // Optional image (e.g., structure)
}

export interface LectureMCQSets {
  id?: string; // documentId (lectureId)
  lectureId: string;
  subjectId: string;
  generatedAt: any; // Firestore Timestamp
  generatedBy: 'gemini-ai' | 'admin';
  questions: MCQQuestion[];
  totalQuestions: number;
  status: MCQStatus;
  startedAt?: any; // Firestore Timestamp for tracking generation timeout
}

export interface MCQAnswerState {
  selected: string;
  isCorrect: boolean;
  isFirstAttempt: boolean;
}

export interface MCQAttempt {
  attemptNumber: number;
  startedAt: any; // Firestore Timestamp
  completedAt: any; // Firestore Timestamp
  answers: Record<string, MCQAnswerState>;
  score: number; // percentage 0-100
  correctCount: number;
  totalCount: number;
}

export interface UserMCQAnswers {
  lectureId: string;
  userId: string;
  attempts: MCQAttempt[];
  firstAttemptScore: number | null;
  firstAttemptCorrect: number;
  firstAttemptTotal: number;
  hasCompletedFirstAttempt: boolean;
  totalAttempts: number;
}

export interface UserSubjectStats {
  correct: number;
  total: number;
  lecturesAttempted: number;
}

export interface UserMCQStats {
  userId: string;
  stageId?: string;
  totalFirstAttemptCorrect: number;
  totalFirstAttemptAnswered: number;
  lecturesAttempted: number;
  /** Volume points (correct x 10). Displayed, but no longer what the board sorts on. */
  mcqLeaderboardScore: number;
  accuracy: number;
  /**
   * What the leaderboard actually orders by. Absent when the user has not
   * answered enough questions to qualify - Firestore's orderBy skips documents
   * missing the field, which is exactly the exclusion we want.
   */
  mcqRankScore?: number;
  lastUpdated: any; // Firestore Timestamp
  subjectStats: Record<string, UserSubjectStats>;
}

export interface UserStageMCQStats {
  id?: string; // `${userId}_${stageId}`
  userId: string;
  stageId: string;
  /**
   * True when the student is currently enrolled and actively competing in this stage.
   * When promoted or graduated, becomes false so their historical record remains in
   * this stage without blocking new incoming cohorts.
   */
  isActiveInStage: boolean;
  totalFirstAttemptCorrect: number;
  totalFirstAttemptAnswered: number;
  lecturesAttempted: number;
  mcqLeaderboardScore: number;
  accuracy: number;
  mcqRankScore?: number;
  lastUpdated: any; // Firestore Timestamp
  subjectStats: Record<string, UserSubjectStats>;
}

/**
 * Leaderboard ordering key: effort scaled by precision.
 *
 *   score = correct x accuracy   ==   correct^2 / answered
 *
 * Hard work sets the scale (a student who answers more correct questions ranks
 * higher) while accuracy scales it down, so grinding through questions with
 * poor precision no longer beats a careful student. Stored x100 to keep two
 * decimal places as an integer.
 *
 * No qualifying threshold is needed: a perfect 20/20 scores only 20, so a short
 * flawless quiz cannot outrank sustained work. The field is simply absent for
 * anyone who has not answered a question yet, which orderBy excludes.
 *
 * @returns null when the user has no answers at all.
 */
export function computeMcqRankScore(correct: number, answered: number): number | null {
  if (!answered || answered <= 0) return null;
  return Math.round((correct * correct * 100) / answered);
}
