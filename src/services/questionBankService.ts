import { 
  collection, 
  doc, 
  getDoc, 
  getDocs, 
  setDoc, 
  updateDoc, 
  addDoc, 
  query, 
  where, 
  orderBy, 
  limit,
  serverTimestamp, 
  increment, 
  writeBatch 
} from 'firebase/firestore';
import { db, auth } from '../lib/firebase';
import { BankQuestion, QuestionTag } from '../types/questionBank.types';
export { bankLectureIdFor } from '../lib/questionBankMatching';

export type NewBankQuestionInput = Omit<
  BankQuestion,
  'id' | 'addedBy' | 'addedAt' | 'lastEditedBy' | 'lastEditedAt' | 'viewCount' | 'attemptCount' | 'correctCount' | 'accuracyRate'
>;

export async function addBankQuestion(data: NewBankQuestionInput) {
  const user = auth.currentUser;
  if (!user) throw new Error('Not logged in');

  const payload = {
    ...data,
    addedBy: user.uid,
    addedAt: serverTimestamp(),
    lastEditedBy: null,
    lastEditedAt: null,
    viewCount: 0,
    attemptCount: 0,
    correctCount: 0,
    accuracyRate: 0
  };

  const docRef = await addDoc(collection(db, 'questionBank'), payload);
  // Add ID to output
  return docRef.id;
}

/**
 * Bulk insert questions into questionBank using Firestore writeBatch in chunks
 * of 400 (under Firestore's 500 operation limit).
 * Reports progress so callers can render smooth progress bars.
 */
export async function batchAddBankQuestions(
  items: NewBankQuestionInput[],
  onProgress?: (savedCount: number, totalCount: number) => void
): Promise<{ savedCount: number }> {
  const user = auth.currentUser;
  if (!user) throw new Error('Not logged in');

  const BATCH_SIZE = 400;
  let savedCount = 0;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk = items.slice(i, i + BATCH_SIZE);
    const batch = writeBatch(db);

    for (const item of chunk) {
      const docRef = doc(collection(db, 'questionBank'));
      batch.set(docRef, {
        ...item,
        addedBy: user.uid,
        addedAt: serverTimestamp(),
        lastEditedBy: null,
        lastEditedAt: null,
        viewCount: 0,
        attemptCount: 0,
        correctCount: 0,
        accuracyRate: 0,
      });
    }

    await batch.commit();
    savedCount += chunk.length;
    if (onProgress) {
      onProgress(savedCount, items.length);
    }
  }

  return { savedCount };
}

export async function editBankQuestion(id: string, data: Partial<BankQuestion>) {
  const user = auth.currentUser;
  if (!user) throw new Error('Not logged in');

  const ref = doc(db, `questionBank/${id}`);
  await updateDoc(ref, {
    ...data,
    lastEditedBy: user.uid,
    lastEditedAt: serverTimestamp()
  });
}

export async function softDeleteBankQuestion(id: string) {
  const user = auth.currentUser;
  if (!user) throw new Error('Not logged in');

  const ref = doc(db, `questionBank/${id}`);
  await updateDoc(ref, {
    isActive: false,
    lastEditedBy: user.uid,
    lastEditedAt: serverTimestamp()
  });
}

export async function getQuestionsForLecture(lectureId: string, subjectId: string): Promise<BankQuestion[]> {
  const qbRef = collection(db, 'questionBank');
  // Combine questions scopes: 
  // - lecture scope for lectureId
  // - subject scope for subjectId
  // - global scope
  // For simplicity since we can't easily do a unified OR query in basic firestore with multiple indexed fields without a special index or `in` on scope, we'll fetch them and merge:
  
  // Note: To optimize, we can use an `in` query on a combined field or just fetch scopes client side. Since we want lecture, subject, global scopes:
  
  const qLec = query(qbRef, where('isActive', '==', true), where('scope', '==', 'lecture'), where('lectureId', '==', lectureId));
  const qSub = query(qbRef, where('isActive', '==', true), where('scope', '==', 'subject'), where('subjectId', '==', subjectId));
  const qGlob = query(qbRef, where('isActive', '==', true), where('scope', '==', 'global'));
  
  const [resLec, resSub, resGlob] = await Promise.all([
    getDocs(qLec),
    getDocs(qSub),
    getDocs(qGlob)
  ]);
  
  const results: BankQuestion[] = [];
  resLec.forEach(d => results.push({ id: d.id, ...d.data() } as BankQuestion));
  resSub.forEach(d => results.push({ id: d.id, ...d.data() } as BankQuestion));
  resGlob.forEach(d => results.push({ id: d.id, ...d.data() } as BankQuestion));
  
  return results;
}

