import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Expand, X, ZoomIn, Monitor } from 'lucide-react';

export type AttendanceQrSize = 'normal' | 'large' | 'giant';

interface AttendanceQrDisplayProps {
  token: string;
  title: string;
  subtitle?: string;
  countLabel?: string;
  isRtl: boolean;
  unavailableLabel: string;
  sizing?: AttendanceQrSize;
  onSizingChange?: (size: AttendanceQrSize) => void;
  showSizingControls?: boolean;
}

/** A single, high-contrast, scalable QR presentation for doctor attendance screens. */
export default function AttendanceQrDisplay({
  token,
  title,
  subtitle,
  countLabel,
  isRtl,
  unavailableLabel,
  sizing: controlledSizing,
  onSizingChange,
  showSizingControls = true,
}: AttendanceQrDisplayProps) {
  const [svg, setSvg] = useState('');
  const [projector, setProjector] = useState(false);
  const [internalSizing, setInternalSizing] = useState<AttendanceQrSize>('normal');
  const ref = useRef<HTMLDivElement>(null);

  const activeSizing = controlledSizing ?? internalSizing;
  const setSizing = (size: AttendanceQrSize) => {
    setInternalSizing(size);
    onSizingChange?.(size);
  };

  useEffect(() => {
    let mounted = true;
    setSvg('');
    if (token) {
      // Level L (7% error correction) + margin 1 gives significantly larger modules and lower density
      // for effortless long-distance scanning in lecture halls and compatibility with older cameras.
      void QRCode.toString(token, {
        type: 'svg',
        errorCorrectionLevel: 'L',
        margin: 1,
        color: { dark: '#000000', light: '#ffffff' },
      })
        .then((value) => {
          if (mounted) setSvg(value);
        })
        .catch(() => {
          if (mounted) setSvg('');
        });
    }
    return () => {
      mounted = false;
    };
  }, [token]);

  useEffect(() => {
    const changed = () => setProjector(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);

  const openProjector = () => {
    setProjector(true);
    void ref.current?.requestFullscreen?.().catch(() => undefined);
  };

  const closeProjector = () => {
    setProjector(false);
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
  };

  // Determine container width based on sizing mode in standard view
  const sizeClasses = {
    normal: 'max-w-sm sm:max-w-md w-full',
    large: 'max-w-xl sm:max-w-2xl w-full',
    giant: 'max-w-2xl sm:max-w-4xl w-full',
  }[activeSizing];

  return (
    <section
      ref={ref}
      dir={isRtl ? 'rtl' : 'ltr'}
      className={
        projector
          ? 'fixed inset-0 z-[100] flex min-h-[100dvh] flex-col items-center justify-between bg-white px-4 py-3 sm:px-8 sm:py-6 text-black select-none'
          : `relative flex flex-col items-center rounded-3xl border border-slate-200 bg-white p-4 text-black shadow-md dark:border-zinc-700 transition-all duration-200 ${sizeClasses}`
      }
    >
      {/* Header bar */}
      <div className="flex w-full items-center justify-between gap-3 pb-3 border-b border-slate-100 dark:border-zinc-800 text-start">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className={`truncate font-black ${projector ? 'text-xl sm:text-2xl' : 'text-sm sm:text-base'}`}>
              {title}
            </h2>
            {projector && (
              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-xs font-black">
                <Monitor className="h-3 w-3" />
                {isRtl ? 'وضع عرض القاعة' : 'Projector Mode'}
              </span>
            )}
          </div>
          {subtitle && (
            <p className={`truncate text-slate-500 dark:text-zinc-400 ${projector ? 'text-sm' : 'text-xs'}`}>
              {subtitle}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Sizing Controls (Normal view only) */}
          {!projector && showSizingControls && (
            <div className="hidden sm:flex items-center p-0.5 rounded-xl bg-slate-100 dark:bg-zinc-800 border border-slate-200/60 dark:border-zinc-700/60 text-[11px] font-bold">
              <button
                type="button"
                onClick={() => setSizing('normal')}
                className={`px-2.5 py-1 rounded-lg transition-all cursor-pointer ${
                  activeSizing === 'normal'
                    ? 'bg-white text-teal-700 shadow-xs dark:bg-zinc-700 dark:text-teal-300'
                    : 'text-slate-500 hover:text-slate-900 dark:text-zinc-400'
                }`}
                title={isRtl ? 'الحجم العادي (420px)' : 'Normal size (420px)'}
              >
                {isRtl ? 'عادي' : 'Normal'}
              </button>
              <button
                type="button"
                onClick={() => setSizing('large')}
                className={`px-2.5 py-1 rounded-lg transition-all cursor-pointer ${
                  activeSizing === 'large'
                    ? 'bg-white text-teal-700 shadow-xs dark:bg-zinc-700 dark:text-teal-300'
                    : 'text-slate-500 hover:text-slate-900 dark:text-zinc-400'
                }`}
                title={isRtl ? 'حجم مكبر (600px)' : 'Large size (600px)'}
              >
                {isRtl ? 'مكبر' : 'Large'}
              </button>
              <button
                type="button"
                onClick={() => setSizing('giant')}
                className={`px-2.5 py-1 rounded-lg transition-all cursor-pointer ${
                  activeSizing === 'giant'
                    ? 'bg-white text-teal-700 shadow-xs dark:bg-zinc-700 dark:text-teal-300'
                    : 'text-slate-500 hover:text-slate-900 dark:text-zinc-400'
                }`}
                title={isRtl ? 'عملاق القاعة (800px)' : 'Giant size (800px)'}
              >
                {isRtl ? 'عملاق' : 'Giant'}
              </button>
            </div>
          )}

          {/* Fullscreen / Projector Toggle */}
          {projector ? (
            <button
              type="button"
              onClick={closeProjector}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-black transition-colors cursor-pointer"
              aria-label="Exit projector view"
            >
              <X className="h-4 w-4" />
              <span>{isRtl ? 'إغلاق ملء الشاشة' : 'Exit Fullscreen'}</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={openProjector}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-700 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800 text-xs font-bold transition-colors cursor-pointer"
              title={isRtl ? 'تكبير ملء الشاشة لشاشة القاعة أو العارض' : 'Fullscreen for projector'}
            >
              <Expand className="h-4 w-4" />
              <span className="hidden sm:inline">{isRtl ? 'شاشة القاعة' : 'Projector'}</span>
            </button>
          )}
        </div>
      </div>

      {/* QR Code Presentation Box */}
      <div className="flex flex-1 items-center justify-center w-full my-auto py-2">
        {svg ? (
          <div
            className={
              projector
                ? 'w-[min(90vw,calc(100dvh-7.5rem))] aspect-square flex items-center justify-center p-4 bg-white rounded-3xl shadow-2xl border-4 border-slate-900 [&>svg]:w-full [&>svg]:h-full [&>svg]:block'
                : 'w-full aspect-square flex items-center justify-center p-2 [&>svg]:w-full [&>svg]:h-full [&>svg]:block'
            }
            aria-label="Attendance QR"
            role="img"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div className="flex aspect-square w-full items-center justify-center text-center text-sm font-bold text-slate-500">
            {unavailableLabel}
          </div>
        )}
      </div>

      {/* Footer bar */}
      <div className="flex w-full items-center justify-between gap-3 pt-2 border-t border-slate-100 dark:border-zinc-800 text-xs font-bold text-slate-600 dark:text-zinc-400">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
          <span>{token ? (isRtl ? 'رمز الحضور جاهز ومحدث' : 'Attendance QR active') : unavailableLabel}</span>
        </span>
        {countLabel && (
          <span className="font-mono px-2 py-0.5 rounded-lg bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-200">
            {countLabel}
          </span>
        )}
      </div>
    </section>
  );
}
