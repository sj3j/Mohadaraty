import React, { useEffect, useId, useRef, useState } from 'react';
import { Camera, CheckCircle2, Flashlight, Lightbulb, RefreshCw, ShieldAlert, X, ZoomIn, ZoomOut } from 'lucide-react';
import { ATTENDANCE_DISCIPLINARY_BANNER } from '../../../shared/attendanceSecurity';
import { IS_MACOS_BUILD } from '../../lib/platform';

interface QrScannerModalProps {
  lang: 'ar' | 'en';
  onScan: (value: string) => void;
  onClose: () => void;
}

export default function QrScannerModal({ lang, onScan, onClose }: QrScannerModalProps) {
  const isRtl = lang === 'ar';
  const elementId = `attendance-reader-${useId().replace(/:/g, '')}`;
  const scannerRef = useRef<any>(null);
  const zoomFeatureRef = useRef<any>(null);
  const handledRef = useRef(false);
  const scanRef = useRef(onScan);
  scanRef.current = onScan;

  const [cameras, setCameras] = useState<Array<{ id: string; label: string }>>([]);
  const [cameraIndex, setCameraIndex] = useState(0);
  const [error, setError] = useState('');
  const [torch, setTorch] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scanSuccess, setScanSuccess] = useState(false);

  // Zoom controls state
  const [zoom, setZoom] = useState(1.0);
  const [minZoom, setMinZoom] = useState(1.0);
  const [maxZoom, setMaxZoom] = useState(3.0);
  const [zoomStep, setZoomStep] = useState(0.1);
  const [supportsHardwareZoom, setSupportsHardwareZoom] = useState(false);

  // Heuristic glare/distance assistant after 8s
  const [showGlareTip, setShowGlareTip] = useState(false);

  // Disciplinary security banner expanded state
  const [showDisciplinaryDetails, setShowDisciplinaryDetails] = useState(false);

  // Pinch-to-zoom gesture tracking
  const touchStartDistRef = useRef<number | null>(null);
  const zoomAtTouchStartRef = useRef<number>(1.0);

  // Sound and haptic feedback
  const playSuccessChime = () => {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      // Arpeggiated cheerful chime: D5 (587.33Hz) up to A5 (880Hz)
      osc.frequency.setValueAtTime(587.33, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.12);

      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.32);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.32);
    } catch {
      // AudioContext blocked or unsupported
    }
  };

  const triggerHaptic = () => {
    try {
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate([40, 60, 40]);
      }
    } catch {
      // Haptics unsupported
    }
  };

  // Zoom application engine (Hardware with Software Digital fallback)
  const applyZoom = async (targetZoom: number) => {
    const clamped = Math.max(minZoom, Math.min(targetZoom, maxZoom));
    const rounded = Math.round(clamped * 10) / 10;
    setZoom(rounded);

    // 1. Try html5-qrcode RangeCameraCapability
    if (supportsHardwareZoom && zoomFeatureRef.current) {
      try {
        await zoomFeatureRef.current.apply(rounded);
        return;
      } catch {
        // Fall through
      }
    }

    // 2. Try MediaTrackConstraints directly on scanner
    if (scannerRef.current?.applyVideoConstraints) {
      try {
        await scannerRef.current.applyVideoConstraints({ advanced: [{ zoom: rounded }] });
        return;
      } catch {
        // Fall through to digital zoom
      }
    }
  };

  // Software/Digital zoom CSS scaling on underlying video element when hardware zoom isn't active
  useEffect(() => {
    const container = document.getElementById(elementId);
    const video = container?.querySelector('video');
    if (video) {
      if (!supportsHardwareZoom && zoom > 1) {
        video.style.transform = `scale(${zoom})`;
        video.style.transformOrigin = 'center center';
        video.style.transition = 'transform 0.1s ease-out';
      } else {
        video.style.transform = '';
      }
    }
  }, [zoom, supportsHardwareZoom, elementId]);

  // Scanner lifecycle
  useEffect(() => {
    if (IS_MACOS_BUILD) {
      setError(isRtl
        ? 'مسح حضور الطالب بالكاميرا غير متاح في نسخة Mac التجريبية. اطلب من الأستاذ تسجيل الحضور يدوياً أو استخدم تطبيق الهاتف.'
        : 'Student camera scanning is not available in this Mac QA build. Ask the lecturer to record attendance manually or use the mobile app.');
      return;
    }
    let cancelled = false;
    let scanner: any;

    const setupDigitalZoomFallback = () => {
      setSupportsHardwareZoom(false);
      setMinZoom(1.0);
      setMaxZoom(3.5);
      setZoomStep(0.1);
      setZoom(1.0);
    };

    const start = async () => {
      try {
        const { Html5Qrcode } = await import('html5-qrcode');
        const devices = await Html5Qrcode.getCameras();
        if (cancelled) return;
        setCameras(devices);

        // Select camera: prefer back/rear/environment if available on first run
        let selectedCameraId: any = { facingMode: 'environment' };
        if (devices.length > 0) {
          if (cameraIndex < devices.length) {
            selectedCameraId = devices[cameraIndex].id;
          } else {
            const backIndex = devices.findIndex((d) => /back|rear|environment/i.test(d.label));
            const bestIndex = backIndex >= 0 ? backIndex : 0;
            setCameraIndex(bestIndex);
            selectedCameraId = devices[bestIndex].id;
          }
        }

        scanner = new Html5Qrcode(elementId, { verbose: false });
        scannerRef.current = scanner;

        await scanner.start(
          selectedCameraId,
          { fps: 15, qrbox: { width: 250, height: 250 }, aspectRatio: 1 },
          (decodedText: string) => {
            if (handledRef.current) return;
            handledRef.current = true;
            setScanSuccess(true);
            playSuccessChime();
            triggerHaptic();
            setTimeout(() => {
              if (!cancelled) scanRef.current(decodedText);
            }, 380);
          },
          () => undefined
        );

        if (cancelled) {
          await scanner.stop().catch(() => undefined);
          scanner.clear();
        } else {
          setIsScanning(true);

          // Probe camera capabilities for hardware zoom
          try {
            const caps = scanner.getRunningTrackCameraCapabilities?.();
            if (caps && typeof caps.zoomFeature === 'function') {
              const zoomFeat = caps.zoomFeature();
              if (zoomFeat && zoomFeat.isSupported()) {
                zoomFeatureRef.current = zoomFeat;
                setSupportsHardwareZoom(true);
                const min = zoomFeat.min();
                const max = Math.min(zoomFeat.max(), 8);
                const step = zoomFeat.step() || 0.1;
                setMinZoom(min);
                setMaxZoom(max);
                setZoomStep(step);
                setZoom(zoomFeat.value() || 1.0);
              } else {
                setupDigitalZoomFallback();
              }
            } else {
              setupDigitalZoomFallback();
            }
          } catch {
            setupDigitalZoomFallback();
          }
        }
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
      zoomFeatureRef.current = null;
      if (scanner?.isScanning) {
        void scanner.stop().catch(() => undefined).finally(() => scanner.clear());
      } else {
        scanner?.clear?.();
      }
    };
  }, [cameraIndex, elementId, isRtl]);

  // 8-second glare/distance heuristic assistant
  useEffect(() => {
    if (!isScanning) return;
    const timer = setTimeout(() => {
      if (!handledRef.current) {
        setShowGlareTip(true);
      }
    }, 8000);
    return () => clearTimeout(timer);
  }, [isScanning]);

  const switchCamera = async () => {
    if (cameras.length < 2) return;
    const scanner = scannerRef.current;
    if (scanner?.isScanning) await scanner.stop().catch(() => undefined);
    scanner?.clear?.();
    scannerRef.current = null;
    zoomFeatureRef.current = null;
    handledRef.current = false;
    setScanSuccess(false);
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

  // Pinch to Zoom handlers
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      touchStartDistRef.current = dist;
      zoomAtTouchStartRef.current = zoom;
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && touchStartDistRef.current !== null) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const scaleFactor = dist / touchStartDistRef.current;
      const targetZoom = zoomAtTouchStartRef.current * scaleFactor;
      void applyZoom(targetZoom);
    }
  };

  const handleTouchEnd = () => {
    touchStartDistRef.current = null;
  };

  // Zoom Preset pills (e.g. 1x, 2x, 3x)
  const zoomPresets = [1.0, 2.0, 3.0].filter((val) => val <= maxZoom);
  if (maxZoom >= 5.0 && !zoomPresets.includes(5.0)) {
    zoomPresets.push(5.0);
  }

  return (
    <div
      className="fixed inset-0 z-[120] bg-black/85 p-3 sm:p-4 flex items-center justify-center backdrop-blur-sm"
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      <div className="max-h-[96dvh] w-full max-w-md flex flex-col rounded-3xl bg-white dark:bg-zinc-900 p-4 sm:p-5 shadow-2xl border border-slate-200 dark:border-zinc-800 animate-in fade-in zoom-in-95 duration-200 overflow-y-auto">
        
        {/* Top Header Bar */}
        <div className="mb-3 flex items-center justify-between">
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

          <div className="flex items-center gap-1.5">
            {cameras.length > 1 && (
              <button
                type="button"
                onClick={switchCamera}
                title={isRtl ? 'تبديل الكاميرا' : 'Switch camera'}
                className="rounded-full p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 transition-colors"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
            )}

            <button
              type="button"
              onClick={toggleTorch}
              title={isRtl ? 'المصباح' : 'Torch'}
              className={`rounded-full p-2 transition-colors ${
                torch
                  ? 'bg-amber-100 text-amber-600 dark:bg-amber-950/60 dark:text-amber-400'
                  : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200'
              }`}
            >
              <Flashlight className={`h-4 w-4 ${torch ? 'fill-current' : ''}`} />
            </button>

            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 transition-colors"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Collapsible Disciplinary Security Warning Pill */}
        <div className="mb-3">
          <button
            type="button"
            onClick={() => setShowDisciplinaryDetails((v) => !v)}
            className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-red-950/40 border border-red-800/60 text-red-300 hover:bg-red-950/60 transition-colors text-start"
          >
            <div className="flex items-center gap-2 text-xs font-bold truncate">
              <ShieldAlert className="h-4 w-4 text-red-400 shrink-0" />
              <span className="truncate">
                {isRtl
                  ? 'تحذير أمني: الحضور مراقب بالبصمة الجغرافية والزمنية'
                  : 'Security Warning: Audited via GPS and timestamp'}
              </span>
            </div>
            <span className="text-[10px] text-red-400 underline shrink-0 font-medium">
              {showDisciplinaryDetails ? (isRtl ? 'إخفاء' : 'Hide') : (isRtl ? 'التفاصيل' : 'Details')}
            </span>
          </button>

          {showDisciplinaryDetails && (
            <div className="mt-2 p-3 rounded-xl bg-red-950 border border-red-800 text-xs font-bold leading-6 text-red-100 animate-in fade-in slide-in-from-top-1 duration-150">
              {ATTENDANCE_DISCIPLINARY_BANNER}
            </div>
          )}
        </div>

        {/* Viewfinder & Reticle Container */}
        <div
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          className="relative min-h-[300px] h-[320px] sm:h-[350px] w-full overflow-hidden rounded-2xl bg-black flex items-center justify-center select-none touch-none shadow-inner"
        >
          {/* HTML5 QR Code Mount Element */}
          <div
            id={elementId}
            className="w-full h-full min-h-[300px] overflow-hidden flex items-center justify-center [&_video]:max-w-none"
          />

          {/* Glare / Distance Smart Heuristic Tip Pill */}
          {showGlareTip && !scanSuccess && (
            <div className="absolute top-3 inset-x-3 z-20 flex items-start justify-between gap-2 p-2.5 rounded-xl bg-black/80 backdrop-blur-md border border-amber-400/50 text-amber-200 text-[11px] font-bold shadow-xl animate-in fade-in slide-in-from-top-2 duration-200">
              <div className="flex items-start gap-1.5">
                <Lightbulb className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                <span className="leading-snug">
                  {isRtl
                    ? 'الشاشة بعيدة؟ جرّب التكبير (2x) أو إمالة الهاتف لتفادي وهج إضاءة القاعة.'
                    : 'Screen far away? Try 2x zoom or tilt phone to avoid glare.'}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setShowGlareTip(false)}
                className="text-amber-300/80 hover:text-white p-0.5 shrink-0"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* Futuristic Reticle Frame */}
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center p-8">
            <div
              className={`relative w-56 h-56 rounded-3xl transition-all duration-300 flex items-center justify-center ${
                scanSuccess
                  ? 'border-4 border-emerald-400 bg-emerald-500/20 shadow-[0_0_40px_rgba(52,211,153,0.8)] scale-105'
                  : 'border-2 border-dashed border-teal-400/50'
              }`}
            >
              {/* Corner brackets */}
              <div
                className={`absolute -top-1 -start-1 w-6 h-6 border-t-4 border-s-4 rounded-tl-xl transition-colors ${
                  scanSuccess ? 'border-emerald-300' : 'border-teal-400'
                }`}
              />
              <div
                className={`absolute -top-1 -end-1 w-6 h-6 border-t-4 border-e-4 rounded-tr-xl transition-colors ${
                  scanSuccess ? 'border-emerald-300' : 'border-teal-400'
                }`}
              />
              <div
                className={`absolute -bottom-1 -start-1 w-6 h-6 border-b-4 border-s-4 rounded-bl-xl transition-colors ${
                  scanSuccess ? 'border-emerald-300' : 'border-teal-400'
                }`}
              />
              <div
                className={`absolute -bottom-1 -end-1 w-6 h-6 border-b-4 border-e-4 rounded-br-xl transition-colors ${
                  scanSuccess ? 'border-emerald-300' : 'border-teal-400'
                }`}
              />

              {/* Animated Laser Beam */}
              {!scanSuccess && (
                <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-transparent via-teal-400 to-transparent animate-bounce opacity-85" />
              )}

              {/* Success Checkmark Pop */}
              {scanSuccess && (
                <div className="animate-in zoom-in-75 duration-200 flex flex-col items-center justify-center gap-1.5 p-3 rounded-2xl bg-black/75 backdrop-blur-md border border-emerald-400/70 text-emerald-300 shadow-2xl">
                  <CheckCircle2 className="h-10 w-10 text-emerald-400 animate-pulse" />
                  <span className="text-xs font-black">
                    {isRtl ? 'تم التقاط الرمز!' : 'Code Verified!'}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Floating Zoom Value Badge */}
          <div className="absolute bottom-3 start-3 pointer-events-none z-10 px-2.5 py-1 rounded-full bg-black/60 backdrop-blur-md border border-white/10 text-white font-mono font-bold text-[11px] shadow">
            {zoom.toFixed(1)}x {supportsHardwareZoom ? '' : '• digital'}
          </div>
        </div>

        {/* Error message if any */}
        {error && (
          <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs font-bold text-amber-800 dark:bg-amber-950/40 dark:text-amber-200 border border-amber-200 dark:border-amber-900/40">
            {error}
          </p>
        )}

        {/* Camera Zoom Control Hub */}
        <div className="mt-3.5 space-y-2.5 bg-slate-50 dark:bg-zinc-800/60 p-3 rounded-2xl border border-slate-200 dark:border-zinc-800">
          {/* Quick Zoom Preset Buttons */}
          <div className="flex items-center justify-center gap-2">
            {zoomPresets.map((preset) => {
              const isActive = Math.abs(zoom - preset) < 0.2;
              return (
                <button
                  key={preset}
                  type="button"
                  onClick={() => void applyZoom(preset)}
                  className={`flex-1 py-1.5 px-3 rounded-xl text-xs font-black transition-all ${
                    isActive
                      ? 'bg-teal-600 text-white shadow-md shadow-teal-700/20 scale-[1.02]'
                      : 'bg-white dark:bg-zinc-700/80 text-slate-700 dark:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-700 border border-slate-200 dark:border-zinc-700'
                  }`}
                >
                  {preset}x
                </button>
              );
            })}
          </div>

          {/* Smooth Zoom Slider */}
          <div className="flex items-center gap-3 px-1">
            <button
              type="button"
              onClick={() => void applyZoom(zoom - 0.5)}
              disabled={zoom <= minZoom}
              className="text-slate-400 hover:text-slate-600 dark:text-zinc-400 dark:hover:text-zinc-200 disabled:opacity-30 transition-colors"
              title={isRtl ? 'تصغير' : 'Zoom out'}
            >
              <ZoomOut className="h-4 w-4" />
            </button>

            <input
              type="range"
              min={minZoom}
              max={maxZoom}
              step={zoomStep}
              value={zoom}
              onChange={(e) => void applyZoom(parseFloat(e.target.value))}
              className="w-full h-1.5 bg-slate-200 dark:bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-teal-600"
              aria-label={isRtl ? 'شريط التقريب' : 'Zoom slider'}
            />

            <button
              type="button"
              onClick={() => void applyZoom(zoom + 0.5)}
              disabled={zoom >= maxZoom}
              className="text-slate-400 hover:text-slate-600 dark:text-zinc-400 dark:hover:text-zinc-200 disabled:opacity-30 transition-colors"
              title={isRtl ? 'تكبير' : 'Zoom in'}
            >
              <ZoomIn className="h-4 w-4" />
            </button>
          </div>

          <p className="text-center text-[10px] text-slate-400 dark:text-zinc-400 font-medium">
            {isRtl
              ? 'يمكنك التكبير عبر اللمس بإصبعين (Pinch) أو الأزرار'
              : 'Pinch on camera view or use buttons to zoom'}
          </p>
        </div>

      </div>
    </div>
  );
}