export async function getAllBankQuestionsForAdmin(): Promise<BankQuestion[]> {
  // Ordered by latest. In production with many docs we would paginate
  const q = query(collection(db, 'questionBank'), orderBy('addedAt', 'desc'), limit(250));
  const snap = await getDocs(q);
  const results: BankQuestion[] = [];
  snap.forEach(d => results.push({ id: d.id, ...d.data() } as BankQuestion));
  return results;
}

export interface QuestionReportMetadata {
  source?: 'bank' | 'lecture';
  lectureId?: string;
  lectureTitle?: string;
  subjectId?: string;
  tags?: string[];
}

export async function reportBankQuestion(
  questionId: string, 
  reason: string, 
  stem: string, 
  userName: string,
  metadata?: QuestionReportMetadata
) {
  const user = auth.currentUser;
  if (!user) throw new Error('Not logged in');

  // Instead of updating questionBank directly (which fails for students due to rules),
  // we add an alert to adminAlerts which students have permission to create.
  await addDoc(collection(db, 'adminAlerts'), {
    type: 'question_report',
    questionId,
    questionStem: stem,
    reason,
    reportedBy: user.uid,
    reportedByName: userName,
    createdAt: serverTimestamp(),
    source: metadata?.source || 'bank',
    lectureId: metadata?.lectureId || null,
    lectureTitle: metadata?.lectureTitle || null,
    subjectId: metadata?.subjectId || null,
    tags: metadata?.tags || null
  });
}

export async function replyToQuestionReport(
  notificationId: string, 
  reportedByUserId: string, 
  replyText: string, 
  isRtl: boolean = true
) {
  if (!replyText || !replyText.trim()) return;

  // 1. Notify the student
  await addDoc(collection(db, 'systemNotifications'), {
    userId: reportedByUserId,
    title: isRtl ? 'رد على التبليغ عن سؤال' : 'Response to Question Report',
    body: replyText.trim(),
    createdAt: serverTimestamp(),
  });

  // 2. Mark the admin alert as replied
  const alertRef = doc(db, 'adminAlerts', notificationId);
  await updateDoc(alertRef, {
    replied: true,
    replyText: replyText.trim(),
    repliedAt: serverTimestamp()
  });
}

export async function saveUserBankAnswer(userId: string, questionId: string, selectedAnswer: string, isCorrect: boolean, sessionId: string, tags: string[]) {
  const ref = doc(collection(db, `userBankAnswers/${userId}/questions`));
  await setDoc(ref, {
    questionId,
    selectedAnswer,
    isCorrect,
    answeredAt: serverTimestamp(),
    sessionId,
    tags
  });
  
  // And update the bank's aggregate metrics (attemptCount, correctCount, accuracyRate)
  const qRef = doc(db, `questionBank/${questionId}`);
  // Basic update (for accuracy we should ideally use transaction or cloud func)
  // Let's do a client-side transaction to update aggregate stats accurately
  // (In production prefer a cloud function to prevent fraud/contention)
  try {
    const qDoc = await getDoc(qRef);
    if(qDoc.exists()) {
      const data = qDoc.data();
      const newAttempts = (data.attemptCount || 0) + 1;
      const newCorrect = (data.correctCount || 0) + (isCorrect ? 1 : 0);
      const newAccuracy = newAttempts > 0 ? (newCorrect / newAttempts) : 0;
      
      await updateDoc(qRef, {
        attemptCount: increment(1),
        correctCount: increment(isCorrect ? 1 : 0),
        accuracyRate: newAccuracy
      });
    }
  } catch(e) {}
}

export interface SendDoctorQuestionsNotificationParams {
  lectureId: string;
  lectureTitle: string;
  stageId?: string;
  subjectId?: string;
}

export interface SendDoctorQuestionsNotificationResult {
  success: boolean;
  recipientsCount: number;
  sentCount: number;
  failureCount: number;
  notificationId?: string;
}

export async function sendDoctorQuestionsNotification(
  params: SendDoctorQuestionsNotificationParams
): Promise<SendDoctorQuestionsNotificationResult> {
  const user = auth.currentUser;
  if (!user) throw new Error('Not logged in');

  const token = await user.getIdToken();
  const response = await fetch('/api/notify/doctor-questions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(params)
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Failed to send doctor questions notification');
  }

  return data as SendDoctorQuestionsNotificationResult;
}
