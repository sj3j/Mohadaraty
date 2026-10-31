import React from 'react';
import { useAudio } from '../contexts/AudioContext';
import { Play, Pause, X, Music, ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

export default function GlobalAudioPlayer({ isRtl }: { isRtl: boolean }) {
  const { currentTrack, isPlaying, progress, duration, currentTime, playTrack, pauseTrack, closePlayer, seek, playbackRate, setPlaybackRate, isPlayerHidden, setIsPlayerHidden } = useAudio();

  if (!currentTrack) return null;

  if (isPlayerHidden) {
    return (
      <AnimatePresence>
        <motion.div
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0, opacity: 0 }}
          className="fixed bottom-[calc(84px+env(safe-area-inset-bottom))] sm:bottom-[calc(92px+env(safe-area-inset-bottom))] right-4 md:bottom-6 md:right-8 z-[60]"
        >
          <button
            onClick={() => setIsPlayerHidden(false)}
            className="w-12 h-12 bg-[#2196F3] text-white rounded-full shadow-[0_4px_20px_rgba(33,150,243,0.4)] flex items-center justify-center hover:bg-[#1E88E5] transition-colors"
          >
            <Music className="w-5 h-5" />
          </button>
        </motion.div>
      </AnimatePresence>
    );
  }

  const formatTime = (time: number) => {
    if (isNaN(time) || time <= 0 || !isFinite(time)) return "0:00";
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };
  
  const cyclePlaybackRate = () => {
    const rates = [1, 1.5, 2, 2.5];
    const currentIndex = rates.indexOf(playbackRate);
    const nextRate = rates[(currentIndex + 1) % rates.length];
    setPlaybackRate(nextRate);
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ y: 150, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 150, opacity: 0 }}
        className="fixed bottom-[calc(84px+env(safe-area-inset-bottom))] sm:bottom-[calc(92px+env(safe-area-inset-bottom))] left-4 right-4 md:bottom-6 md:left-auto md:right-8 md:w-[22rem] z-[60] bg-white dark:bg-zinc-900 border border-slate-100 dark:border-zinc-800 rounded-[16px] shadow-[0_4px_24px_rgba(33,150,243,0.15)] flex flex-col p-3 overflow-hidden"
        dir={isRtl ? 'rtl' : 'ltr'}
      >
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 truncate">
            <div className="w-8 h-8 rounded-full bg-[#2196F3]/10 flex items-center justify-center shrink-0">
               <Music className="w-4 h-4 text-[#2196F3]" />
            </div>
            <p className="text-sm font-bold text-slate-800 dark:text-slate-200 truncate pr-2">
              {currentTrack.title}
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button 
              onClick={cyclePlaybackRate} 
              className="px-2 py-1 bg-slate-100 dark:bg-zinc-800 text-xs font-bold text-slate-600 dark:text-slate-300 rounded-md hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors mr-1"
            >
              {playbackRate}x
            </button>
            <button 
              onClick={() => setIsPlayerHidden(true)} 
              className="p-1 rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
            >
               <ChevronDown className="w-5 h-5" />
            </button>
            <button 
              onClick={closePlayer} 
              className="p-1 rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
            >
               <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => isPlaying ? pauseTrack() : playTrack(currentTrack)}
            className="w-10 h-10 flex items-center justify-center bg-[#2196F3] hover:bg-[#1E88E5] text-white rounded-full transition-colors shrink-0 shadow-sm"
          >
            {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
          </button>
          
          <div className="flex-1 min-w-0 flex flex-col justify-center gap-1">
            <div className="flex items-center gap-[2px] h-4 w-full cursor-pointer" onClick={(e) => {
               const rect = e.currentTarget.getBoundingClientRect();
               if (rect.width <= 0) return;
               const isElementRtl = window.getComputedStyle(e.currentTarget).direction === 'rtl';
               const x = e.clientX - rect.left;
               const rawPercentage = isElementRtl ? ((rect.width - x) / rect.width) * 100 : (x / rect.width) * 100;
               const percentage = Math.max(0, Math.min(100, isNaN(rawPercentage) ? 0 : rawPercentage));
               seek(percentage);
            }}>
               {Array.from({ length: 30 }).map((_, i) => {
                 const isActive = (i / 30) * 100 <= progress;
                 return (
                   <div 
                     key={i} 
                     className={`flex-1 rounded-full ${isActive ? 'bg-[#2196F3]' : 'bg-slate-200 dark:bg-zinc-700'}`}
                     style={{ height: isActive ? '100%' : '50%' }}
                   />
                 );
               })}
            </div>
            <div className="flex justify-between text-[10px] text-slate-500 font-bold tracking-wide">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
