import React, { useEffect, useRef, useState } from 'react';
import { X, GraduationCap, Sparkles, CheckCircle2, ShieldAlert, UserPlus, BookOpen } from 'lucide-react';
import type { Stage } from '../../types';
import type { AttendanceDoctorSubject } from '../../../shared/attendance';
import { attendanceApiRequest } from '../../services/attendanceService';
import { secureRequestId } from '../../lib/secureRandom';
import { createLatestDoctorListRefresher } from './doctorAccountList';

type Options = {
  subjects: Array<{ id: string; nameAr: string; nameEn: string; types?: Array<'theoretical' | 'practical'> }>;
  sessions: Array<{ id: string; title: string; kind: string; day: number; start: string; groups: string[] }>;
};

type Doctor = {
  uid: string;
  name: string;
  email: string;
  stageId: string;
  enabled: boolean;
};

export default function DoctorAccountProvisionModal({
  stages,
  isRtl,
  onClose,
}: {
  stages: Stage[];
  isRtl: boolean;
  onClose: () => void;
}) {
  const [stageId, setStageId] = useState(stages[0]?.id || '');
  const [options, setOptions] = useState<Options>({ subjects: [], sessions: [] });
  const [subjects, setSubjects] = useState<AttendanceDoctorSubject[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' | 'info' } | null>(null);
  const pending = useRef<{ fingerprint: string; id: string } | null>(null);
  const listRefresher = useRef<ReturnType<typeof createLatestDoctorListRefresher<Doctor>> | null>(null);
  if (!listRefresher.current) {
    listRefresher.current = createLatestDoctorListRefresher(
      () => attendanceApiRequest<{ doctors: Doctor[]; truncated: boolean }>('/api/attendance/admin/doctors'),
      result => setDoctors(result.doctors),
    );
  }
  useEffect(() => { if (!stageId && stages[0]?.id) setStageId(stages[0].id); }, [stageId, stages]);

  const refresh = async () => {
    const result = await listRefresher.current!();
    if (result.applied && result.truncated) {
      setMessage({
        text: isRtl ? 'تعرض أول ٢٠٠ حساب فقط.' : 'Showing the first 200 accounts.',
        type: 'info',
      });
    }
    return result;
  };

  useEffect(() => {
    void refresh().catch(() => {
      setMessage({
        text: isRtl ? 'تعذر تحميل قائمة الحسابات حالياً.' : 'Could not load accounts list.',
        type: 'error',
      });
    });
  }, []);

  useEffect(() => {
    let active = true;
    setSubjects([]);
    setOptions({ subjects: [], sessions: [] });
    if (!stageId) return () => { active = false; };
    void attendanceApiRequest<Options>(`/api/attendance/admin/doctors/options?stageId=${encodeURIComponent(stageId)}`)
      .then((data) => {
        if (active) setOptions(data);
      })
      .catch(() => {
        if (active) {
          setMessage({
            text: isRtl ? 'تعذر تحميل مواد المرحلة المحددة.' : 'Could not load stage assignments.',
            type: 'error',
          });
        }
      });
    return () => {
      active = false;
    };
  }, [stageId]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const fingerprint = JSON.stringify({ name, email, stageId, subjects });
    if (pending.current?.fingerprint !== fingerprint) {
      pending.current = { fingerprint, id: secureRequestId() };
    }

    try {
      const created = await attendanceApiRequest<{ uid: string }>('/api/attendance/admin/doctors', {
        method: 'POST',
        body: JSON.stringify({ name, email, password, stageId, subjects, requestId: pending.current.id }),
      });
      setPassword('');
      setName('');
      setEmail('');
      pending.current = null;
      try {
        const refreshed = await refresh();
        const visible = refreshed.applied && refreshed.doctors.some(doctor => doctor.uid === created.uid);
        setMessage(visible ? {
          text: isRtl
            ? 'تم إنشاء حساب الأستاذ بنجاح. سلّم كلمة المرور للأستاذ بشكل آمن.'
            : 'Lecturer account created. Deliver the initial password securely.',
          type: 'success',
        } : {
          text: isRtl
            ? 'تم إنشاء الحساب، لكن تعذر تأكيد ظهوره في القائمة. أغلق النافذة وافتحها مجدداً.'
            : 'The account was created, but its list entry could not be confirmed. Close and reopen this window.',
          type: 'info',
        });
      } catch {
        setMessage({
          text: isRtl
            ? 'تم إنشاء الحساب، لكن تعذر تحديث القائمة. أغلق النافذة وافتحها مجدداً.'
            : 'The account was created, but the list could not be refreshed. Close and reopen this window.',
          type: 'info',
        });
      }
    } catch (failure) {
      setMessage({
        text: failure instanceof Error ? failure.message : 'Account creation failed; retry with the same form.',
        type: 'error',
      });
    } finally {
      setBusy(false);
    }
  };

  const field =
    'w-full rounded-2xl border border-slate-200 bg-slate-50 p-3.5 text-sm text-slate-800 placeholder-slate-400 focus:border-teal-500 focus:bg-white focus:outline-none focus:ring-4 focus:ring-teal-500/10 dark:border-zinc-700 dark:bg-zinc-800/80 dark:text-zinc-100 dark:placeholder-zinc-500 dark:focus:border-teal-400 dark:focus:bg-zinc-800 transition-all font-medium';

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" dir={isRtl ? 'rtl' : 'ltr'}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={isRtl ? 'حسابات التدريسيين' : 'Lecturer accounts'}
        className="max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-3xl border border-slate-100 bg-white p-6 text-slate-900 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900 dark:text-white"
      >
        {/* Header */}
        <div className="mb-6 flex items-center justify-between border-b border-slate-100 pb-4 dark:border-zinc-800">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-teal-50 text-teal-600 shadow-sm dark:bg-teal-950/40 dark:text-teal-400">
              <GraduationCap className="h-6 w-6" />
            </div>
            <div>
              <h2 className="text-lg font-black text-slate-900 dark:text-zinc-100">
                {isRtl ? 'إدارة حسابات التدريسيين' : 'Manage Lecturer Accounts'}
              </h2>
              <p className="text-xs text-slate-500 dark:text-zinc-400">
                {isRtl ? 'إنشاء حسابات التدريسيين وتعيين المواد وحصص الحضور' : 'Provision lecturer accounts & assign timetable sessions'}
              </p>
            </div>
          </div>
          <button
            disabled={busy}
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Provision Form */}
        <form onSubmit={submit} className="space-y-4">
          <fieldset disabled={busy} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="mb-1.5 block text-xs font-black text-slate-700 dark:text-zinc-300">
                  {isRtl ? 'اسم الأستاذ الرسمي' : 'Official Lecturer Name'}
                </label>
                <input
                  className={field}
                  required
                  minLength={3}
                  maxLength={150}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={isRtl ? 'مثال: أ.د. حيدر كاظم' : 'e.g. Prof. Haider Kadhim'}
                />
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-black text-slate-700 dark:text-zinc-300">
                  {isRtl ? 'البريد الإلكتروني الجامعي' : 'Institutional Email'}
                </label>
                <input
                  className={field}
                  required
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="haider.k@alsafwa.edu.iq"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="mb-1.5 block text-xs font-black text-slate-700 dark:text-zinc-300">
                  {isRtl ? 'كلمة المرور الأولية' : 'Initial Password'}
                </label>
                <input
                  className={field}
                  required
                  type="password"
                  minLength={12}
                  maxLength={128}
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={isRtl ? '١٢ رمزاً على الأقل' : 'At least 12 characters'}
                />
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-black text-slate-700 dark:text-zinc-300">
                  {isRtl ? 'المرحلة الدراسية المعينة' : 'Assigned Academic Stage'}
                </label>
                <select
                  className={field}
                  value={stageId}
                  onChange={(event) => setStageId(event.target.value)}
                >
                  {stages.map((stage) => (
                    <option key={stage.id} value={stage.id}>
                      {isRtl ? stage.nameAr : stage.nameEn}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Subject Assignment Block */}
            <div className="rounded-2xl border border-slate-200/80 bg-slate-50/60 p-4 dark:border-zinc-800 dark:bg-zinc-800/40 space-y-3">
              <div className="flex items-center gap-2">
                <BookOpen className="h-4 w-4 text-teal-600 dark:text-teal-400" />
                <span className="text-xs font-black text-slate-800 dark:text-zinc-200">
                  {isRtl ? 'المواد المعينة (مادة أو مادتين كحد أقصى)' : 'Assigned Subjects (1 or 2 maximum)'}
                </span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-zinc-400">
                {isRtl
                  ? 'اختر المواد التي يُدرّسها الأستاذ في هذه المرحلة، مع تحديد نوع المحاضرة وحصص الجدول.'
                  : 'Select subjects taught by this lecturer, including mode and timetable slots.'}
              </p>

              <div className="space-y-2.5 pt-1">
                {options.subjects.map((subject) => {
                  const assigned = subjects.find((item) => item.id === subject.id);
                  return (
                    <div
                      key={subject.id}
                      className={`rounded-2xl border p-3.5 transition-colors ${
                        assigned
                          ? 'border-teal-300 bg-teal-50/50 dark:border-teal-800 dark:bg-teal-950/20'
                          : 'border-slate-200 bg-white dark:border-zinc-700/80 dark:bg-zinc-850'
                      }`}
                    >
                      <label className="flex items-center gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded text-teal-600 focus:ring-teal-500"
                          checked={!!assigned}
                          disabled={!assigned && subjects.length >= 2}
                          onChange={() =>
                            setSubjects((current) =>
                              assigned
                                ? current.filter((item) => item.id !== subject.id)
                                : [...current, { ...subject, type: subject.types?.length === 1 ? subject.types[0] : 'both', timetableSessionIds: [] }]
                            )
                          }
                        />
                        <span className="text-xs font-bold text-slate-900 dark:text-zinc-100">
                          {isRtl ? subject.nameAr : subject.nameEn}
                        </span>
                      </label>

                      {assigned && (
                        <div className="mt-3 ps-7 space-y-3">
                          <select
                            className={field}
                            value={assigned.type}
                            onChange={(event) =>
                              setSubjects((current) =>
                                current.map((item) =>
                                  item.id === subject.id
                                    ? {
                                        ...item,
                                        type: event.target.value as AttendanceDoctorSubject['type'],
                                        timetableSessionIds: [],
                                      }
                                    : item
                                )
                              )
                            }
                          >
                            <option value="both" disabled={!!subject.types?.length && subject.types.length < 2}>{isRtl ? 'نظري وعملي' : 'Theory & Practical'}</option>
                            <option value="theoretical" disabled={!!subject.types?.length && !subject.types.includes('theoretical')}>{isRtl ? 'نظري فقط' : 'Theory only'}</option>
                            <option value="practical" disabled={!!subject.types?.length && !subject.types.includes('practical')}>{isRtl ? 'عملي فقط' : 'Practical only'}</option>
                          </select>

                          {options.sessions
                            .filter(
                              (session) =>
                                (assigned.type === 'both' || session.kind === (assigned.type === 'theoretical' ? 'theory' : 'practical'))
                                && (!subject.types?.length || subject.types.includes(session.kind === 'theory' ? 'theoretical' : 'practical'))
                            )
                            .map((session) => (
                              <label
                                key={session.id}
                                className="flex items-center gap-2 text-xs text-slate-700 dark:text-zinc-300 cursor-pointer"
                              >
                                <input
                                  type="checkbox"
                                  className="h-3.5 w-3.5 rounded text-teal-600"
                                  checked={assigned.timetableSessionIds.includes(session.id)}
                                  disabled={subjects.some(
                                    (item) => item.id !== subject.id && item.timetableSessionIds.includes(session.id)
                                  )}
                                  onChange={() =>
                                    setSubjects((current) =>
                                      current.map((item) =>
                                        item.id !== subject.id
                                          ? item
                                          : {
                                              ...item,
                                              timetableSessionIds: item.timetableSessionIds.includes(session.id)
                                                ? item.timetableSessionIds.filter((id) => id !== session.id)
                                                : [...item.timetableSessionIds, session.id],
                                            }
                                      )
                                    )
                                  }
                                />
                                <span>
                                  {session.title} — {session.day} / {session.start} — ({(session.groups || []).join(', ')})
                                </span>
                              </label>
                            ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <button
              disabled={!stageId || !subjects.length || subjects.some((subject) => !subject.timetableSessionIds.length) || busy}
              className="w-full rounded-2xl bg-gradient-to-r from-teal-600 to-emerald-600 hover:from-teal-500 hover:to-emerald-500 p-3.5 font-black text-white shadow-lg shadow-teal-700/20 disabled:opacity-50 transition-all cursor-pointer flex items-center justify-center gap-2"
            >
              <UserPlus className="h-4 w-4" />
              <span>{busy ? '…' : isRtl ? 'إنشاء وتفعيل حساب الأستاذ' : 'Create & Activate Lecturer Account'}</span>
            </button>
          </fieldset>
        </form>

        {/* Status Message */}
        {message && (
          <div
            role="status"
            className={`my-4 flex items-center gap-2 rounded-2xl p-3.5 text-xs font-bold ${
              message.type === 'success'
                ? 'bg-emerald-50 text-emerald-800 border border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800/60'
                : message.type === 'error'
                ? 'bg-rose-50 text-rose-800 border border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800/60'
                : 'bg-amber-50 text-amber-800 border border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800/60'
            }`}
          >
            {message.type === 'success' ? (
              <CheckCircle2 className="h-4 w-4 shrink-0" />
            ) : (
              <ShieldAlert className="h-4 w-4 shrink-0" />
            )}
            <span>{message.text}</span>
          </div>
        )}

        {/* Existing Provisioned Doctors List */}
        <div className="mt-6 border-t border-slate-100 pt-5 dark:border-zinc-800">
          <h3 className="mb-3 text-xs font-black uppercase tracking-wider text-slate-400">
            {isRtl ? 'الحسابات المنشأة حالياً' : 'Provisioned Lecturer Accounts'} ({doctors.length})
          </h3>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {doctors.map((doctor) => (
              <div
                key={doctor.uid}
                className="flex items-center justify-between gap-3 rounded-2xl border border-slate-100 bg-slate-50/50 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-800/50"
              >
                <div>
                  <strong className="block font-black text-slate-900 dark:text-zinc-100">{doctor.name}</strong>
                  <p dir="ltr" className="text-slate-500 font-mono text-[11px]">
                    {doctor.email}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-block px-2 py-0.5 rounded-md font-bold text-[10px] ${
                      doctor.enabled
                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                        : 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
                    }`}
                  >
                    {doctor.enabled ? (isRtl ? 'مفعّل' : 'Active') : (isRtl ? 'معطل' : 'Disabled')}
                  </span>
                  <button
                    disabled={busy || !doctor.enabled}
                    className="text-xs font-bold text-rose-600 hover:text-rose-700 disabled:opacity-30 cursor-pointer"
                    onClick={async () => {
                      if (
                        !window.confirm(
                          isRtl ? 'تعطيل صلاحية الحضور لهذا الأستاذ؟' : 'Disable this lecturer’s attendance access?'
                        )
                      )
                        return;
                      setBusy(true);
                      try {
                        await attendanceApiRequest(
                          `/api/attendance/admin/doctors/${encodeURIComponent(doctor.uid)}/disable`,
                          { method: 'POST' }
                        );
                        await refresh();
                      } catch {
                        setMessage({
                          text: isRtl ? 'تعذر إكمال التعطيل. أعد المحاولة.' : 'Could not finish disabling the account. Retry.',
                          type: 'error',
                        });
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {doctor.enabled ? (isRtl ? 'تعطيل' : 'Disable') : (isRtl ? 'معطل' : 'Disabled')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
