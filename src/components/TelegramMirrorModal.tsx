import React, { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  X, Send, Loader2, Check, AlertCircle, AlertTriangle, ArrowDownToLine,
  ArrowUpFromLine, Radio, RadioTower,
} from 'lucide-react';
import { Language, UserProfile } from '../types';
import { useStageContext } from '../contexts/StageContext';
import { useTelegramMirror, type TelegramChannelStatus } from '../hooks/useTelegramMirror';
import { logAdminAction } from '../services/adminLogService';
import {
  MIRROR_STAGE_IDS,
  parseChatId,
  validateTelegramConfig,
  type MirrorStageId,
  type TelegramChannel,
  type TelegramConfig,
  type TelegramConfigProblem,
} from '../../shared/telegramMirror';

/**
 * The Telegram channel map.
 *
 * Master-admin only, both here and in firestore.rules - and unlike the academic
 * calendar, master-admin to READ as well, because this document enumerates the
 * private channel ids of all five stages.
 *
 * The bot picks changes up live through its own onSnapshot, so saving here is
 * the whole deployment step for a channel change. No restart, no redeploy.
 */

interface Props {
  isOpen: boolean;
  onClose: () => void;
  lang: Language;
  user: UserProfile | null;
}

function explain(code: TelegramConfigProblem, isRtl: boolean): string {
  switch (code) {
    case 'no_channels':
      return isRtl
        ? 'المزامنة مفعّلة لكن لا توجد أي قناة مفعّلة.'
        : 'The mirror is enabled but no channel is turned on.';
    case 'bad_chat_id':
      return isRtl
        ? 'معرّف القناة يجب أن يكون رقماً سالباً مثل -1002345678901.'
        : 'A channel id must be a negative number, e.g. -1002345678901.';
    case 'duplicate_chat_id':
      return isRtl
        ? 'لا يمكن ربط القناة نفسها بمرحلتين — المنشور الوارد لن يعرف لأي مرحلة ينتمي.'
        : 'One channel cannot feed two stages — an incoming post would have no single stage.';
    case 'unknown_stage':
      return isRtl ? 'مرحلة غير معروفة في الإعدادات.' : 'Unknown stage in the configuration.';
  }
}

const emptyChannel = (): TelegramChannel => ({
  chatId: 0, displayName: '', enabled: true, mirrorIn: true, mirrorOut: true,
});

function StatusPill({ status, isRtl }: { status?: TelegramChannelStatus; isRtl: boolean }) {
  if (!status?.chatId) return null;

  const tone = status.state === 'ok'
    ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
    : status.state === 'parked'
      ? 'bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-400'
      : 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400';

  const label = status.state === 'ok'
    ? (isRtl ? 'يعمل' : 'OK')
    : status.state === 'parked'
      ? (isRtl ? 'متوقف' : 'Parked')
      : (isRtl ? 'تحذير' : 'Degraded');

  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
      <span className={`px-2 py-0.5 rounded-md text-[10px] font-black ${tone}`}>{label}</span>
      {status.title && (
        <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 truncate max-w-[160px]">
          {status.title}
        </span>
      )}
      {typeof status.inbound24h === 'number' && (
        <span className="text-[10px] font-bold text-slate-400 tabular-nums">
          ↓{status.inbound24h} ↑{status.outbound24h ?? 0}
        </span>
      )}
      {status.lastError && (
        <span className="w-full text-[10px] font-bold text-rose-600 dark:text-rose-400 break-all" dir="ltr">
          {status.lastError}
        </span>
      )}
    </div>
  );
}

