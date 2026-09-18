/**
 * How widely a bank question is shown.
 *
 * 'global' was removed: it wrote `subjectId: null`, so the question appeared to
 * every stage at once. There is no such thing as a question that belongs to no
 * subject - every question is asked about a subject, and every subject belongs
 * to a stage. Rows already stored as 'global' are still READ (the union below
 * keeps the type honest about what is in the collection) and are surfaced in
 * AdminQuestionBankScreen so staff can give them a subject; nothing writes it.
 */
export type QuestionScope = 'lecture' | 'subject';

/** Including what old rows may still hold. Never write this. */
export type StoredQuestionScope = QuestionScope | 'global';
export type QuestionTag = 'وزاري' | 'سنين_سابقة' | 'سؤال_الدكتور' | 'مهم' | 'متوقع' | string;
export type QuestionType = 'mcq' | 'true_false';
export type StemFormat = 'standard' | 'except' | 'regarding' | 'true_false';
export type Difficulty = 'easy' | 'medium' | 'hard';

export interface BankChoice {
  label: string;
  text: string;
}

export interface BankQuestion {
  id: string; // QuestionId, locally using document id
  
  // Scope
  scope: StoredQuestionScope;
  lectureId: string | null;
  /** Null only on legacy 'global' rows, which is exactly what needs repairing. */
  subjectId: string | null;
  /**
   * The stage the subject belongs to, denormalized so the collection can be
   * scoped without joining `subjects` on every read. Absent on rows written
   * before questions were tied to a subject.
   */
  stageId?: string | null;
  courseId?: string | null;
  subjectName?: string | null;
  subjectNameAr?: string | null;
  
  // Tags
  tags: QuestionTag[];
  year: string | null;
  
  // Content
  type: QuestionType;
  stemFormat: StemFormat;
  stem: string;
  choices: BankChoice[];
  correctAnswer: string;
  explanation: string;
  difficulty: Difficulty;
  imageUrl?: string;
  
  // Meta
  addedBy: string;
  addedAt: any; // Timestamp
  lastEditedBy: string | null;
  lastEditedAt: any | null; // Timestamp
  isActive: boolean;
  viewCount: number;
  
  // Bank scoring
  attemptCount: number;
  correctCount: number;
  accuracyRate: number;

  // Flagging
  isFlagged?: boolean;
  flaggedReason?: string;
  flaggedBy?: string;
  flaggedAt?: any; // Timestamp
}

export interface UserBankAnswer {
  questionId: string;
  selectedAnswer: string;
  isCorrect: boolean;
  answeredAt: any; // Timestamp
  sessionId: string;
  tags: string[];
}
