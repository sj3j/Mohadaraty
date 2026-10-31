import React, { useCallback, useEffect, useState } from 'react';
import { Laptop, Loader2, LogOut, MapPin, MonitorSmartphone, RefreshCw, Smartphone, Trash2 } from 'lucide-react';
import { Language } from '../../types';
import {
  listAccountSessions,
  AccountSession,
  terminateOtherAccountSessions,
  terminateAccountSession,
  isSessionRequiredError,
} from '../../services/accountSessionService';

interface Props {
  lang: Language;
  onLogout: () => void;
}

export default function DevicesSettings({ lang, onLogout }: Props) {
  const isRtl = lang === 'ar';
  const [sessions, setSessions] = useState<AccountSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [isLegacySession, setIsLegacySession] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setIsLegacySession(false);
    try {
      setSessions(await listAccountSessions());
    } catch (err) {
      if (isSessionRequiredError(err)) {
        setIsLegacySession(true);
      } else {
        setError(isRtl ? 'تعذر تحميل الجلسات. تحقق من الاتصال وحاول مجدداً.' : 'Could not load sessions. Check your connection and try again.');
      }
    } finally {
      setLoading(false);
    }
  }, [isRtl]);

  useEffect(() => {
    void load();
  }, [load]);

  const location = (session: AccountSession) => {
    const rawCountry = session.location?.country;
    if (rawCountry === 'Dev' || session.location?.city === 'Local Development') {
      return isRtl ? 'بيئة تطوير محلي' : 'Local Development';
    }
    let country = rawCountry;
    if (rawCountry && rawCountry !== 'Unknown' && rawCountry.length === 2) {
      try {
        country = new Intl.DisplayNames([isRtl ? 'ar-IQ' : 'en'], { type: 'region' }).of(rawCountry) || rawCountry;
      } catch {
        /* retain country code */
      }
    }
    const rawCity = session.location?.city;
    const parts = [rawCity, country].filter(v => v && v !== 'Unknown');
    return parts.length ? parts.join(', ') : (isRtl ? 'الموقع غير متاح' : 'Location unavailable');
  };

  const date = (value: string | null) => value
    ? new Intl.DateTimeFormat(isRtl ? 'ar-IQ' : 'en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Baghdad' }).format(new Date(value))
    : (isRtl ? 'غير معروف' : 'Unknown');

  const icon = (session: AccountSession) => session.device.kind === 'mobile' ? Smartphone
    : session.device.kind === 'desktop' ? Laptop : MonitorSmartphone;

  const terminate = async (session: AccountSession) => {
    const message = session.current
      ? (isRtl ? 'إنهاء هذه الجلسة سيسجل خروجك من هذا الجهاز. هل تريد المتابعة؟' : 'Terminating this session will sign you out on this device. Continue?')
      : (isRtl ? `إنهاء جلسة ${session.device.name}؟` : `Terminate the session on ${session.device.name}?`);
    if (!window.confirm(message)) return;
    setBusy(session.id);
    setError('');
    try {
      await terminateAccountSession(session.id);
      if (session.current) onLogout();
      else setSessions(current => current.filter(item => item.id !== session.id));
    } catch {
      setError(isRtl ? 'تعذر إنهاء الجلسة.' : 'Could not terminate the session.');
    } finally {
      setBusy(null);
    }
  };

  const terminateOthers = async () => {
    if (!window.confirm(isRtl ? 'إنهاء جميع الجلسات الأخرى مع إبقاء هذا الجهاز؟' : 'Terminate all other sessions and keep this device signed in?')) return;
    setBusy('others');
    setError('');
    try {
      await terminateOtherAccountSessions();
      setSessions(current => current.filter(item => item.current));
    } catch {
      setError(isRtl ? 'تعذر إنهاء الجلسات الأخرى.' : 'Could not terminate the other sessions.');
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return <div className="flex justify-center py-16"><Loader2 className="h-7 w-7 animate-spin text-teal-600" /></div>;
  }

  if (isLegacySession) {
    return (
      <div className="space-y-4 pb-10" dir={isRtl ? 'rtl' : 'ltr'}>
        <div className="rounded-2xl border border-amber-200 bg-amber-50/80 p-5 dark:border-amber-900/50 dark:bg-amber-950/20">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
              <MonitorSmartphone className="h-6 w-6" />
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <h3 className="font-bold text-slate-900 dark:text-zinc-100">
                {isRtl ? 'تسجيل الدخول مطلوب لإدارة الأجهزة' : 'Sign In Required for Device Management'}
              </h3>
              <p className="text-sm leading-relaxed text-slate-700 dark:text-zinc-300">
                تم تسجيل دخول هذا الحساب قبل تفعيل نظام إدارة الأجهزة. يرجى تسجيل الخروج ثم تسجيل الدخول مرة أخرى لإتاحة قائمة الأجهزة والجلسات المصرح لها.
              </p>
              <p className="text-xs leading-relaxed text-slate-500 dark:text-zinc-400">
                This account signed in prior to the device management update. Please sign out and sign in again to view and manage your authorized device inventory.
              </p>
            </div>
          </div>
          <button
            onClick={onLogout}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-teal-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-teal-700 transition-colors cursor-pointer"
          >
            <LogOut className="h-4 w-4" />
            <span>{isRtl ? 'تسجيل الخروج الآن' : 'Sign Out Now'}</span>
          </button>
        </div>
      </div>
    );
  }

  const current = sessions.find(item => item.current);
  const others = sessions.filter(item => !item.current);

  const card = (session: AccountSession) => {
    const DeviceIcon = icon(session);
    return (
      <div key={session.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300"><DeviceIcon className="h-6 w-6" /></div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-black text-slate-900 dark:text-white">{session.device.name}</h3>
              {session.current && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">{isRtl ? 'هذا الجهاز' : 'This device'}</span>}
            </div>
            <p className="mt-1 text-sm text-slate-600 dark:text-zinc-300">{session.device.browser} · {session.device.operatingSystem}</p>
            <p className="text-xs text-slate-500 dark:text-zinc-400">{isRtl ? 'إصدار التطبيق' : 'App version'} {session.device.appVersion} · {session.device.platform}</p>
            <p className="mt-2 flex items-center gap-1 text-xs text-slate-500 dark:text-zinc-400"><MapPin className="h-3.5 w-3.5" />{location(session)}</p>
            <p className="mt-1 text-xs text-slate-500 dark:text-zinc-400">{isRtl ? 'آخر نشاط' : 'Last active'}: {date(session.lastSeenAt)}</p>
            <p className="text-xs text-slate-500 dark:text-zinc-400">{isRtl ? 'تسجيل الدخول' : 'Signed in'}: {date(session.signedInAt)}</p>
          </div>
        </div>
        <button disabled={!!busy} onClick={() => void terminate(session)} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-rose-200 px-3 py-2 text-sm font-bold text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-900/50 dark:hover:bg-rose-950/30 cursor-pointer">
          {busy === session.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          {session.current ? (isRtl ? 'إنهاء هذه الجلسة' : 'Terminate this session') : (isRtl ? 'إنهاء الجلسة' : 'Terminate session')}
        </button>
      </div>
    );
  };

  return (
    <div className="space-y-5 pb-10">
      <p className="text-sm leading-6 text-slate-600 dark:text-zinc-300">
        {isRtl ? 'هذه هي الجلسات المصرّح لها بالدخول إلى حسابك. الموقع تقريبي ومبني على عنوان الشبكة.' : 'These sessions are authorized to access your account. Location is approximate and based on the network address.'}
      </p>
      {error && (
        <div className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-950/30 dark:text-rose-300">
          {error}
          <button onClick={() => void load()} className="ms-2 inline-flex items-center gap-1 font-bold cursor-pointer">
            <RefreshCw className="h-3.5 w-3.5" />
            {isRtl ? 'إعادة المحاولة' : 'Retry'}
          </button>
        </div>
      )}
      {current && (
        <section>
          <h2 className="mb-2 text-xs font-black uppercase tracking-wide text-slate-500">{isRtl ? 'هذا الجهاز' : 'This device'}</h2>
          {card(current)}
        </section>
      )}
      {others.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-xs font-black uppercase tracking-wide text-slate-500">{isRtl ? 'الجلسات الأخرى' : 'Other authorized sessions'}</h2>
            <button disabled={!!busy} onClick={() => void terminateOthers()} className="text-xs font-black text-rose-600 disabled:opacity-50 cursor-pointer">
              {busy === 'others' ? (isRtl ? 'جارٍ الإنهاء…' : 'Terminating…') : (isRtl ? 'إنهاء الكل' : 'Terminate all others')}
            </button>
          </div>
          {others.map(card)}
        </section>
      )}
      {!current && !error && (
        <p className="rounded-2xl border border-slate-200 p-4 text-sm text-slate-500 dark:border-zinc-800">
          {isRtl ? 'لا توجد جلسة مسجلة لهذا الجهاز. يرجى تسجيل الدخول مرة أخرى.' : 'This device has no registered session. Please sign in again.'}
        </p>
      )}
    </div>
  );
}
