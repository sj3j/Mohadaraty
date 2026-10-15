import React, { useEffect, useId, useRef, useState } from 'react';
import { Camera, Flashlight, RefreshCw, X } from 'lucide-react';

interface QrScannerModalProps {
  lang: 'ar' | 'en';
  onScan: (value: string) => void;
  onClose: () => void;
}

export default function QrScannerModal({ lang, onScan, onClose }: QrScannerModalProps) {
  const elementId = `attendance-reader-${useId().replace(/:/g, '')}`;
  const scannerRef = useRef<any>(null);
  const handledRef = useRef(false);
  const [cameras, setCameras] = useState<Array<{ id: string; label: string }>>([]);
  const [cameraIndex, setCameraIndex] = useState(0);
  const [error, setError] = useState('');
  const [torch, setTorch] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const start = async () => {
      try {
        const { Html5Qrcode } = await import('html5-qrcode');
        const devices = await Html5Qrcode.getCameras();
        if (cancelled) return;
        setCameras(devices);
        const scanner = new Html5Qrcode(elementId, { verbose: false });
        scannerRef.current = scanner;
        const selected = devices[cameraIndex]?.id || { facingMode: 'environment' };
        await scanner.start(
          selected,
          { fps: 10, qrbox: { width: 250, height: 250 }, aspectRatio: 1 },
          (decodedText: string) => {
            if (handledRef.current) return;
            handledRef.current = true;
            onScan(decodedText);
          },
          () => undefined,
        );
      } catch (scanError: any) {
        if (!cancelled) setError(scanError?.message || (lang === 'ar' ? 'تعذر تشغيل الكاميرا' : 'Camera unavailable'));
      }
    };
    void start();
    return () => {
      cancelled = true;
      const scanner = scannerRef.current;
      scannerRef.current = null;
      if (scanner?.isScanning) void scanner.stop().catch(() => undefined).finally(() => scanner.clear());
      else scanner?.clear?.();
    };
  }, [cameraIndex, elementId, lang, onScan]);

  const switchCamera = async () => {
    if (cameras.length < 2) return;
    const scanner = scannerRef.current;
    if (scanner?.isScanning) await scanner.stop().catch(() => undefined);
    scanner?.clear?.();
    scannerRef.current = null;
    handledRef.current = false;
    setCameraIndex(index => (index + 1) % cameras.length);
  };

  const toggleTorch = async () => {
    try {
      const next = !torch;
      await scannerRef.current?.applyVideoConstraints({ advanced: [{ torch: next }] });
      setTorch(next);
    } catch {
      setError(lang === 'ar' ? 'المصباح غير مدعوم في هذه الكاميرا' : 'Torch is not supported by this camera');
    }
  };

  return (
    <div className="fixed inset-0 z-[120] bg-black/80 p-4 flex items-center justify-center" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      <div className="w-full max-w-md rounded-3xl bg-white dark:bg-zinc-900 p-4 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2 font-black text-slate-900 dark:text-white">
            <Camera className="h-5 w-5 text-sky-600" />
            {lang === 'ar' ? 'امسح رمز الحضور' : 'Scan attendance code'}
          </div>
          <button onClick={onClose} className="rounded-full p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-zinc-800" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div id={elementId} className="min-h-[280px] overflow-hidden rounded-2xl bg-black" />
        {error && <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm font-bold text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button onClick={switchCamera} disabled={cameras.length < 2} className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm font-bold disabled:opacity-40 dark:border-zinc-700">
            <RefreshCw className="h-4 w-4" /> {lang === 'ar' ? 'تبديل الكاميرا' : 'Flip camera'}
          </button>
          <button onClick={toggleTorch} className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm font-bold dark:border-zinc-700">
            <Flashlight className="h-4 w-4" /> {lang === 'ar' ? 'المصباح' : 'Torch'}
          </button>
        </div>
      </div>
    </div>
  );
}
