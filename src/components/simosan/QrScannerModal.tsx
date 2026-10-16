import React, { useEffect, useId, useRef, useState } from 'react';
import { Camera, Flashlight, RefreshCw, X } from 'lucide-react';
import { ATTENDANCE_DISCIPLINARY_BANNER } from '../../../shared/attendanceSecurity';

interface QrScannerModalProps {
  lang: 'ar' | 'en';
  onScan: (value: string) => void;
  onClose: () => void;
}

export default function QrScannerModal({ lang, onScan, onClose }: QrScannerModalProps) {
  const isRtl = lang === 'ar';
  const elementId = `attendance-reader-${useId().replace(/:/g, '')}`;
  const scannerRef = useRef<any>(null);
  const handledRef = useRef(false);
  const scanRef = useRef(onScan);
  scanRef.current = onScan;
  const [cameras, setCameras] = useState<Array<{ id: string; label: string }>>([]);
  const [cameraIndex, setCameraIndex] = useState(0);
  const [error, setError] = useState('');
  const [torch, setTorch] = useState(false);
  const [isScanning, setIsScanning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let scanner: any;
    const start = async () => {
      try {
        const { Html5Qrcode } = await import('html5-qrcode');
        const devices = await Html5Qrcode.getCameras();
        if (cancelled) return;
        setCameras(devices);
        scanner = new Html5Qrcode(elementId, { verbose: false });
        scannerRef.current = scanner;
        const selected = devices[cameraIndex]?.id || { facingMode: 'environment' };
        await scanner.start(
          selected,
          { fps: 12, qrbox: { width: 250, height: 250 }, aspectRatio: 1 },
          (decodedText: string) => {
            if (handledRef.current) return;
            handledRef.current = true;
            if (!cancelled) scanRef.current(decodedText);
          },
          () => undefined,
        );
        if (cancelled) {
          await scanner.stop().catch(() => undefined);
          scanner.clear();
        } else setIsScanning(true);
      } catch (scanError: any) {
        if (!cancelled) {
          setError(
            scanError?.message ||
              (isRtl
                ? 'تعذر تشغيل الكاميرا. امنح الإذن أو اطلب من الأستاذ التسجيل اليدوي.'
                : 'Camera unavailable. Grant permission or ask the lecturer for manual attendance.')
          );
        }
      }
    };
    void start();
    return () => {
      cancelled = true;
      scannerRef.current = null;
      if (scanner?.isScanning) void scanner.stop().catch(() => undefined).finally(() => scanner.clear());
      else scanner?.clear?.();
    };
  }, [cameraIndex, elementId, isRtl]);

  const switchCamera = async () => {
    if (cameras.length < 2) return;
    const scanner = scannerRef.current;
    if (scanner?.isScanning) await scanner.stop().catch(() => undefined);
    scanner?.clear?.();
    scannerRef.current = null;
    handledRef.current = false;
    setCameraIndex((index) => (index + 1) % cameras.length);
  };

  const toggleTorch = async () => {
    try {
      const next = !torch;
      await scannerRef.current?.applyVideoConstraints({ advanced: [{ torch: next }] });
      setTorch(next);
    } catch {
      setError(isRtl ? 'المصباح غير مدعوم في هذه الكاميرا' : 'Torch is not supported by this camera');
    }
  };

  return (
    <div className="fixed inset-0 z-[120] bg-black/85 p-4 flex items-center justify-center backdrop-blur-sm" dir={isRtl ? 'rtl' : 'ltr'}>
      <div className="max-h-[95dvh] w-full max-w-md overflow-y-auto rounded-3xl bg-white dark:bg-zinc-900 p-5 shadow-2xl border border-slate-200 dark:border-zinc-800 animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300">
              <Camera className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-black text-sm text-slate-900 dark:text-white">
                {isRtl ? 'مسح رمز الحضور المباشر' : 'Live Attendance Scanner'}
              </h3>
              <p className="text-[11px] text-slate-400">
                {isRtl ? 'وجّه الكاميرا نحو شاشة القاعة' : 'Point camera at lecture screen'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 transition-colors"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p dir="rtl" className="mb-3 rounded-xl border-2 border-red-700 bg-red-950 p-3 text-xs font-bold leading-6 text-white">{ATTENDANCE_DISCIPLINARY_BANNER}</p>
        {/* Camera Viewfinder & Laser Reticle */}
        <div className="relative min-h-[300px] overflow-hidden rounded-2xl bg-black flex items-center justify-center">
          <div id={elementId} className="w-full h-full min-h-[300px]" />

          {/* Futuristic Reticle Frame */}
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center p-8">
            <div className="relative w-56 h-56 border-2 border-dashed border-teal-400/50 rounded-3xl">
              {/* Corner brackets */}
              <div className="absolute -top-1 -start-1 w-6 h-6 border-t-4 border-s-4 border-teal-400 rounded-tl-xl" />
              <div className="absolute -top-1 -end-1 w-6 h-6 border-t-4 border-e-4 border-teal-400 rounded-tr-xl" />
              <div className="absolute -bottom-1 -start-1 w-6 h-6 border-b-4 border-s-4 border-teal-400 rounded-bl-xl" />
              <div className="absolute -bottom-1 -end-1 w-6 h-6 border-b-4 border-e-4 border-teal-400 rounded-br-xl" />

              {/* Laser scanning beam */}
              <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-transparent via-teal-400 to-transparent animate-bounce opacity-80" />
            </div>
          </div>
        </div>

        {/* Error message if any */}
        {error && (
          <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs font-bold text-amber-800 dark:bg-amber-950/40 dark:text-amber-200 border border-amber-200 dark:border-amber-900/40">
            {error}
          </p>
        )}

        {/* Action Controls */}
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            onClick={switchCamera}
            disabled={cameras.length < 2}
            className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100 disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-750 transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>{isRtl ? 'تبديل الكاميرا' : 'Flip camera'}</span>
          </button>

          <button
            onClick={toggleTorch}
            className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-750 transition-colors"
          >
            <Flashlight className={`h-3.5 w-3.5 ${torch ? 'text-amber-500 fill-amber-500' : ''}`} />
            <span>{isRtl ? 'المصباح' : 'Torch'}</span>
          </button>
        </div>

      </div>
    </div>
  );
}
