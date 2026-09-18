import React, { useEffect, useState } from 'react';
import { auth } from '../lib/firebase';
import { apiUrl } from '../lib/apiBase';
import { Loader2, Trash2, AlertTriangle, UserX, Check } from 'lucide-react';
import { Language } from '../types';
import { logAdminAction } from '../services/adminLogService';

/**
 * Pending account-deletion requests for the representative's own stage.
 *
 * Approving is irreversible and does more than it looks: it deletes the
 * student's sign-in identity, profile, push token and quiz history, and strips
 * every credential from the roster record.
 * shared/accountDeletion.ts is the authority on exactly what goes.
 *
 * The queue is served by the API rather than read from Firestore, because the
 * same route is what re-checks the stage boundary - the Admin SDK that carries
 * out the purge bypasses firestore.rules entirely.
 */

interface PendingRequest {
  id: string;
  uid: string;
  studentId: string;
  name: string;
  stageId: string | null;
  reason: string;
}

export default function DeletionRequestsQueue({ lang }: { lang: Language }) {
  const isRtl = lang === 'ar';
  const [requests, setRequests] = useState<PendingRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const authed = async (path: string, init: RequestInit = {}) => {
    const token = await auth.currentUser?.getIdToken();
    const res = await fetch(apiUrl(path), {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...(init.headers || {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  };

  const load = async () => {
    setLoading(true);
    try {
      const data = await authed('/api/admin/deletion-requests');
      setRequests(data.requests || []);
    } catch (err: any) {
      console.error('Failed to load deletion requests:', err);
      setError(err.message || (isRtl ? 'تعذّر تحميل الطلبات' : 'Could not load requests'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const review = async (req: PendingRequest, approve: boolean) => {
    setBusyId(req.id);
    setError(null);
    try {
      await authed(`/api/admin/deletion-requests/${encodeURIComponent(req.uid)}/${approve ? 'approve' : 'reject'}`,
        { method: 'POST', body: JSON.stringify({}) });
      await logAdminAction(
        approve ? 'APPROVE_ACCOUNT_DELETION' : 'REJECT_ACCOUNT_DELETION',
        `stage=${req.stageId || '-'} student=${req.studentId}`);
      setConfirmId(null);
      await load();
    } catch (err: any) {
      console.error('Failed to review deletion request:', err);
      setError(err.message || (isRtl ? 'تعذّر تنفيذ الطلب' : 'Could not complete the request'));
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-sm font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2">
        {isRtl ? 'طلبات حذف الحسابات' : 'Account deletion requests'}
      </h3>

      {error && (
        <div className="mb-3 p-3 bg-rose-50 dark:bg-rose-900/20 text-rose-600 dark:text-rose-400 rounded-xl text-xs font-bold flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {requests.length === 0 ? (
        <div className="p-6 text-center bg-slate-50 dark:bg-zinc-900 rounded-2xl">
          <UserX className="w-8 h-8 text-slate-300 mx-auto mb-2" />
          <p className="text-xs font-bold text-slate-400">
            {isRtl ? 'لا توجد طلبات حذف' : 'No deletion requests'}
          </p>
        </div>
      ) : (
        <div className="border border-slate-200 dark:border-zinc-800 rounded-2xl overflow-hidden divide-y divide-slate-100 dark:divide-zinc-800">
          {requests.map(req => (
            <div key={req.id} className="p-3">
              <div className="font-bold text-sm text-slate-800 dark:text-slate-100 truncate">
                {req.name || req.studentId}
              </div>
              {req.reason && (
                <p className="text-[11px] font-bold text-slate-400 mt-0.5 break-words">{req.reason}</p>
              )}

              {confirmId === req.id ? (
                <div className="mt-2.5 p-2.5 bg-rose-50 dark:bg-rose-900/20 rounded-xl">
                  <p className="text-[11px] font-bold text-rose-700 dark:text-rose-400 leading-snug mb-2">
                    {isRtl
                      ? 'سيُحذف الحساب نهائياً ولا يمكن التراجع. تبقى الدرجات وسجل القيد.'
                      : 'The account is deleted permanently and cannot be restored. Grades and the enrolment record remain.'}
                  </p>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => review(req, true)}
                      disabled={busyId === req.id}
                      className="flex-1 py-2 rounded-lg text-[11px] font-black bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50 flex items-center justify-center gap-1.5"
                    >
                      {busyId === req.id
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <Trash2 className="w-3.5 h-3.5" />}
                      {isRtl ? 'تأكيد الحذف' : 'Confirm deletion'}
                    </button>
                    <button
                      onClick={() => setConfirmId(null)}
                      disabled={busyId === req.id}
                      className="flex-1 py-2 rounded-lg text-[11px] font-black bg-white dark:bg-zinc-800 text-slate-500 disabled:opacity-50"
                    >
                      {isRtl ? 'رجوع' : 'Back'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-2 flex gap-1.5">
                  <button
                    onClick={() => setConfirmId(req.id)}
                    disabled={busyId === req.id}
                    className="px-3 py-1.5 rounded-lg text-[11px] font-black text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-900/20 hover:bg-rose-100 disabled:opacity-50"
                  >
                    {isRtl ? 'حذف الحساب' : 'Delete account'}
                  </button>
                  <button
                    onClick={() => review(req, false)}
                    disabled={busyId === req.id}
                    className="px-3 py-1.5 rounded-lg text-[11px] font-black text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 disabled:opacity-50 flex items-center gap-1.5"
                  >
                    {busyId === req.id
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : <Check className="w-3.5 h-3.5" />}
                    {isRtl ? 'رفض الطلب' : 'Reject'}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
