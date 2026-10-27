import React, { useEffect, useState } from 'react';
import { doc, getDoc, getDocFromServer, serverTimestamp, setDoc } from 'firebase/firestore';
import { AlertTriangle, Loader2, Save } from 'lucide-react';
import { auth, db } from '../../lib/firebase';
import {
  DEFAULT_MOBILE_RELEASE_POLICY,
  normalizeMobileReleasePolicy,
  validateMobileReleasePolicy,
  type MobileReleasePlatform,
  type MobileReleasePolicy,
} from '../../lib/mobileReleasePolicy';
import { logAdminAction } from '../../services/adminLogService';
import type { Language } from '../../types';
import SettingsGroup from './SettingsGroup';
import SettingsRow from './SettingsRow';
import SettingsToggle from './SettingsToggle';
import { SETTINGS_ICONS } from '../../lib/settingsIcons';

function cloneDefault(): MobileReleasePolicy {
  return {
    ...DEFAULT_MOBILE_RELEASE_POLICY,
    android: { ...DEFAULT_MOBILE_RELEASE_POLICY.android },
    ios: { ...DEFAULT_MOBILE_RELEASE_POLICY.ios },
  };
}

export default function MobileReleaseSettings({ lang }: { lang: Language }) {
  const isRtl = lang === 'ar';
  const [draft, setDraft] = useState<MobileReleasePolicy>(cloneDefault);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const ref = doc(db, 'app_settings', 'mobileReleasePolicy');
      try {
        let snapshot;
        try {
          snapshot = await getDocFromServer(ref);
        } catch {
          snapshot = await getDoc(ref);
        }
        if (!cancelled) {
          setDraft(snapshot.exists() ? normalizeMobileReleasePolicy(snapshot.data()) : cloneDefault());
        }
      } catch (error) {
        console.error('[mobile-release] failed to load admin settings', error);
        if (!cancelled) {
          setMessage({
            kind: 'error',
            text: isRtl ? 'تعذر تحميل إعدادات التحديث.' : 'Could not load update settings.',
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [isRtl]);

  const updatePlatform = (
    platform: MobileReleasePlatform,
    patch: Partial<MobileReleasePolicy[MobileReleasePlatform]>,
  ) => {
    setDraft(current => ({
      ...current,
      [platform]: { ...current[platform], ...patch },
    }));
    setMessage(null);
  };

  const save = async () => {
    const errors = validateMobileReleasePolicy(draft);
    if (errors.length > 0) {
      const buildError = errors.some(error => error.endsWith('.minBuild'));
      setMessage({
        kind: 'error',
        text: buildError
          ? (isRtl ? 'يجب أن تكون أرقام البناء أعداداً صحيحة تبدأ من 1.' : 'Build numbers must be whole numbers starting at 1.')
          : (isRtl ? 'استخدم رابط Google Play لأندرويد ورابط App Store لـ iOS.' : 'Use a Google Play URL for Android and an App Store URL for iOS.'),
      });
      return;
    }

    const enabled = (['android', 'ios'] as const)
      .filter(platform => draft[platform].enabled)
      .map(platform => `${platform === 'android' ? 'Android' : 'iOS'} < ${draft[platform].minBuild}`);
    const summary = draft.enforcementEnabled
      ? (enabled.length > 0
        ? `${isRtl ? 'سيتم حظر الإصدارات التالية' : 'The following builds will be blocked'}:\n${enabled.join('\n')}`
        : (isRtl ? 'التفعيل العام يعمل، لكن لم يتم تفعيل أي منصة.' : 'Global enforcement is on, but neither platform is enabled.'))
      : (isRtl ? 'سيتم إيقاف حظر التحديث لجميع الطلاب.' : 'Forced updates will be paused for all students.');
    if (!window.confirm(`${summary}\n\n${isRtl ? 'حفظ هذه الإعدادات؟' : 'Save these settings?'}`)) return;

    setSaving(true);
    setMessage(null);
    try {
      await setDoc(doc(db, 'app_settings', 'mobileReleasePolicy'), {
        enforcementEnabled: draft.enforcementEnabled,
        android: draft.android,
        ios: draft.ios,
        updatedAt: serverTimestamp(),
        updatedBy: auth.currentUser?.email || auth.currentUser?.uid || 'unknown',
      }, { merge: false });
      await logAdminAction(
        'UPDATE_MOBILE_RELEASE_POLICY',
        `enforcement=${draft.enforcementEnabled}; android=${draft.android.enabled}/${draft.android.minBuild}; ios=${draft.ios.enabled}/${draft.ios.minBuild}`,
      );
      setMessage({ kind: 'success', text: isRtl ? 'تم حفظ سياسة التحديث.' : 'Update policy saved.' });
    } catch (error) {
      console.error('[mobile-release] failed to save policy', error);
      setMessage({ kind: 'error', text: isRtl ? 'فشل حفظ سياسة التحديث.' : 'Could not save the update policy.' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex justify-center py-16"><Loader2 className="h-7 w-7 animate-spin text-sky-500" /></div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
        <p className="text-sm font-semibold leading-6">
          {isRtl
            ? 'فعّل الحد الأدنى فقط بعد ظهور الإصدار الجديد في المتجر. الأجهزة الأقدم من الحد المحدد ستتوقف عند شاشة التحديث.'
            : 'Raise a minimum only after the new release is visible in its store. Builds below that minimum will stop at the update screen.'}
        </p>
      </div>

      <SettingsGroup title={isRtl ? 'التحكم العام' : 'Global control'}>
        <SettingsRow
          isRtl={isRtl}
          icon={SETTINGS_ICONS.appUpdates}
          label={isRtl ? 'فرض التحديثات' : 'Enforce updates'}
          sublabel={isRtl ? 'مفتاح الإيقاف الطارئ لجميع المنصات' : 'Emergency switch for every platform'}
          trailing={
            <SettingsToggle
              checked={draft.enforcementEnabled}
              onChange={value => { setDraft(current => ({ ...current, enforcementEnabled: value })); setMessage(null); }}
              isRtl={isRtl}
            />
          }
        />
      </SettingsGroup>

      {(['android', 'ios'] as const).map(platform => {
        const target = draft[platform];
        const platformName = platform === 'android' ? 'Android' : 'iOS';
        return (
          <SettingsGroup key={platform} title={platformName}>
            <SettingsRow
              isRtl={isRtl}
              icon={SETTINGS_ICONS.appUpdates}
              label={isRtl ? `تفعيل ${platformName}` : `Enable ${platformName}`}
              trailing={<SettingsToggle checked={target.enabled} onChange={enabled => updatePlatform(platform, { enabled })} isRtl={isRtl} />}
            />
            <label className="block px-4 py-4">
              <span className="mb-2 block text-sm font-bold text-slate-700 dark:text-zinc-200">
                {isRtl ? 'أقل رقم بناء مسموح' : 'Minimum allowed build'}
              </span>
              <input
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                value={target.minBuild}
                onChange={event => updatePlatform(platform, { minBuild: Number(event.target.value) })}
                className="w-full rounded-xl border-2 border-slate-200 bg-white px-3 py-2.5 font-bold text-slate-900 outline-none focus:border-sky-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-white"
              />
              <span className="mt-2 block text-xs font-semibold text-slate-400">
                {isRtl ? `سيتم حظر أرقام البناء الأقل من ${target.minBuild || '—'}.` : `Builds below ${target.minBuild || '—'} will be blocked.`}
              </span>
            </label>
            <label className="block px-4 py-4">
              <span className="mb-2 block text-sm font-bold text-slate-700 dark:text-zinc-200">
                {isRtl ? 'رابط المتجر' : 'Store URL'}
              </span>
              <input
                type="url"
                value={target.storeUrl}
                onChange={event => updatePlatform(platform, { storeUrl: event.target.value })}
                dir="ltr"
                className="w-full rounded-xl border-2 border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-900 outline-none focus:border-sky-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-white"
              />
            </label>
          </SettingsGroup>
        );
      })}

      {message && (
        <p role="status" className={`rounded-xl px-4 py-3 text-sm font-bold ${message.kind === 'error' ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300' : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'}`}>
          {message.text}
        </p>
      )}

      <button
        type="button"
        onClick={() => void save()}
        disabled={saving}
        className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-sky-600 px-5 py-3 font-black text-white hover:bg-sky-700 disabled:opacity-60"
      >
        {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : <Save className="h-5 w-5" />}
        {saving ? (isRtl ? 'جاري الحفظ…' : 'Saving…') : (isRtl ? 'حفظ سياسة التحديث' : 'Save update policy')}
      </button>
    </div>
  );
}
