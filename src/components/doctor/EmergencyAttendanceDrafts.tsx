import { useEffect, useState } from 'react';
import { listDoctorAttendanceCommands, reviseEmergencyAttendanceDraft, saveEmergencyAttendanceDraft,
  subscribeAttendanceChanges, type DoctorAttendanceCommand } from '../../services/attendanceService';
import type { EmergencyAttendanceInput } from '../../../shared/attendanceEmergency';

export default function EmergencyAttendanceDrafts({ ownerUid, stageId, isRtl }: { ownerUid: string; stageId: string; isRtl: boolean }) {
  const [drafts, setDrafts] = useState<DoctorAttendanceCommand[]>([]);
  const [editing, setEditing] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState<EmergencyAttendanceInput>({ stageId, lectureTitle: '', lectureDate: '', startTime: '', studentIdentifier: '', reason: '', physicalHeadcount: null });
  useEffect(() => {
    let live = true;
    const load = () => { void listDoctorAttendanceCommands(ownerUid).then(items => {
      if (live) setDrafts(items.filter(item => item.kind === 'emergency_draft' && item.status !== 'synced'));
    }).catch(() => undefined); };
    load();
    const stop = subscribeAttendanceChanges(load);
    return () => { live = false; stop(); };
  }, [ownerUid]);
  const save = async () => {
    setBusy(true); setError('');
    try {
      if (editing) await reviseEmergencyAttendanceDraft(ownerUid, editing, form);
      else await saveEmergencyAttendanceDraft(ownerUid, form);
      setEditing('');
      setForm({ stageId, lectureTitle: form.lectureTitle, lectureDate: form.lectureDate,
        startTime: form.startTime, studentIdentifier: '', reason: '', physicalHeadcount: null });
    } catch (failure) { setError(String((failure as Error)?.message || failure)); }
    finally { setBusy(false); }
  };
  return <details className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100" dir={isRtl ? 'rtl' : 'ltr'}>
    <summary className="cursor-pointer font-black">{isRtl ? 'مسودة حضور يدوية للطوارئ' : 'Emergency manual attendance draft'}{drafts.length ? ` (${drafts.length})` : ''}</summary>
    <p className="mt-2 text-xs">{isRtl ? 'تُحفظ على هذا الجهاز. المطابقة المؤكدة مع محاضرة وطالب واحد فقط تُرسل عند عودة الاتصال؛ غير الواضح يبقى للمراجعة.' : 'Saved on this device. Exact unique lecture and student matches sync on reconnect; ambiguous entries stay for review.'}</p>
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      <input aria-label={isRtl ? 'اسم المحاضرة' : 'Lecture title'} placeholder={isRtl ? 'اسم المحاضرة' : 'Lecture title'} value={form.lectureTitle} onChange={event => setForm({ ...form, lectureTitle: event.target.value })} className="rounded-lg border p-2 text-slate-900" />
      <input type="date" aria-label={isRtl ? 'تاريخ المحاضرة' : 'Lecture date'} value={form.lectureDate} onChange={event => setForm({ ...form, lectureDate: event.target.value })} className="rounded-lg border p-2 text-slate-900" />
      <input type="time" aria-label={isRtl ? 'وقت بداية المحاضرة' : 'Lecture start time'} value={form.startTime} onChange={event => setForm({ ...form, startTime: event.target.value })} className="rounded-lg border p-2 text-slate-900" />
      <input type="number" min={0} max={10000} aria-label={isRtl ? 'العدد الفعلي في القاعة' : 'Physical headcount'} placeholder={isRtl ? 'العدد الفعلي (اختياري)' : 'Physical headcount (optional)'} value={form.physicalHeadcount ?? ''} onChange={event => setForm({ ...form, physicalHeadcount: event.target.value ? Number(event.target.value) : null })} className="rounded-lg border p-2 text-slate-900" />
      <input aria-label={isRtl ? 'رقم الطالب أو اسمه' : 'Student number or name'} placeholder={isRtl ? 'رقم الطالب أو اسمه (اختياري)' : 'Student number or name (optional)'} value={form.studentIdentifier || ''} onChange={event => setForm({ ...form, studentIdentifier: event.target.value })} className="rounded-lg border p-2 text-slate-900" />
      <input aria-label={isRtl ? 'سبب التسجيل اليدوي' : 'Manual attendance reason'} placeholder={isRtl ? 'سبب التسجيل اليدوي' : 'Manual attendance reason'} value={form.reason || ''} onChange={event => setForm({ ...form, reason: event.target.value })} className="rounded-lg border p-2 text-slate-900" />
    </div>
    <button disabled={busy} onClick={() => void save()} className="mt-3 rounded-lg bg-amber-700 px-4 py-2 font-bold text-white disabled:opacity-50">{editing ? (isRtl ? 'حفظ التصحيح' : 'Save correction') : (isRtl ? 'حفظ محلياً' : 'Save locally')}</button>
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
    {drafts.map(item => <div key={item.requestId} className="mt-3 rounded-lg border border-amber-300 bg-white/70 p-2 dark:bg-zinc-900/60">
      <p className="font-bold">{String(item.input.lectureTitle)} · {String(item.input.lectureDate)} · {String(item.input.studentIdentifier || (isRtl ? 'العدد فقط' : 'Headcount only'))}</p>
      <p className="text-xs">{item.status === 'pending' ? (isRtl ? 'بانتظار المزامنة' : 'Waiting to sync') : `${isRtl ? 'تحتاج مراجعة' : 'Needs review'}: ${item.reason || ''}`}</p>
      {item.status === 'needs_help' && ['emergency_occurrence_ambiguous', 'emergency_student_ambiguous'].includes(item.reason || '') &&
        <button className="mt-1 text-xs font-bold underline" onClick={() => { setEditing(item.requestId); setForm(item.input as unknown as EmergencyAttendanceInput); }}>
          {isRtl ? 'تصحيح البيانات' : 'Correct details'}
        </button>}
    </div>)}
  </details>;
}
