/**
 * Self-service signup, approved by the stage representative.
 *
 * A request deliberately creates NO usable account. Login is gated on
 * `students/{email}` existing and being active, so a pending request simply has
 * no student record and cannot get in. That gate is the security boundary; this
 * collection is only a queue.
 */
import { GroupConfigLike, FALLBACK_GROUP_CONFIG, isValidSubgroup, normalizeSubgroup } from './groups.js';
import { nameKeyFor } from './rosterIdentity.js';

export type SignupStatus = 'pending' | 'approved' | 'rejected';

export interface SignupInput {
  /** Three separate fields, not one string - see normalizeNamePart. */
  firstName: string;
  fatherName: string;
  grandfatherName: string;
  email: string;
  password: string;
  stageId: string;
  subgroup: string;
  examCode?: string;
  /** True when the student has not been issued a code for this year yet. */
  noExamCode?: boolean;
}

export class SignupError extends Error {
  constructor(message: string, readonly status = 400, readonly code?: string) {
    super(message);
  }
}

/**
 * Strips the characters that are invisible but still count as content.
 *
 * Tatweel (U+0640) is a decorative letter-stretcher and the zero-width joiners
 * (U+200C/U+200D) control ligatures - none carry meaning, and all three would
 * otherwise make a blank field look filled, or a name fail an equality check
 * against the same name typed without them.
 */
