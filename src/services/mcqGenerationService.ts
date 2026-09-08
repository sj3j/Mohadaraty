/**
 * Client half of MCQ generation.
 *
 * NO GEMINI KEY LIVES HERE ANY MORE. This file used to construct a
 * `GoogleGenAI` client in the browser from a key that vite.config.ts inlined
 * into the bundle, which meant anyone could extract it and spend against the
 * project's billing. Every model call now goes through the server, which holds
 * the key and enforces who may spend.
 *
 * The bug that forced the move is worth remembering: the old key read was
 *
 *     import.meta.env.VITE_GEMINI_API_KEY
 *       || (typeof process !== 'undefined' && process.env ? process.env.GEMINI_API_KEY : undefined)
 *
 * and `process` does not exist in a browser, so the second branch short-circuited
 * before Vite's `define` substitution was ever reached. Only `VITE_GEMINI_API_KEY`
 * ever worked. Setting the server-side key alone left the client with nothing
 * and every generation failed as `not_configured` - which looked like a billing
 * problem and was not.
 *
 * What remains here is Firestore reads and thin API calls.
 */
import { doc, getDoc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';
import { apiUrl } from '../lib/apiBase';
import { MCQQuestion, LectureMCQSets } from '../types/mcq.types';
import { trackEvent } from '../lib/analytics';

/**
 * A failure the student neither caused nor can fix: exhausted quota, missing
 * key, provider outage.
 *
 * Tagged rather than described, because the text shown on screen must not name
 * the vendor, the key, or a payment plan. The message this replaced told a
 * pharmacy student to "check your payment plan in your Google account".
 */
export class AIUnavailableError extends Error {
  constructor(public code: 'quota' | 'free_tier_limit' | 'not_configured' | 'provider') {
    super('AI_UNAVAILABLE');
  }
}

/** Neutral, student-facing. No vendor, no key, no billing. */
export const AI_UNAVAILABLE_MESSAGE = 'الخدمة غير متاحة حالياً. يرجى المحاولة لاحقاً.';

const PROVIDER_CODES = ['quota', 'free_tier_limit', 'not_configured'];

async function authHeaders(): Promise<Record<string, string>> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('غير مصرح. يرجى تسجيل الدخول مرة أخرى.');
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

async function postJson(path: string, body: any): Promise<any> {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = data?.error;
    if (PROVIDER_CODES.includes(code)) throw new AIUnavailableError(code);
    throw new Error(code || 'request_failed');
  }
  return data;
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export async function getExistingMCQsForLecture(lectureId: string): Promise<MCQQuestion[]> {
  try {
    const snap = await getDoc(doc(db, 'mcqs', lectureId));
    if (snap.exists()) {
      const data = snap.data() as LectureMCQSets;
      if (data.status === 'ready' && data.questions) return data.questions;
    }
  } catch (e) {
    console.warn('Failed to get existing MCQs', e);
  }
  return [];
}

export async function updateLectureMCQSet(lectureId: string, updatedQuestions: MCQQuestion[]) {
  await updateDoc(doc(db, 'mcqs', lectureId), {
    questions: updatedQuestions,
    updatedAt: serverTimestamp(),
  });
}

/* ------------------------------------------------------------------ *
 * Generation (staff only)
 * ------------------------------------------------------------------ */

/**
 * Ask the server to generate this lecture's questions.
 *
 * Staff only - the route is behind `verifyAdmin`. Students use
 * `requestMCQGeneration` instead, which notifies staff rather than spending.
 *
 * Only the lecture id is sent. The server resolves the PDF itself, both because
 * Vercel caps request bodies near 4.5MB and because a caller-supplied URL would
 * let anyone point the server at an arbitrary host.
 */
export async function generateMCQsForLecture(lectureId: string): Promise<MCQQuestion[]> {
  trackEvent('mcq_generation_started', { lectureId });
  try {
    await postJson('/api/mcq/generate', { lectureId });
    const questions = await getExistingMCQsForLecture(lectureId);
    trackEvent('mcq_generation_success', { lectureId, questionCount: questions.length });
    return questions;
  } catch (e: any) {
    trackEvent('mcq_generation_failed', { lectureId, error: e?.code || e?.message });
    throw e;
  }
}

/**
 * A student asking staff to generate questions for a lecture that has none.
 *
 * Spends nothing. The server records the request and notifies support and the
 * master admin with the stage, subject and lecture named in the message, so
 * staff can act without hunting for it.
 */
export async function requestMCQGeneration(lectureId: string): Promise<{ alreadyRequested?: boolean; alreadyReady?: boolean }> {
  return postJson('/api/mcq/request', { lectureId });
}

/* ------------------------------------------------------------------ *
 * Question bank (staff only)
 * ------------------------------------------------------------------ */

/**
 * Extract questions from an exam PDF the admin has uploaded to Cloud Storage.
 *
 * Takes a storage PATH, not bytes: these are scans that routinely exceed
 * Vercel's ~4.5MB body cap. The old flow base64'd up to 20MB in the browser,
 * which only worked because the browser called Gemini directly.
 */
export async function extractMCQsFromStoragePath(storagePath: string): Promise<any[]> {
  const data = await postJson('/api/mcq/extract', { storagePath });
  return data.questions || [];
}

/**
 * AI edit of a single question.
 *
 * `lectureId` rather than a pdfUrl, for the same reason as generation. Pass it
 * when the edit should be grounded in the lecture; omit it otherwise.
 */
export async function modifyQuestionWithAI(
  question: any,
  userPrompt: string,
  lectureId?: string,
): Promise<any> {
  const data = await postJson('/api/mcq/modify', { question, prompt: userPrompt, lectureId });
  return data.question;
}
