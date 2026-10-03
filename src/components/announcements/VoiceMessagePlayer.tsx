import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Play, Pause, Loader2, AlertCircle } from 'lucide-react';
import { useAudio } from '../../contexts/AudioContext';
import type { Attachment } from '../../types/announcement.types';

interface Props {
  attachment: Attachment;
  isRtl: boolean;
}

const PLAYBACK_RATES = [1, 1.5, 2] as const;

/** Generate a consistent, natural-looking waveform profile for a voice note based on its id/name. */
function generateWaveformBars(seedStr: string, count = 34): number[] {
  let hash = 0;
  for (let i = 0; i < seedStr.length; i++) {
    hash = (hash << 5) - hash + seedStr.charCodeAt(i);
    hash |= 0;
  }
  const bars: number[] = [];
  for (let i = 0; i < count; i++) {
    // Produce varied bar heights between 20% and 95%
    const pseudoRandom = Math.abs(Math.sin((hash + i * 17) * 0.1));
    const wave = Math.sin((i / count) * Math.PI) * 0.4 + 0.6; // gentle bell curve
    const height = Math.max(22, Math.min(96, Math.round(pseudoRandom * wave * 100)));
    bars.push(height);
  }
  return bars;
}

function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0 || !isFinite(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export default function VoiceMessagePlayer({ attachment, isRtl }: Props) {
  const { pauseTrack: pauseGlobalTrack } = useAudio();

  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState<number>(attachment.duration ?? 0);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [hasError, setHasError] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const waveformRef = useRef<HTMLDivElement | null>(null);
  const isDraggingRef = useRef(false);

  const bars = useMemo(() => generateWaveformBars(attachment.id || attachment.name), [attachment.id, attachment.name]);

  // Handle single-active voice note across all cards
  useEffect(() => {
    const handleOtherVoicePlay = (e: Event) => {
      const customEvent = e as CustomEvent<{ id: string }>;
      if (customEvent.detail?.id !== attachment.id) {
        if (audioRef.current && !audioRef.current.paused) {
          audioRef.current.pause();
          setIsPlaying(false);
        }
      }
    };

    window.addEventListener('voice-message-play', handleOtherVoicePlay);
    return () => {
      window.removeEventListener('voice-message-play', handleOtherVoicePlay);
    };
  }, [attachment.id]);

  // Teardown audio on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
        audioRef.current = null;
      }
    };
  }, []);

  const getOrCreateAudio = useCallback(() => {
    if (!audioRef.current) {
      const audio = new Audio(attachment.url);
      audio.preload = 'metadata';

      audio.addEventListener('loadedmetadata', () => {
        if (audio.duration && isFinite(audio.duration)) {
          setDuration(audio.duration);
        }
        setIsLoading(false);
      });

      audio.addEventListener('timeupdate', () => {
        if (!isDraggingRef.current) {
          setCurrentTime(audio.currentTime);
        }
      });

      audio.addEventListener('waiting', () => setIsLoading(true));
      audio.addEventListener('playing', () => {
        setIsLoading(false);
        setIsPlaying(true);
      });

      audio.addEventListener('pause', () => setIsPlaying(false));

      audio.addEventListener('ended', () => {
        setIsPlaying(false);
        setCurrentTime(0);
        if (audioRef.current) audioRef.current.currentTime = 0;
      });

      audio.addEventListener('error', (err) => {
        console.warn('Voice playback failed for', attachment.name, err);
        setHasError(true);
        setIsLoading(false);
        setIsPlaying(false);
      });

      audioRef.current = audio;
    }
    return audioRef.current;
  }, [attachment.url, attachment.name]);

  const togglePlay = useCallback(async (e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (hasError) {
      setHasError(false);
      if (audioRef.current) {
        audioRef.current.load();
      }
    }

    const audio = getOrCreateAudio();

    if (isPlaying) {
      audio.pause();
    } else {
      // Pause any active lecture playing in the background
      pauseGlobalTrack();

      // Notify other voice note components to pause
      window.dispatchEvent(
        new CustomEvent('voice-message-play', { detail: { id: attachment.id } })
      );

      try {
        setIsLoading(true);
        audio.playbackRate = playbackRate;
        await audio.play();
      } catch (error) {
        console.warn('Playback error:', error);
        setHasError(true);
        setIsLoading(false);
      }
    }
  }, [isPlaying, hasError, getOrCreateAudio, pauseGlobalTrack, playbackRate, attachment.id]);

  const handleSeek = (percentage: number) => {
    const audio = getOrCreateAudio();
    const effectiveDuration = duration || audio.duration || 0;
    if (effectiveDuration > 0 && isFinite(effectiveDuration)) {
      const newTime = Math.max(0, Math.min(effectiveDuration, (percentage / 100) * effectiveDuration));
      audio.currentTime = newTime;
      setCurrentTime(newTime);
    }
  };

  const calculatePercentage = (clientX: number) => {
    if (!waveformRef.current) return 0;
    const rect = waveformRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    const pct = (x / rect.width) * 100;
    return Math.max(0, Math.min(100, pct));
  };

  const onWaveformPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    isDraggingRef.current = true;
    const pct = calculatePercentage(e.clientX);
    handleSeek(pct);

    const onPointerMove = (moveEvt: PointerEvent) => {
      if (isDraggingRef.current) {
        const movePct = calculatePercentage(moveEvt.clientX);
        handleSeek(movePct);
      }
    };

    const onPointerUp = () => {
      isDraggingRef.current = false;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  const cycleSpeed = (e: React.MouseEvent) => {
    e.stopPropagation();
    const currentIndex = PLAYBACK_RATES.indexOf(playbackRate as any);
    const nextRate = PLAYBACK_RATES[(currentIndex + 1) % PLAYBACK_RATES.length];
    setPlaybackRate(nextRate);
    if (audioRef.current) {
      audioRef.current.playbackRate = nextRate;
    }
  };

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
  const displayTime = isPlaying || currentTime > 0 ? formatTime(currentTime) : (duration > 0 ? formatTime(duration) : '0:00');

  if (hasError) {
    return (
      <div className="w-full my-2 p-3 rounded-2xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/40 flex items-center justify-between text-xs text-amber-700 dark:text-amber-300">
        <div className="flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />
          <span>{isRtl ? 'تعذر تشغيل التسجيل الصوتي' : 'Unable to play voice message'}</span>
        </div>
        <button
          type="button"
          onClick={togglePlay}
          className="px-2.5 py-1 font-bold bg-amber-100 dark:bg-amber-900/60 hover:bg-amber-200 text-amber-800 dark:text-amber-200 rounded-lg transition-colors"
        >
          {isRtl ? 'إعادة المحاولة' : 'Retry'}
        </button>
      </div>
    );
  }

  return (
    <div
      className="w-full my-2 p-2.5 sm:p-3 rounded-2xl bg-gradient-to-r from-sky-50 to-indigo-50/40 dark:from-zinc-900 dark:to-zinc-900/80 border border-sky-100/80 dark:border-zinc-800/80 shadow-xs flex items-center gap-3 transition-all select-none"
      dir="ltr" // Keep waveform left-to-right for intuitive audio timeline scrubbing
    >
      {/* Play/Pause Button */}
      <button
        type="button"
        onClick={togglePlay}
        aria-label={isPlaying ? (isRtl ? 'إيقاف مؤقت' : 'Pause') : (isRtl ? 'تشغيل' : 'Play')}
        className="w-11 h-11 shrink-0 rounded-full bg-sky-500 hover:bg-sky-600 active:scale-95 text-white flex items-center justify-center shadow-md shadow-sky-500/20 transition-all focus:outline-hidden"
      >
        {isLoading ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : isPlaying ? (
          <Pause className="w-5 h-5 fill-current" />
        ) : (
          <Play className="w-5 h-5 fill-current ml-0.5" />
        )}
      </button>

      {/* Waveform & Timeline */}
      <div className="flex-1 min-w-0 flex flex-col justify-center gap-1.5">
        <div
          ref={waveformRef}
          onPointerDown={onWaveformPointerDown}
          className="flex items-center gap-[2.5px] h-7 w-full cursor-pointer py-1 touch-none"
          title={isRtl ? 'انقر للتقديم أو التأخير' : 'Click to seek'}
        >
          {bars.map((barHeight, idx) => {
            const barPercent = (idx / (bars.length - 1)) * 100;
            const isFilled = barPercent <= progressPercent;

            return (
              <span
                key={idx}
                className={`flex-1 rounded-full transition-colors duration-100 ${
                  isFilled
                    ? 'bg-sky-500 dark:bg-sky-400'
                    : 'bg-slate-300/80 dark:bg-zinc-700/80 hover:bg-slate-400 dark:hover:bg-zinc-600'
                }`}
                style={{
                  height: `${barHeight}%`,
                  minWidth: '2px',
                }}
              />
            );
          })}
        </div>

        {/* Time display */}
        <div className="flex items-center justify-between text-[11px] font-semibold text-slate-500 dark:text-zinc-400 px-0.5">
          <span className="tabular-nums tracking-wide">{displayTime}</span>
          <span className="text-[10px] text-slate-400 dark:text-zinc-500">
            {isRtl ? 'رسالة صوتية' : 'Voice note'}
          </span>
        </div>
      </div>

      {/* Playback speed toggle */}
      <button
        type="button"
        onClick={cycleSpeed}
        className="px-2 py-1 text-[11px] font-black rounded-lg bg-white dark:bg-zinc-800 text-sky-600 dark:text-sky-400 border border-sky-200/60 dark:border-zinc-700 hover:bg-sky-50 dark:hover:bg-zinc-750 transition-colors shrink-0 tabular-nums shadow-2xs"
        title={isRtl ? 'سرعة التشغيل' : 'Playback speed'}
      >
        {playbackRate}x
      </button>
    </div>
  );
}