export function normalizeNamePart(raw: string): string {
  return (raw || '')
    .replace(/[ـ‌‍‎‏]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Why three fields rather than counting spaces in one:
 *
 * Arabic عبد-compounds are written open OR closed, so a token count is wrong in
 * both directions. "عبد الحسين محمد" is three tokens but only two names, and a
 * closed compound makes a genuine three-part name look short. Asking for the
 * parts separately removes the ambiguity instead of guessing at it, and matches
 * how the university records them.
 */
export function composeFullName(input: SignupInput): string {
  const parts = [input.firstName, input.fatherName, input.grandfatherName].map(normalizeNamePart);
  if (parts.some(p => p.length === 0)) {
    throw new SignupError('الاسم الثلاثي مطلوب', 400, 'NAME_INCOMPLETE');
  }
  return parts.join(' ');
}

/**
 * Students in the same stage whose folded name matches this applicant's.
 *
 * This is the ONLY duplicate signal used at signup, and it is deliberately a
 * weak one. The obvious candidate - examCode - is reissued every year, so the
 * same student carries a different code from one year to the next (which is why
 * this form offers "no code yet" at all, and why setOwnExamCode refuses to
 * overwrite a stored one: it is last year's until an admin changes it). Matching
 * on it would fail in BOTH directions - missing a real duplicate whose code has
 * rolled over, and refusing a genuine new student whose freshly issued code
 * collides with a stale one on somebody's old row. Nothing here matches, merges
 * or authenticates on examCode.
 *
 * A folded name is not unique either - resolveStudentLogin already has an
 * AMBIGUOUS_IDENTIFIER path for exactly that - so this never blocks the
 * applicant. It is recorded for the representative, who knows the cohort, and
 * enforced only at review time where a human is present to override it.
 *
 * Scoped to the stage: the same name in a different year is a different person's
 * problem, and cross-stage matching would flag every promoted namesake.
 */
export async function findNameDuplicates(
  db: FirebaseFirestore.Firestore,
  fullName: string,
  stageId: string,
): Promise<string[]> {
  const key = nameKeyFor(fullName);
  if (!key || !stageId) return [];

  const snap = await db.collection('students')
    .where('nameKey', '==', key).limit(20).get();

  return snap.docs
    .filter(d => {
      const data = d.data() || {};
      return data.stageId === stageId
        && data.isActive !== false
        && !(data.mergedInto || '').trim();
    })
    .map(d => d.id);
}

export interface PreparedSignup {
  email: string;
  fullName: string;
  stageId: string;
  subgroup: string;
  examCode: string | null;
  noExamCode: boolean;
}

/** Validates everything that does not need the database. */
export function validateSignup(input: SignupInput, groupConfig: GroupConfigLike): PreparedSignup {
  const fullName = composeFullName(input);

  const email = (input.email || '').toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new SignupError('صيغة البريد غير صحيحة', 400, 'BAD_EMAIL');
  }

  if (!input.password || input.password.length < 6) {
    throw new SignupError('كلمة المرور قصيرة جداً', 400, 'WEAK_PASSWORD');
  }

  const subgroup = normalizeSubgroup(input.subgroup);
  if (!subgroup || !isValidSubgroup(groupConfig || FALLBACK_GROUP_CONFIG, subgroup)) {
    throw new SignupError('الشعبة غير صحيحة لهذه المرحلة', 400, 'BAD_SUBGROUP');
  }

  const noExamCode = input.noExamCode === true;
  const examCode = noExamCode ? null : (input.examCode || '').trim() || null;
  if (!noExamCode && !examCode) {
    throw new SignupError('أدخل الرقم الامتحاني أو اختر «لا أملك رقماً»', 400, 'EXAM_CODE_REQUIRED');
  }

  return { email, fullName, stageId: input.stageId, subgroup, examCode, noExamCode };
}

/**
 * Files the request. Returns the document that was written.
 *
 * The password is hashed here and the plaintext is never persisted. Callers
 * must also avoid logging the request body - it carries the plaintext until
 * this runs.
 */
export async function createSignupRequest(
  db: FirebaseFirestore.Firestore,
  FieldValue: { serverTimestamp(): any; delete(): any },
  hashPassword: (plain: string) => Promise<string>,
  input: SignupInput,
): Promise<PreparedSignup> {
  const stageSnap = await db.collection('stages').doc(input.stageId || '').get();
  if (!stageSnap.exists) throw new SignupError('المرحلة غير موجودة', 400, 'BAD_STAGE');

  const groupConfig: GroupConfigLike =
    (stageSnap.data() as any)?.groupConfig || FALLBACK_GROUP_CONFIG;

  const prepared = validateSignup(input, groupConfig);

  // Already a student: they should log in, not sign up again.
  const existing = await db.collection('students').doc(prepared.email).get();
  if (existing.exists) {
    throw new SignupError('هذا البريد مسجّل بالفعل. سجّل الدخول.', 409, 'ALREADY_STUDENT');
  }

  // Only a PENDING request blocks a second attempt. A rejected applicant must
  // be able to correct their details and re-apply - keying the block on any
  // status at all would lock that email out permanently.
  const prior = await db.collection('signup_requests').doc(prepared.email).get();
  if (prior.exists && prior.data()?.status === 'pending') {
    throw new SignupError('طلبك قيد المراجعة من قبل ممثل المرحلة.', 409, 'ALREADY_PENDING');
  }

  // Recorded, never enforced here. A student blocked at this point has nowhere
  // to go - the claim step on the login screen is the path forward for someone
  // who already has an account, and a dead end is what produced the duplicates
  // in the first place.
  const possibleDuplicateOf = await findNameDuplicates(
    db, prepared.fullName, prepared.stageId);

  await db.collection('signup_requests').doc(prepared.email).set({
    ...prepared,
    possibleDuplicateOf,
    passwordHash: await hashPassword(input.password),
    status: 'pending' as SignupStatus,
    createdAt: FieldValue.serverTimestamp(),
    // expireAt is deliberately NOT set here. A TTL on a pending row would
    // silently delete a student who applied in July before a representative
    // works the queue in September. It is stamped on approve/reject instead.
    expireAt: FieldValue.delete(),
    reviewedAt: FieldValue.delete(),
    reviewedBy: FieldValue.delete(),
    rejectionReason: FieldValue.delete(),
  }, { merge: true });

  return prepared;
}

export interface ReviewResult {
  email: string;
  status: SignupStatus;
}

/** Approve -> creates the student record, which is what makes login possible. */
export async function reviewSignupRequest(
  db: FirebaseFirestore.Firestore,
  FieldValue: { serverTimestamp(): any; delete(): any },
  opts: {
    email: string;
    approve: boolean;
    reviewerUid: string;
    reviewerStageId?: string | null;
    isMasterAdmin: boolean;
    reason?: string;
    /**
     * Approve despite a namesake already enrolled in this stage. Two identical
     * three-part names in one cohort is possible, so this has to be available -
     * but it is a decision the reviewer makes, not a default.
     */
    force?: boolean;
    /** Days until a resolved row is purged by the Firestore TTL policy. */
    ttlDays?: number;
  },
): Promise<ReviewResult & { duplicateOf?: string[] }> {
  const email = (opts.email || '').toLowerCase().trim();
  const ref = db.collection('signup_requests').doc(email);
  const snap = await ref.get();
  if (!snap.exists) throw new SignupError('لا يوجد طلب بهذا البريد', 404, 'NOT_FOUND');

  const data = snap.data() as any;
  if (data.status !== 'pending') {
    throw new SignupError('تمت مراجعة هذا الطلب مسبقاً', 409, 'ALREADY_REVIEWED');
  }

  // A representative may only act on their own stage.
  if (!opts.isMasterAdmin && opts.reviewerStageId && data.stageId !== opts.reviewerStageId) {
    throw new SignupError('هذا الطلب يخص مرحلة أخرى', 403, 'WRONG_STAGE');
  }

  // Re-checked at approval, not trusted from the stored flag: a roster import or
  // another approval can land between filing and review, and the stored list is
  // a snapshot from whenever the student filled the form.
  let duplicateOf: string[] = [];
  if (opts.approve) {
    duplicateOf = (await findNameDuplicates(db, data.fullName, data.stageId))
      .filter(id => id !== email);
    if (duplicateOf.length > 0 && !opts.force) {
      throw new SignupError(
        'يوجد طالب بنفس الاسم في هذه المرحلة. تحقق قبل الموافقة.',
        409, 'DUPLICATE_NAME_IN_STAGE',
      );
    }
  }

  const expireAt = new Date();
  expireAt.setDate(expireAt.getDate() + (opts.ttlDays ?? 60));

  if (opts.approve) {
    await db.collection('students').doc(email).set({
      name: data.fullName,
      // Every path that writes `name` must write nameKey too - /api/login
      // queries it, and a student without one can only sign in by email.
      nameKey: nameKeyFor(data.fullName),
      email,
      password: data.passwordHash,
      examCode: data.examCode || '',
      isActive: true,
      stageId: data.stageId,
      subgroup: data.subgroup,
      createdAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  await ref.set({
    status: opts.approve ? 'approved' : 'rejected',
    reviewedAt: FieldValue.serverTimestamp(),
    reviewedBy: opts.reviewerUid,
    ...(opts.approve ? {} : { rejectionReason: (opts.reason || '').slice(0, 500) }),
    expireAt,
  }, { merge: true });

  return {
    email,
    status: opts.approve ? 'approved' : 'rejected',
    ...(duplicateOf.length > 0 ? { duplicateOf } : {}),
  };
}
