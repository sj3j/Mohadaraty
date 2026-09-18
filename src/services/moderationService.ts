import {
  addDoc, collection, doc, serverTimestamp, updateDoc, arrayUnion, arrayRemove,
} from 'firebase/firestore';
import { auth, db } from '../lib/firebase';

/**
 * User-facing moderation: reporting a message, and blocking a sender.
 *
 * Both stores require these for any app carrying user-generated content -
 * Apple Guideline 1.2 wants reporting, blocking, a stated moderation method and
 * a way to eject an abusive user; Play's UGC policy wants an in-app reporting
 * path. The app already had the enforcement half (admin delete, mute, the
 * anti-cheat dashboard) but nothing a student could actually use.
 *
 * STATE OF PLAY AFTER THE CHAT WAS REMOVED
 *
 * Blocking is still live: Settings -> Blocked users lists and reverses it, and
 * `blockedUsers` is still validated by firestore.rules.
 *
 * `reportMessage()` and `filterBlocked()` have NO CALLER. The chat's report
 * sheet was the only one, and it went with the chat - so as things stand there
 * is no in-app reporting path at all. They are kept rather than deleted because
 * whatever takes the chat's place will need exactly this, and because
 * `content_reports` still holds the reports already filed. If a store reviewer
 * raises 1.2 before then, the answer is a report button on announcements, not a
 * restored chat.
 *
 * Blocking is stored on the blocker's own user document and applied on read.
 * Deliberately NOT symmetric and not enforced server-side: hiding someone's
 * messages from you is a display preference, and a rule that let one student
 * suppress another's writes would be a griefing tool.
 */

export type ReportReason = 'spam' | 'harassment' | 'inappropriate' | 'cheating' | 'other';

export const REPORT_REASONS: { id: ReportReason; ar: string; en: string }[] = [
  { id: 'spam',          ar: 'إزعاج أو تكرار',        en: 'Spam or flooding' },
  { id: 'harassment',    ar: 'إساءة أو تنمّر',         en: 'Harassment or bullying' },
  { id: 'inappropriate', ar: 'محتوى غير لائق',        en: 'Inappropriate content' },
  { id: 'cheating',      ar: 'غش أو تسريب امتحان',    en: 'Cheating or exam leak' },
  { id: 'other',         ar: 'سبب آخر',               en: 'Something else' },
];

export interface ReportInput {
  messageId: string;
  /** Snapshotted, because the message may be deleted before a moderator looks. */
  messageText: string;
  reportedUserId?: string | null;
  reportedUserName?: string | null;
  /** Where the reported content lives, for a moderator following it up. */
  contentPath?: string;
  reason: ReportReason;
  note?: string;
}

/** Files a report for moderators. Never throws to the caller silently. */
export async function reportMessage(input: ReportInput): Promise<void> {
  const me = auth.currentUser;
  if (!me) throw new Error('Not signed in');

  await addDoc(collection(db, 'content_reports'), {
    ...input,
    // Copied at report time so a deleted message can still be reviewed.
    messageText: (input.messageText || '').slice(0, 2000),
    note: (input.note || '').slice(0, 1000),
    reporterId: me.uid,
    reporterEmail: me.email || '',
    status: 'open',
    createdAt: serverTimestamp(),
  });
}

export async function blockUser(targetUserId: string): Promise<void> {
  const me = auth.currentUser;
  if (!me) throw new Error('Not signed in');
  if (targetUserId === me.uid) throw new Error('Cannot block yourself');
  await updateDoc(doc(db, 'users', me.uid), { blockedUsers: arrayUnion(targetUserId) });
}

export async function unblockUser(targetUserId: string): Promise<void> {
  const me = auth.currentUser;
  if (!me) throw new Error('Not signed in');
  await updateDoc(doc(db, 'users', me.uid), { blockedUsers: arrayRemove(targetUserId) });
}

/** Hide messages from anyone the viewer has blocked. */
export function filterBlocked<T extends { senderId?: string }>(
  messages: T[],
  blocked?: string[] | null,
): T[] {
  if (!blocked || blocked.length === 0) return messages;
  const set = new Set(blocked);
  return messages.filter(m => !m.senderId || !set.has(m.senderId));
}
