import React from 'react';
import { Play, Pause, Download, Volume2, VolumeX } from 'lucide-react';
import { forceDownload } from '../lib/utils';
import { useAudio } from '../contexts/AudioContext';
import { motion } from 'motion/react';

interface AudioPlayerProps {
  id: string; // added id prop
  src: string;
  title: string;
}

export default function AudioPlayer({ id, src, title }: AudioPlayerProps) {
  const {
    currentTrack,
    isPlaying,
    progress,
    duration,
    currentTime,
    playTrack,
    pauseTrack,
    seek,
    playbackRate,
    setPlaybackRate,
    isMuted,
    toggleMute,
  } = useAudio();

  const isThisPlaying = currentTrack?.id === id;
  const isThisActive = currentTrack?.id === id;

  const currentDuration = isThisActive ? duration : 0;
  const currentProgress = isThisActive ? progress : 0;
  const currentCurrentTime = isThisActive ? currentTime : 0;
  const currentIsPlaying = isThisActive && isPlaying;

  const togglePlay = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (currentIsPlaying) {
      pauseTrack();
    } else {
      playTrack({ id, src, title });
    }
  };

  const handleSeek = (percentage: number) => {
    if (isThisActive) {
      seek(percentage);
    }
  };

  const cyclePlaybackRate = () => {
    const rates = [1, 1.5, 2, 2.5];
    const currentIndex = rates.indexOf(playbackRate);
    const nextRate = rates[(currentIndex + 1) % rates.length];
    setPlaybackRate(nextRate);
  };


  const formatTime = (time: number) => {
    if (isNaN(time) || time <= 0 || !isFinite(time)) return "0:00";
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  return (
    <div className="bg-slate-50 dark:bg-zinc-900 rounded-[12px] p-4">
      <div className="flex items-center gap-4 mb-3">
        <button
          onClick={togglePlay}
          type="button"
          style={{ touchAction: 'manipulation' }}
          className="w-12 h-12 flex items-center justify-center bg-[#2196F3] hover:bg-[#1E88E5] text-white rounded-full transition-colors shrink-0 shadow-[0_2px_8px_rgba(33,150,243,0.3)]"
        >
          {currentIsPlaying ? <Pause className="w-5 h-5 pointer-events-none" /> : <Play className="w-5 h-5 ml-1 pointer-events-none" />}
        </button>
        
        <div className="flex-1 min-w-0 flex flex-col justify-center">
          {/* Visual Waveform Placeholder */}
          <div className="flex items-center gap-[2px] h-6 w-full mb-2 cursor-pointer" onClick={(e) => {
             const rect = e.currentTarget.getBoundingClientRect();
             if (rect.width <= 0) return;
             const isElementRtl = window.getComputedStyle(e.currentTarget).direction === 'rtl';
             const x = e.clientX - rect.left;
             const rawPercentage = isElementRtl ? ((rect.width - x) / rect.width) * 100 : (x / rect.width) * 100;
             const percentage = Math.max(0, Math.min(100, isNaN(rawPercentage) ? 0 : rawPercentage));
             handleSeek(percentage);
          }}>
             {Array.from({ length: 40 }).map((_, i) => {
               const isActive = (i / 40) * 100 <= currentProgress;
               const baseHeight = Math.max(10, Math.sin(i * 0.4) * 100);
               return (
                 <motion.div 
                   key={i} 
                   animate={currentIsPlaying ? {
                     height: [`${Math.max(10, baseHeight * 0.7)}%`, `${Math.min(100, baseHeight * 1.3)}%`, `${baseHeight}%`]
                   } : {
                     height: `${baseHeight}%`
                   }}
                   transition={{
                     repeat: Infinity,
                     duration: 0.8,
                     delay: i * 0.05,
                     ease: "easeInOut"
                   }}
                   className={`flex-1 rounded-full ${isActive ? 'bg-[#2196F3]' : 'bg-slate-200 dark:bg-zinc-700'}`}
                   style={{ height: `${baseHeight}%` }}
                 />
               );
             })}
          </div>
          <div className="flex justify-between text-xs text-slate-500 dark:text-slate-400 font-medium tracking-wide">
            <span>{formatTime(currentCurrentTime)}</span>
            <span className="bg-slate-200 dark:bg-zinc-700 text-slate-700 dark:text-slate-300 px-2 rounded-md font-bold">{isThisActive ? formatTime(currentDuration) : '--:--'}</span>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between pt-3 border-t border-slate-200 dark:border-zinc-800">
        <div className="flex items-center gap-1">
          <button
            onClick={toggleMute}
            aria-label={isMuted ? 'Unmute' : 'Mute'}
            className="p-2 text-slate-500 hover:text-[#2196F3] dark:hover:text-[#2196F3] transition-colors rounded-full hover:bg-slate-100 dark:hover:bg-zinc-800"
          >
            {isMuted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
          </button>
          
          <button
            onClick={cyclePlaybackRate}
            className="px-2 py-1 bg-slate-100 dark:bg-zinc-800 text-xs font-bold text-slate-600 dark:text-slate-300 rounded-md hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors"
          >
            {playbackRate}x
          </button>
        </div>
        
        <button
          onClick={(e) => {
            e.preventDefault();
            forceDownload(src, title + '.mp3');
          }}
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-bold text-[#2196F3] bg-[#2196F3]/10 hover:bg-[#2196F3]/20 rounded-full transition-colors"
        >
          <Download className="w-4 h-4" />
          Download
        </button>
      </div>
    </div>
  );
}