export default function TelegramMirrorModal({ isOpen, onClose, lang, user }: Props) {
  const isRtl = lang === 'ar';
  const { stages } = useStageContext();
  const { config, status, isBotOnline, isLoading, loadError, saveConfig } = useTelegramMirror();

  const [draft, setDraft] = useState<TelegramConfig>(config);
  // Kept as raw strings so a half-typed id does not get coerced to 0 mid-keystroke.
  const [rawIds, setRawIds] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setDraft(config);
    setRawIds(Object.fromEntries(
      MIRROR_STAGE_IDS.map(id => [id, config.channels[id]?.chatId ? String(config.channels[id]!.chatId) : '']),
    ));
    setError(null);
    setSuccess(false);
  }, [isOpen, config]);

  const problems = useMemo(() => validateTelegramConfig(draft), [draft]);

  const patchChannel = (stageId: MirrorStageId, patch: Partial<TelegramChannel>) =>
    setDraft(prev => ({
      ...prev,
      channels: {
        ...prev.channels,
        [stageId]: { ...(prev.channels[stageId] ?? emptyChannel()), ...patch },
      },
    }));

  const onIdChange = (stageId: MirrorStageId, raw: string) => {
    setRawIds(prev => ({ ...prev, [stageId]: raw }));
    const parsed = parseChatId(raw);

    if (parsed === null && !raw.trim()) {
      // Cleared: drop the channel entirely rather than storing chatId 0, which
      // would fail validation forever with no obvious way back.
      setDraft(prev => {
        const next = { ...prev.channels };
        delete next[stageId];
        return { ...prev, channels: next };
      });
      return;
    }
    patchChannel(stageId, { chatId: parsed ?? 0 });
  };

  const handleSave = async () => {
    if (problems.length > 0) return;
    setIsSaving(true);
    setError(null);
    try {
      await saveConfig(draft, user?.email);
      await logAdminAction(
        'UPDATE_TELEGRAM_MIRROR',
        `Telegram mirror ${draft.enabled ? 'enabled' : 'disabled'}; ` +
        `${Object.keys(draft.channels).length} channel(s) mapped`,
      );
      setSuccess(true);
      setTimeout(onClose, 900);
    } catch (err: any) {
      console.error('Failed to save Telegram mirror config:', err);
      setError(err?.code === 'permission-denied'
        ? (isRtl ? 'إعدادات تيليجرام للمشرف العام فقط' : 'The Telegram mirror is master-admin only')
        : (isRtl ? 'حدث خطأ أثناء الحفظ' : 'Error saving the configuration'));
    } finally {
      setIsSaving(false);
    }
  };

  const toggleClass = (on: boolean) =>
    `flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold transition-colors ${
      on
        ? 'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300'
        : 'bg-slate-100 dark:bg-zinc-800 text-slate-400 dark:text-slate-500'
    }`;

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          dir={isRtl ? 'rtl' : 'ltr'}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
            className="bg-white dark:bg-zinc-900 rounded-3xl w-full max-w-lg shadow-2xl relative max-h-[90vh] overflow-y-auto aesthetic-scrollbar"
          >
            <div className="sticky top-0 z-10 bg-white dark:bg-zinc-900 p-6 pb-4 border-b border-slate-100 dark:border-zinc-800 flex items-center justify-between">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-2xl bg-cyan-100 dark:bg-cyan-900/30 flex items-center justify-center shrink-0">
                  <Send className="w-5 h-5 text-cyan-600 dark:text-cyan-400" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-lg font-black text-slate-900 dark:text-white truncate">
                    {isRtl ? 'مزامنة تيليجرام' : 'Telegram Mirror'}
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                    {isRtl ? 'قناة لكل مرحلة، بالاتجاهين' : 'One channel per stage, both directions'}
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                aria-label={isRtl ? 'إغلاق' : 'Close'}
                className="p-2 bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 rounded-full transition-colors shrink-0"
              >
                <X className="w-5 h-5 text-slate-600 dark:text-slate-400" />
              </button>
            </div>

            {isLoading ? (
              <div className="flex justify-center py-16">
                <Loader2 className="w-7 h-7 text-sky-600 dark:text-sky-400 animate-spin" />
              </div>
            ) : loadError === 'denied' ? (
              <div className="p-6">
                <div className="p-4 rounded-2xl bg-rose-50 dark:bg-rose-900/20 text-rose-600 dark:text-rose-400 text-sm font-bold flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  {isRtl
                    ? 'هذه الصفحة للمشرف العام فقط. معرّفات القنوات الخاصة لا تُعرض لغير ذلك.'
                    : 'This page is master-admin only. Private channel ids are not shown to anyone else.'}
                </div>
              </div>
            ) : (
              <div className="p-6 space-y-4">
                {/* Bot health. Derived from a heartbeat, not a stored flag: a
                    container that was SIGKILLed never wrote "stopped". */}
                <div className={`flex items-center gap-2.5 p-3 rounded-2xl border ${
                  isBotOnline
                    ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-100 dark:border-emerald-900/40'
                    : 'bg-slate-50 dark:bg-zinc-800/60 border-slate-200 dark:border-zinc-700'
                }`}>
                  {isBotOnline
                    ? <RadioTower className="w-4 h-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    : <Radio className="w-4 h-4 shrink-0 text-slate-400" />}
                  <div className="min-w-0 flex-1">
                    <p className={`text-xs font-black ${
                      isBotOnline ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400'
                    }`}>
                      {isBotOnline
                        ? (isRtl ? 'البوت متصل' : 'Bot is online')
                        : (isRtl ? 'البوت غير متصل' : 'Bot is offline')}
                    </p>
                    <p className="text-[11px] text-slate-400 dark:text-slate-500 truncate">
                      {isBotOnline
                        ? `${status?.pollState ?? 'polling'}${status?.version ? ` · ${status.version}` : ''}`
                        : (isRtl ? 'شغّل حاوية bot/ للمزامنة' : 'Start the bot/ container to sync')}
                    </p>
                  </div>
                </div>

                {status?.configError && (
                  <div className="p-3 rounded-2xl bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 text-xs font-bold flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
                    <span className="break-all" dir="ltr">{status.configError}</span>
                  </div>
                )}

                {/* Global switch */}
                <button
                  type="button"
                  onClick={() => setDraft(p => ({ ...p, enabled: !p.enabled }))}
                  className={`w-full flex items-center justify-between gap-3 p-3.5 rounded-2xl border-2 transition-all text-start ${
                    draft.enabled
                      ? 'border-sky-500 bg-sky-50 dark:bg-sky-900/20'
                      : 'border-slate-200 dark:border-zinc-800'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="font-bold text-[15px] text-slate-800 dark:text-slate-100">
                      {isRtl ? 'تفعيل المزامنة' : 'Enable the mirror'}
                    </div>
                    <div className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
                      {isRtl ? 'مفتاح رئيسي لكل المراحل' : 'Master switch for every stage'}
                    </div>
                  </div>
                  <span className={`w-11 h-6 rounded-full shrink-0 transition-colors relative ${
                    draft.enabled ? 'bg-sky-500' : 'bg-slate-300 dark:bg-zinc-700'
                  }`}>
                    <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
                      draft.enabled ? 'start-[22px]' : 'start-0.5'
                    }`} />
                  </span>
                </button>

                {/* Per-stage rows */}
                <div className="space-y-2.5">
                  {stages.map(stage => {
                    const stageId = stage.id as MirrorStageId;
                    if (!(MIRROR_STAGE_IDS as readonly string[]).includes(stageId)) return null;
                    const channel = draft.channels[stageId];

                    return (
                      <div
                        key={stage.id}
                        className="p-3 rounded-2xl border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-800/40"
                      >
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <span className="font-bold text-sm text-slate-800 dark:text-slate-100 truncate">
                            {isRtl ? stage.nameAr : stage.nameEn}
                          </span>
                          <span className="text-[10px] font-bold text-slate-400 shrink-0" dir="ltr">{stage.id}</span>
                        </div>

                        <input
                          value={rawIds[stageId] ?? ''}
                          onChange={e => onIdChange(stageId, e.target.value)}
                          dir="ltr"
                          inputMode="text"
                          placeholder="-1002345678901"
                          className="w-full px-3 py-2 text-sm text-left font-mono bg-white dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded-xl outline-none focus:border-sky-500 text-slate-900 dark:text-stone-100"
                        />

                        {channel && (
                          <>
                            <input
                              value={channel.displayName ?? ''}
                              onChange={e => patchChannel(stageId, { displayName: e.target.value })}
                              dir="auto"
                              placeholder={isRtl ? 'اسم الكاتب في التطبيق (اختياري)' : 'Author name shown in the app (optional)'}
                              className="w-full mt-1.5 px-3 py-2 text-sm bg-white dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded-xl outline-none focus:border-sky-500 text-slate-900 dark:text-stone-100"
                            />

                            <div className="flex flex-wrap items-center gap-1.5 mt-2">
                              <button
                                type="button"
                                onClick={() => patchChannel(stageId, { enabled: !channel.enabled })}
                                className={toggleClass(channel.enabled)}
                              >
                                {channel.enabled ? (isRtl ? 'مفعّلة' : 'On') : (isRtl ? 'موقوفة' : 'Off')}
                              </button>
                              <button
                                type="button"
                                onClick={() => patchChannel(stageId, { mirrorIn: !channel.mirrorIn })}
                                className={toggleClass(channel.mirrorIn)}
                                title={isRtl ? 'من تيليجرام إلى التطبيق' : 'Telegram to app'}
                              >
                                <ArrowDownToLine className="w-3 h-3" />
                                {isRtl ? 'وارد' : 'In'}
                              </button>
                              <button
                                type="button"
                                onClick={() => patchChannel(stageId, { mirrorOut: !channel.mirrorOut })}
                                className={toggleClass(channel.mirrorOut)}
                                title={isRtl ? 'من التطبيق إلى تيليجرام' : 'App to Telegram'}
                              >
                                <ArrowUpFromLine className="w-3 h-3" />
                                {isRtl ? 'صادر' : 'Out'}
                              </button>
                            </div>
                          </>
                        )}

                        <StatusPill status={status?.channels?.[stageId]} isRtl={isRtl} />
                      </div>
                    );
                  })}
                </div>

                <p className="text-[11px] leading-relaxed text-slate-400 dark:text-slate-500">
                  {isRtl
                    ? 'أضف البوت مشرفاً في كل قناة بصلاحيات النشر والتعديل والحذف. حذف منشور في التطبيق يحذفه من تيليجرام، أما الحذف داخل تيليجرام فلا يصل البوت — تيليجرام لا يُبلّغ البوتات بالحذف.'
                    : 'Add the bot as an admin in each channel with post, edit and delete rights. Deleting in the app deletes from Telegram; deleting inside Telegram does not reach the app — Telegram never tells bots about deletions.'}
                </p>

                {problems.length > 0 && (
                  <div className="p-3 rounded-2xl bg-amber-50 dark:bg-amber-900/20 border border-amber-100 dark:border-amber-900/40">
                    <ul className="space-y-1">
                      {problems.map(code => (
                        <li key={code} className="flex items-start gap-2 text-xs font-bold text-amber-700 dark:text-amber-400">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                          <span>{explain(code, isRtl)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {error && (
                  <div className="p-3 rounded-2xl bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm font-bold flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    {error}
                  </div>
                )}

                <button
                  onClick={handleSave}
                  disabled={isSaving || problems.length > 0 || success}
                  className="w-full py-3.5 bg-sky-600 hover:bg-sky-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-2xl font-bold transition-colors flex items-center justify-center gap-2"
                >
                  {isSaving ? <Loader2 className="w-5 h-5 animate-spin" /> : success ? <Check className="w-5 h-5" /> : null}
                  {success
                    ? (isRtl ? 'تم الحفظ' : 'Saved')
                    : (isRtl ? 'حفظ الإعدادات' : 'Save configuration')}
                </button>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
