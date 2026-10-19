import React from 'react';
import { Capacitor } from '@capacitor/core';
import { AlertTriangle, Download, Info } from 'lucide-react';

export function getAndroidWebViewVersion(): number | null {
  if (typeof navigator === 'undefined') return null;
  const match = navigator.userAgent.match(/Chrome\/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

export function isAndroidWebViewBelowMinimum(): boolean {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
    return false;
  }
  const version = getAndroidWebViewVersion();
  return version !== null && version < 108;
}

export const WebViewCompatibilityGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const isBelow = isAndroidWebViewBelowMinimum();
  if (!isBelow) {
    return <>{children}</>;
  }

  const currentVersion = getAndroidWebViewVersion();

  const handleOpenPlayStore = () => {
    const playStoreUrl = 'https://play.google.com/store/apps/details?id=com.google.android.webview';
    window.open(playStoreUrl, '_system');
  };

  return (
    <div
      dir="rtl"
      className="fixed inset-0 z-[99999] bg-slate-900 text-slate-100 flex flex-col items-center justify-center p-6 overflow-y-auto"
    >
      <div className="w-full max-w-md bg-slate-800/90 border border-amber-500/30 rounded-2xl p-6 shadow-2xl flex flex-col items-center text-center">
        <div className="w-16 h-16 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mb-4 text-amber-400">
          <AlertTriangle className="w-8 h-8" />
        </div>

        <h1 className="text-xl font-bold mb-2">تحديث نظام عرض الويب مطلوب</h1>
        <p className="text-sm text-slate-400 mb-4">
          Android System WebView Update Required
        </p>

        <div className="w-full bg-slate-900/60 rounded-xl p-3 text-xs text-slate-300 mb-4 border border-slate-700/50 space-y-1">
          <div className="flex justify-between">
            <span className="text-slate-400">الإصدار الحالي (Current Version):</span>
            <span className="font-mono text-amber-400 font-semibold">{currentVersion ?? 'غير معروف'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">الإصدار المطلوب (Required Version):</span>
            <span className="font-mono text-emerald-400 font-semibold">108 أو أحدث</span>
          </div>
        </div>

        <div className="w-full bg-blue-950/40 border border-blue-500/30 rounded-xl p-3 text-right text-xs text-blue-200 mb-6 flex items-start gap-2">
          <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
          <span>
            سجلات حضورك ومعلوماتك محفوظة بأمان على جهازك ولن يتم مسحها. يتطلب التطبيق هذا التحديث لضمان أمان ودقة التسجيل.
          </span>
        </div>

        <button
          onClick={handleOpenPlayStore}
          className="w-full py-3 px-4 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white font-semibold rounded-xl flex items-center justify-center gap-2 shadow-lg shadow-emerald-900/40 transition-colors mb-3"
        >
          <Download className="w-5 h-5" />
          <span>تحديث عبر Google Play</span>
        </button>

        <div className="mt-4 pt-4 border-t border-slate-700/60 w-full text-right text-xs text-slate-400">
          <p className="font-semibold text-slate-300 mb-1">تسجيل الحضور اليدوي في القاعة:</p>
          <p>
            إذا لم تتمكن من التحديث الآن، يرجى إبراز هويتك الجامعية لأستاذ المادة لتسجيل حضورك يدوياً في القاعة.
          </p>
        </div>
      </div>
    </div>
  );
};
