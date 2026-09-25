/**
 * Client half of the parsed weekly timetable.
 *
 * Only ONE call goes to the server - the Gemini parse, because it spends quota
 * on a key that must never reach a browser. Reading a draft, correcting it and
 * publishing it are plain Firestore operations scoped by firestore.rules, which
 * is why there is no route for them.
 */
import {
  deleteDoc, deleteField, doc, onSnapshot, serverTimestamp, setDoc, writeBatch,
  type DocumentSnapshot,
} from 'firebase/firestore';
import { auth, db, handleFirestoreError, OperationType } from '../lib/firebase';
import { apiUrl } from '../lib/apiBase';
import type { StageTimetableDoc, TimetableSession } from '../../shared/timetable';

/** A failure the user neither caused nor can fix. Mirrors AIUnavailableError in
 *  mcqGenerationService: the message on screen must not name the vendor, the
 *  key or a payment plan. */
export class TimetableUnavailableError extends Error {
  constructor(public code: string) { super('TIMETABLE_UNAVAILABLE'); }
}

// 'unavailable' is here so a provider outage reaches the UI as a typed error
// rather than a raw code, but it is NOT interchangeable with the others: the
// remedy is to wait a moment and press the button again, and the message the
// user sees has to say so.
const PROVIDER_CODES = ['quota', 'free_tier_limit', 'not_configured', 'bad_request', 'unavailable'];

async function authHeaders(): Promise<Record<string, string>> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('غير مصرح. يرجى تسجيل الدخول مرة أخرى.');
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

/* ------------------------------------------------------------------ *
 * Listeners
 * ------------------------------------------------------------------ */

/**
 * The published week, for students.
 *
 * `undefined` means NOT YET KNOWN and `null` means confirmed absent, and the
 * difference is load-bearing. onSnapshot fires with exists() === false when the
 * document is simply not in the offline cache, so treating that as "nothing
 * published" would drop every student back to the raw image on a cold offline
 * launch. The fromCache guard keeps the state unknown instead.
 */
export function watchPublishedTimetable(
  stageId: string,
  onChange: (doc: StageTimetableDoc | null) => void,
): () => void {
  return onSnapshot(doc(db, 'timetables', stageId), (snap: DocumentSnapshot) => {
    // metadata BEFORE exists(): exists() is a type predicate, so reading a
    // field after `!snap.exists()` narrows the snapshot to `never`.
    if (snap.metadata.fromCache && !snap.exists()) return;
    onChange(snap.exists() ? ({ ...(snap.data() as StageTimetableDoc) }) : null);
  }, (error) => {
    handleFirestoreError(error, OperationType.GET, 'timetables');
  });
}

/** The working draft, for staff. Same fromCache reasoning as above. */
export function watchDraftTimetable(
  stageId: string,
  onChange: (doc: StageTimetableDoc | null) => void,
): () => void {
  return onSnapshot(doc(db, 'timetableDrafts', stageId), (snap: DocumentSnapshot) => {
    // metadata BEFORE exists(): exists() is a type predicate, so reading a
    // field after `!snap.exists()` narrows the snapshot to `never`.
    if (snap.metadata.fromCache && !snap.exists()) return;
    onChange(snap.exists() ? ({ ...(snap.data() as StageTimetableDoc) }) : null);
  }, (error) => {
    handleFirestoreError(error, OperationType.GET, 'timetableDrafts');
  });
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

/** Save the representative's corrections. Never awaited from a mount path - an
 *  unacknowledged write does not settle offline. */
export async function saveDraftSessions(
  stageId: string,
  sessions: TimetableSession[],
  uid: string,
): Promise<void> {
  await setDoc(doc(db, 'timetableDrafts', stageId), {
    stageId,
    sessions,
    status: 'draft',
    updatedAt: serverTimestamp(),
    updatedBy: uid,
  }, { merge: true });
}

/**
 * Push the draft to students.
 *
 * One batch across both documents, so a student can never observe a published
 * week that the draft has already moved past. `failureCount` is cleared here
 * too: a successful publish proves the pipeline works for this stage, so the
 * three-strike parse cap should not still be counting old failures.
 *
 * `currentVersion` is PASSED IN rather than read here. A `getDoc` on a document
 * that already has a live `onSnapshot` opens a second, one-shot target on the
 * same key, and overlapping targets on one document are what drive the watch
 * stream's pendingResponses counter negative - the SDK then dies on an internal
 * assertion ("Unexpected state", ve: -1) that surfaces nowhere near this line.
 * The caller is already watching this document, so it knows the version.
 */
export async function publishTimetable(
  stageId: string,
  draft: StageTimetableDoc,
  uid: string,
  currentVersion?: number,
): Promise<void> {
  const version = (Number(currentVersion) || 0) + 1;

  const batch = writeBatch(db);
  batch.set(doc(db, 'timetables', stageId), {
    stageId,
    sessions: draft.sessions || [],
    sourcePhotoUrl: draft.sourcePhotoUrl || '',
    weekLabel: draft.weekLabel || '',
    publishedAt: serverTimestamp(),
    publishedBy: uid,
    updatedAt: serverTimestamp(),
    updatedBy: uid,
    version,
  });
  batch.set(doc(db, 'timetableDrafts', stageId), {
    lastPublishedAt: serverTimestamp(),
    publishedVersion: version,
    failureCount: 0,
  }, { merge: true });
  await batch.commit();
}


/** Take the week down. Students fall back to the original image through exactly
 *  the same path as "never published", so there is no third state to render. */
export async function unpublishTimetable(stageId: string): Promise<void> {
  await deleteDoc(doc(db, 'timetables', stageId));
}

/* ------------------------------------------------------------------ *
 * The one server call
 * ------------------------------------------------------------------ */

export interface ParseResult {
  ok: true;
  count: number;
  dropped: number;
  truncated: number;
  droppedLabels: string[];
}

/**
 * Ask the server to read this stage's timetable image.
 *
 * `stageId` is a hint, not an instruction: the route forces a representative to
 * their own managedStageId and ignores whatever is sent. It is passed so a
 * master admin or a support account - the two roles that legitimately act
 * across stages - parse the stage they are actually looking at.
 */
export async function requestTimetableParse(stageId: string): Promise<ParseResult> {
  const res = await fetch(apiUrl('/api/timetable/parse'), {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ stageId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = data?.error || 'request_failed';
    if (PROVIDER_CODES.includes(code)) throw new TimetableUnavailableError(code);
    throw new Error(code);
  }
  return data as ParseResult;
}
