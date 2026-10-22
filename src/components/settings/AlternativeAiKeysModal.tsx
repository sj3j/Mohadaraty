import React, { useState, useEffect } from 'react';
import { X, KeyRound, Plus, Trash2, RefreshCw, CheckCircle2, AlertCircle, Clock, ShieldCheck, Sparkles, Loader2 } from 'lucide-react';
import {
  fetchAlternativeAiKeys,
  addAlternativeAiKey,
  deleteAlternativeAiKey,
  testAlternativeAiKey,
} from '../../services/alternativeAiKeysService';
import type { AlternativeKeyDoc } from '../../../shared/alternativeKeysApi';

interface Props {
  isRtl: boolean;
  onClose: () => void;
}

export default function AlternativeAiKeysModal({ isRtl, onClose }: Props) {
  const [keys, setKeys] = useState<AlternativeKeyDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Form states
  const [newKey, setNewKey] = useState('');
  const [newNote, setNewNote] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);

  const loadKeys = async () => {
    try {
      setLoading(true);
      const data = await fetchAlternativeAiKeys();
      setKeys(data);
    } catch (err: any) {
      console.error('Failed to load alternative keys', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadKeys();
  }, []);

  const handleAddKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setFormSuccess(null);

    const trimmedKey = newKey.trim();
    if (!trimmedKey) {
      setFormError(isRtl ? 'يرجى إدخال مفتاح API صالح' : 'Please enter a valid API key');
      return;
    }

    try {
      setAdding(true);
      await addAlternativeAiKey(trimmedKey, newNote.trim());
      setFormSuccess(isRtl ? 'تم التحقق من المفتاح وحفظه بنجاح!' : 'Key verified and saved successfully!');
      setNewKey('');
      setNewNote('');
      await loadKeys();
    } catch (err: any) {
      setFormError(err.message || (isRtl ? 'فشل فحص أو حفظ المفتاح' : 'Failed to test or save key'));
    } finally {
      setAdding(false);
    }
  };

  const handleTestKey = async (id: string) => {
    try {
      setTestingId(id);
      const result = await testAlternativeAiKey(id);
      setKeys(prev =>
        prev.map(k => (k.id === id ? { ...k, status: result.status, lastTestedAt: new Date().toISOString() } : k))
      );
    } catch (err: any) {
      alert(err.message || (isRtl ? 'فشل فحص المفتاح' : 'Failed to test key'));
    } finally {
      setTestingId(null);
    }
  };

  const handleDeleteKey = async (id: string) => {
    if (!window.confirm(isRtl ? 'هل أنت متأكد من حذف هذا المفتاح؟' : 'Are you sure you want to delete this key?')) {
      return;
    }
    try {
      setDeletingId(id);
      await deleteAlternativeAiKey(id);
      setKeys(prev => prev.filter(k => k.id !== id));
    } catch (err: any) {
      alert(err.message || (isRtl ? 'فشل حذف المفتاح' : 'Failed to delete key'));
    } finally {
      setDeletingId(null);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'active':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            {isRtl ? 'نشط وجاهز' : 'Active'}
          </span>
        );
      case 'quota_exhausted':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
            <Clock className="w-3.5 h-3.5" />
            {isRtl ? 'استنفد الحصة اليومية' : 'Quota Exhausted'}
          </span>
        );
      case 'invalid':
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20">
            <AlertCircle className="w-3.5 h-3.5" />
            {isRtl ? 'معطّل أو غير صالح' : 'Invalid'}
          </span>
        );
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div
        className="w-full max-w-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-3xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden animate-in fade-in zoom-in-95 duration-200"
        dir={isRtl ? 'rtl' : 'ltr'}
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-zinc-100 dark:border-zinc-800/80 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-amber-500/10 text-amber-500 flex items-center justify-center border border-amber-500/20">
              <KeyRound className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-black text-zinc-900 dark:text-white">
                {isRtl ? 'مفاتيح الذكاء الاصطناعي المجانية البديلة' : 'Alternative Free AI Keys'}
              </h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {isRtl
                  ? 'إدارة مفاتيح Gemini المجانية المقدمة من المستخدمين كحوض بديل'
                  : 'Manage donated free Gemini API keys fallback pool'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-2xl text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Explanation Info Banner */}
          <div className="p-4 rounded-2xl bg-sky-50 dark:bg-sky-950/30 border border-sky-100 dark:border-sky-800/50 flex items-start gap-3">
            <Sparkles className="w-5 h-5 text-sky-500 shrink-0 mt-0.5" />
            <div className="text-xs text-sky-900 dark:text-sky-200 leading-relaxed space-y-1">
              <p className="font-bold">
                {isRtl ? 'آلية التبديل التلقائي الذكي:' : 'Smart Automatic Fallback Pool:'}
              </p>
              <p>
                {isRtl
                  ? 'عند استنفاد حصة المفتاح الأساسي (GEMINI_FREE_TIER_API_KEY)، يقوم الخادم تلقائياً بتجربة هذه المفاتيح البديلة واحداً تلو الآخر لتوليد الأسئلة وتحليل الجداول مجاناً. لا يتم عرض المفاتيح الصريحة للمتصفح أبداً لضمان الأمان.'
                  : 'When the primary free key reaches daily quota limits, the server automatically cycles through these active keys to generate MCQs and parse timetables for free before paid options are offered. Plaintext keys are never exposed.'}
              </p>
            </div>
          </div>

          {/* Add Key Form */}
          <form onSubmit={handleAddKey} className="p-5 rounded-2xl bg-zinc-50 dark:bg-zinc-800/40 border border-zinc-200/80 dark:border-zinc-700/50 space-y-4">
            <div className="flex items-center gap-2 text-sm font-bold text-zinc-800 dark:text-zinc-200">
              <Plus className="w-4 h-4 text-amber-500" />
              {isRtl ? 'إضافة مفتاح API مجاني جديد' : 'Add New Free API Key'}
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                  {isRtl ? 'مفتاح Gemini API (يبدأ بـ AIzaSy)' : 'Gemini API Key (starts with AIzaSy)'}
                </label>
                <input
                  type="password"
                  value={newKey}
                  onChange={e => setNewKey(e.target.value)}
                  placeholder="AIzaSy..."
                  disabled={adding}
                  className="w-full px-4 py-2.5 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                  {isRtl ? 'ملاحظة أو اسم المساهم (اختياري)' : 'Note or Contributor Name (Optional)'}
                </label>
                <input
                  type="text"
                  value={newNote}
                  onChange={e => setNewNote(e.target.value)}
                  placeholder={isRtl ? 'مثال: مساهمة من الطالب أحمد - صيدلة رابعة' : 'e.g. Donated by Student Ahmed'}
                  disabled={adding}
                  className="w-full px-4 py-2.5 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
                />
              </div>
            </div>

            {formError && (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-rose-500/10 text-rose-600 dark:text-rose-400 text-xs font-medium border border-rose-500/20">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {formError}
              </div>
            )}

            {formSuccess && (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs font-medium border border-emerald-500/20">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                {formSuccess}
              </div>
            )}

            <button
              type="submit"
              disabled={adding || !newKey.trim()}
              className="w-full py-2.5 px-4 rounded-xl bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white font-bold text-sm shadow-md transition-all flex items-center justify-center gap-2"
            >
              {adding ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {isRtl ? 'جارٍ فحص المفتاح مع Google AI...' : 'Verifying key with Google AI...'}
                </>
              ) : (
                <>
                  <ShieldCheck className="w-4 h-4" />
                  {isRtl ? 'فحص وحفظ المفتاح' : 'Verify & Add Key'}
                </>
              )}
            </button>
          </form>

          {/* Registered Keys List */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-zinc-800 dark:text-zinc-200">
                {isRtl ? `المفاتيح المتاحة في الحوض (${keys.length})` : `Keys in Fallback Pool (${keys.length})`}
              </h3>
              <button
                type="button"
                onClick={loadKeys}
                disabled={loading}
                className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 flex items-center gap-1"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                {isRtl ? 'تحديث' : 'Refresh'}
              </button>
            </div>

            {loading ? (
              <div className="py-8 flex flex-col items-center justify-center text-zinc-400 gap-2">
                <Loader2 className="w-6 h-6 animate-spin" />
                <span className="text-xs">{isRtl ? 'جارٍ التحميل...' : 'Loading keys...'}</span>
              </div>
            ) : keys.length === 0 ? (
              <div className="py-8 px-4 text-center rounded-2xl border border-dashed border-zinc-200 dark:border-zinc-800 text-zinc-400">
                <KeyRound className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p className="text-xs font-medium">
                  {isRtl ? 'لا توجد مفاتيح بديلة مسجلة حالياً.' : 'No alternative keys registered yet.'}
                </p>
                <p className="text-[11px] text-zinc-400 mt-1">
                  {isRtl ? 'أضف أول مفتاح أعلاه لتأمين استمرار التوليد المجاني' : 'Add your first key above to back up free generations'}
                </p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {keys.map(k => (
                  <div
                    key={k.id}
                    className="p-4 rounded-2xl border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:border-zinc-300 dark:hover:border-zinc-700 transition-all"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-sm font-bold text-zinc-800 dark:text-zinc-200 tracking-wider">
                          {k.maskedKey}
                        </span>
                        {getStatusBadge(k.status)}
                      </div>

                      {k.note && (
                        <p className="text-xs text-zinc-600 dark:text-zinc-400">
                          {k.note}
                        </p>
                      )}

                      <div className="text-[11px] text-zinc-400 flex items-center gap-3">
                        {k.addedAt && (
                          <span>
                            {isRtl ? 'أُضيف:' : 'Added:'} {new Date(k.addedAt).toLocaleDateString(isRtl ? 'ar-IQ' : 'en-US')}
                          </span>
                        )}
                        {k.lastTestedAt && (
                          <span>
                            {isRtl ? 'آخر فحص:' : 'Last tested:'} {new Date(k.lastTestedAt).toLocaleTimeString(isRtl ? 'ar-IQ' : 'en-US', { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 self-end sm:self-center">
                      <button
                        type="button"
                        onClick={() => handleTestKey(k.id)}
                        disabled={testingId === k.id}
                        title={isRtl ? 'فحص المفتاح' : 'Test Key'}
                        className="p-2 rounded-xl text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors border border-zinc-200 dark:border-zinc-700 flex items-center gap-1.5 text-xs font-bold"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${testingId === k.id ? 'animate-spin' : ''}`} />
                        <span>{isRtl ? 'فحص' : 'Test'}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleDeleteKey(k.id)}
                        disabled={deletingId === k.id}
                        title={isRtl ? 'حذف المفتاح' : 'Delete Key'}
                        className="p-2 rounded-xl text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors border border-rose-200 dark:border-rose-900/40"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-zinc-100 dark:border-zinc-800/80 bg-zinc-50 dark:bg-zinc-900/50 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="py-2 px-5 rounded-xl bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 text-zinc-800 dark:text-zinc-200 text-xs font-bold transition-colors"
          >
            {isRtl ? 'إغلاق' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
}
