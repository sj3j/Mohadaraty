/**
 * Client half of Simosan, the in-reader AI tutor.
 *
 * Deliberately thin. Every decision that costs money — whether the student may
 * ask, how much energy the question burns, what history the model sees — is
 * made on the server and is not represented here. This file sends
 * `{ lectureId, question }` and renders what comes back; there is nothing in a
 * request it could lie about that would matter.
 *
 * Contrast with src/services/mcqGenerationService.ts, which calls Gemini
 * directly from the browser with a bundled API key. That is the pattern this
 * one exists to not repeat.
 */
import {
  collection, doc, getDocs, limit, onSnapshot, orderBy, query,
} from 'firebase/firestore';
import { auth, db } from '../lib/firebase';
import { apiUrl } from '../lib/apiBase';

export interface SimosanMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  citedPages?: number[];
  selection?: string | null;
  /** Set while a reply is still streaming in; never persisted. */
  pending?: boolean;
}

export interface SimosanState {
  available: boolean;
  hasAccess: boolean;
  enabled: boolean;
  remaining: number;
  dailyBudget: number;
  resetsInMs: number;
  maxQuestionsPerChat: number;
}

export interface SimosanThread {
  id: string;
  questionCount: number;
  isReadOnly: boolean;
  updatedAt?: any;
}

/** Terminal outcomes the drawer needs to distinguish for the student. */
export type AskErrorCode =
  | 'insufficient_energy'
  | 'not_subscribed'
  | 'disabled'
  | 'ceiling_reached'
  | 'ai_unavailable'
  | 'lecture_has_no_pdf'
  | 'pdf_too_large'
  | 'pdf_too_many_pages'
  | 'offline'
  | 'internal';

export class AskError extends Error {
  constructor(
    public code: AskErrorCode,
    public detail: { remaining?: number; dailyBudget?: number; resetsInMs?: number } = {},
  ) {
    super(code);
  }
}

async function authHeader(): Promise<Record<string, string>> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new AskError('not_subscribed');
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

export async function fetchSimosanState(): Promise<SimosanState | null> {
  try {
    const res = await fetch(apiUrl('/api/ai/state'), { headers: await authHeader() });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

const lectureRef = (uid: string, lectureId: string) =>
  doc(db, 'aiChats', uid, 'lectures', lectureId);

const threadsRef = (uid: string, lectureId: string) =>
  collection(db, 'aiChats', uid, 'lectures', lectureId, 'threads');

const messagesRef = (uid: string, lectureId: string, threadId: string) =>
  collection(db, 'aiChats', uid, 'lectures', lectureId, 'threads', threadId, 'messages');

/** Live view of one thread's messages. Chats are read straight from Firestore
 *  rather than replayed through the API — the API is only for spending. */
export function watchMessages(
  lectureId: string,
  threadId: string,
  onChange: (msgs: SimosanMessage[]) => void,
): () => void {
  const uid = auth.currentUser?.uid;
  if (!uid || !threadId) return () => {};
  const q = query(messagesRef(uid, lectureId, threadId), orderBy('createdAt', 'asc'), limit(60));
  return onSnapshot(
    q,
    (snap) => {
      onChange(
        snap.docs.map((d) => ({
          id: d.id,
          role: d.data().role,
          text: d.data().text || '',
          citedPages: d.data().citedPages || [],
          selection: d.data().selection ?? null,
        })),
      );
    },
    (err) => {
      console.warn('[simosan] message listener failed', err);
      onChange([]);
    },
  );
}

export function watchLecture(
  lectureId: string,
  onChange: (activeThreadId: string) => void,
): () => void {
  const uid = auth.currentUser?.uid;
  if (!uid) return () => {};
  return onSnapshot(
    lectureRef(uid, lectureId),
    (snap) => onChange(snap.exists() ? snap.data()?.activeThreadId || '' : ''),
    (err) => {
      console.warn('[simosan] lecture listener failed', err);
      onChange('');
    },
  );
}

export async function listThreads(lectureId: string): Promise<SimosanThread[]> {
  const uid = auth.currentUser?.uid;
  if (!uid) return [];
  try {
    const snap = await getDocs(query(threadsRef(uid, lectureId), orderBy('updatedAt', 'desc'), limit(25)));
    return snap.docs.map((d) => ({
      id: d.id,
      questionCount: d.data().questionCount || 0,
      isReadOnly: !!d.data().isReadOnly,
      updatedAt: d.data().updatedAt,
    }));
  } catch (e) {
    console.warn('[simosan] listThreads failed', e);
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * Ask
 * ------------------------------------------------------------------ */

export interface AskCallbacks {
  onMeta?: (meta: { threadId: string; questionNumber: number; remaining: number }) => void;
  onDelta: (text: string) => void;
  onDone: (done: {
    threadId: string;
    offTopic: boolean;
    refunded: boolean;
    citedPages: number[];
    remaining: number;
    isReadOnly: boolean;
  }) => void;
}

/**
 * Ask Simosan a question, streaming the answer.
 *
 * Reads the SSE body with a plain reader rather than EventSource, because
 * EventSource cannot send an Authorization header or a POST body.
 */
export async function askSimosan(
  input: { lectureId: string; question: string; selection?: string; newThread?: boolean },
  cbs: AskCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new AskError('offline');
  }

  const res = await fetch(apiUrl('/api/ai/ask'), {
    method: 'POST',
    headers: await authHeader(),
    body: JSON.stringify(input),
    signal,
  });

  // Failures before the stream opens come back as ordinary JSON.
  if (!res.ok || !res.body) {
    let code: AskErrorCode = 'internal';
    let detail = {};
    try {
      const data = await res.json();
      code = (data.error as AskErrorCode) || 'internal';
      detail = data;
    } catch { /* non-JSON body: keep the generic code */ }
    throw new AskError(code, detail);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line; a partial frame stays buffered.
    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';

    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      let evt: any;
      try {
        evt = JSON.parse(line.slice(6));
      } catch {
        continue;
      }

      if (evt.type === 'delta') cbs.onDelta(evt.text);
      else if (evt.type === 'meta') cbs.onMeta?.(evt);
      else if (evt.type === 'done') cbs.onDone(evt);
      else if (evt.type === 'error') {
        throw new AskError((evt.code as AskErrorCode) || 'internal', evt);
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Rendering helpers
 * ------------------------------------------------------------------ */

/** Split an answer into text and [[p:N]] citations, for the tappable chips. */
export function parseCitations(text: string): Array<{ text: string } | { page: number }> {
  const out: Array<{ text: string } | { page: number }> = [];
  let last = 0;
  for (const m of text.matchAll(/\[\[p:(\d+)\]\]/g)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index) });
    out.push({ page: Number(m[1]) });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** "3 س 20 د" — a countdown the student can act on, not a timestamp. */
export function formatReset(ms: number, isRtl: boolean): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (isRtl) return h > 0 ? `${h} ساعة و ${m} دقيقة` : `${m} دقيقة`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
