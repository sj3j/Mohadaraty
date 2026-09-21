import React, { useEffect, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { auth, db } from '../lib/firebase';
import { apiUrl } from '../lib/apiBase';
import { Loader2, UserPlus, Check, X, AlertCircle, Users } from 'lucide-react';
import { Language, UserProfile } from '../types';
import { isMasterAdmin } from '../lib/permissions';

interface SignupRequest {
  email: string;
  fullName: string;
  stageId: string;
  subgroup: string;
  examCode: string | null;
  noExamCode: boolean;
  status: string;
  /**
   * Students already in this stage whose folded name matches. A snapshot from
   * when the form was filled - the server re-checks at approval, because a
   * roster import can land in between.
   */
  possibleDuplicateOf?: string[];
}

/**
 * Pending signup requests, for the representative to approve or reject.
 *
 * Scoped to their own stage - the server enforces the same rule, so this is a
 * convenience filter rather than the boundary. Approving is what creates the
 * students record, and therefore what lets the applicant log in at all.
 */
export default function SignupRequestsQueue({ user, lang }: { user: UserProfile | null; lang: Language }) {
  const isRtl = lang === 'ar';
  const [requests, setRequests] = useState<SignupRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The request whose namesake warning is awaiting a deliberate override. */
  const [confirmDuplicate, setConfirmDuplicate] = useState<string | null>(null);

  const master = isMasterAdmin(user);
  const myStage = user?.managedStageId || user?.stageId || null;

  useEffect(() => {
    const base = collection(db, 'signup_requests');
    const q = master || !myStage
      ? query(base, where('status', '==', 'pending'))
      : query(base, where('status', '==', 'pending'), where('stageId', '==', myStage));

    const unsub = onSnapshot(q,
      snap => {
        setRequests(snap.docs.map(d => ({ email: d.id, ...(d.data() as any) })));
        setLoading(false);
      },
      err => {
        console.error('Failed to load signup requests:', err);
        setLoading(false);
      });
    return unsub;
  }, [master, myStage]);

  const review = async (email: string, approve: boolean, force = false) => {
    setBusy(email);
    setError(null);
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error('No auth token');
      const res = await fetch(apiUrl(`/api/admin/signup/${encodeURIComponent(email)}/${approve ? 'approve' : 'reject'}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(force ? { force: true } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Approving would create a second account for someone already enrolled
        // here. Not refused outright - two identical three-part names in one
        // cohort is possible - but it takes a deliberate second press.
        if (data?.code === 'DUPLICATE_NAME_IN_STAGE') {
          setConfirmDuplicate(email);
          return;
        }
        throw new Error(data?.error || 'Failed');
      }
      setConfirmDuplicate(null);
      // The snapshot listener drops it from the list once status changes.
    } catch (err: any) {
      setError(err.message || (isRtl ? 'فشل الإجراء' : 'Action failed'));
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-sky-500" /></div>;
  }

  if (requests.length === 0) {
    return (
      <div className="text-center py-8 px-4 rounded-2xl bg-slate-50 dark:bg-zinc-800/40 border border-slate-200 dark:border-zinc-700">
        <UserPlus className="w-8 h-8 text-slate-300 dark:text-zinc-600 mx-auto mb-2" />
        <p className="text-sm font-bold text-slate-500 dark:text-slate-400">
          {isRtl ? 'لا توجد طلبات معلّقة' : 'No pending requests'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/30 border border-red-100 dark:border-red-900/50 text-red-600 dark:text-red-400 rounded-xl flex items-center gap-2 text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" />{error}
        </div>
      )}

      {requests.map(r => (
        <div key={r.email} className="p-4 rounded-2xl bg-white dark:bg-zinc-900 border-2 border-slate-100 dark:border-zinc-800">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div className="min-w-0">
              <p className="font-black text-slate-900 dark:text-white truncate">{r.fullName}</p>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate" dir="ltr">{r.email}</p>
            </div>
            <span className="shrink-0 px-2.5 py-1 rounded-lg bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-300 text-xs font-black">
              {r.subgroup}
            </span>
          </div>

          <p className="text-xs font-bold text-slate-500 dark:text-slate-400 mb-3">
            {r.noExamCode
              ? (isRtl ? 'لا يملك رقماً امتحانياً بعد' : 'No exam code yet')
              : `${isRtl ? 'الرقم الامتحاني' : 'Exam code'}: ${r.examCode || '-'}`}
          </p>

          {(r.possibleDuplicateOf?.length || confirmDuplicate === r.email) && (
            <div className="mb-3 p-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
              <div className="flex items-start gap-2">
                <Users className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-xs font-black text-amber-800 dark:text-amber-300">
                    {isRtl
                      ? 'يوجد طالب بنفس الاسم في هذه المرحلة'
                      : 'A student with this name already exists in this stage'}
                  </p>
                  <p className="text-xs text-amber-700 dark:text-amber-400 mt-1 leading-relaxed">
                    {isRtl
                      ? 'إن كان هو نفس الشخص، ارفض الطلب واطلب منه ربط حسابه عبر زر Google في شاشة الدخول.'
                      : 'If this is the same person, reject the request and ask them to link their account with the Google button on the login screen.'}
                  </p>
                  {(r.possibleDuplicateOf || []).map(id => (
                    <p key={id} className="text-xs text-amber-700 dark:text-amber-400 mt-0.5 truncate" dir="ltr">{id}</p>
                  ))}
                  {confirmDuplicate === r.email && (
                    <button
                      onClick={() => review(r.email, true, true)}
                      disabled={busy === r.email}
                      className="mt-2 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white font-bold text-xs"
                    >
                      {isRtl ? 'شخص آخر — وافق على أي حال' : 'Different person — approve anyway'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => review(r.email, true)}
              disabled={busy === r.email}
              className="flex-1 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold text-sm flex items-center justify-center gap-1.5"
            >
              {busy === r.email ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              {isRtl ? 'قبول' : 'Approve'}
            </button>
            <button
              onClick={() => review(r.email, false)}
              disabled={busy === r.email}
              className="flex-1 py-2.5 rounded-xl bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-slate-300 disabled:opacity-50 font-bold text-sm flex items-center justify-center gap-1.5"
            >
              <X className="w-4 h-4" />
              {isRtl ? 'رفض' : 'Reject'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
