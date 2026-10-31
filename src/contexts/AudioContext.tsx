import React, { createContext, useContext, useState, useRef, useEffect } from 'react';

interface AudioTrack {
  src: string;
  title: string;
  id: string; // to uniquely identify
}

interface AudioContextType {
  currentTrack: AudioTrack | null;
  isPlaying: boolean;
  progress: number;
  duration: number;
  currentTime: number;
  playTrack: (track: AudioTrack) => void;
  pauseTrack: () => void;
  resumeTrack: () => void;
  closePlayer: () => void;
  seek: (percentage: number) => void;
  playbackRate: number;
  setPlaybackRate: (rate: number) => void;
  isPlayerHidden: boolean;
  setIsPlayerHidden: (hidden: boolean) => void;
  isMuted: boolean;
  toggleMute: () => void;
}

const AudioContext = createContext<AudioContextType | null>(null);

export const useAudio = () => {
  const context = useContext(AudioContext);
  if (!context) throw new Error("useAudio must be used within AudioProvider");
  return context;
};

export const AudioProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [currentTrack, setCurrentTrack] = useState<AudioTrack | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playbackRate, setPlaybackRateState] = useState(1);
  const [isPlayerHidden, setIsPlayerHidden] = useState(false);
  const [isMuted, setIsMutedState] = useState(false);
  
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const toggleMute = () => {
    setIsMutedState((prev) => {
      const next = !prev;
      if (audioRef.current) {
        audioRef.current.muted = next;
      }
      return next;
    });
  };

  const setPlaybackRate = (rate: number) => {
    setPlaybackRateState(rate);
    if (audioRef.current) {
      audioRef.current.playbackRate = rate;
    }
  };

  useEffect(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
    }
    const audio = audioRef.current;
    audio.muted = isMuted;

    const updateProgress = () => {
      setCurrentTime(audio.currentTime);
      setProgress((audio.currentTime / audio.duration) * 100 || 0);
    };

    const handleLoadedMetadata = () => {
      setDuration(audio.duration);
    };

    const handleEnded = () => {
      setIsPlaying(false);
      setProgress(0);
      setCurrentTime(0);
    };

    const handleVolumeChange = () => {
      setIsMutedState(audio.muted);
    };

    audio.addEventListener('timeupdate', updateProgress);
    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('volumechange', handleVolumeChange);

    return () => {
      audio.removeEventListener('timeupdate', updateProgress);
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('volumechange', handleVolumeChange);
    };
  }, []);

  const playTrack = (track: AudioTrack) => {
    if (!audioRef.current) return;
    
    setIsPlayerHidden(false); // Unhide when playing a track

    if (currentTrack?.id === track.id) {
       const playPromise = audioRef.current.play();
       if (playPromise !== undefined) {
         playPromise.then(() => {
           setIsPlaying(true);
           if (audioRef.current) {
             audioRef.current.playbackRate = playbackRate;
             audioRef.current.muted = isMuted;
           }
         }).catch(console.warn);
       }
       return;
    }

    setCurrentTrack(track);
    audioRef.current.src = track.src;
    audioRef.current.muted = isMuted;
    audioRef.current.load(); // Safari compatibility
    const playPromise = audioRef.current.play();
    if (playPromise !== undefined) {
      playPromise.then(() => {
        setIsPlaying(true);
        if (audioRef.current) {
          audioRef.current.playbackRate = playbackRate;
          audioRef.current.muted = isMuted;
        }
      }).catch((error) => {
        console.warn('Playback failed', error);
      });
    }
  };

  const pauseTrack = () => {
    if (!audioRef.current) return;
    audioRef.current.pause();
    setIsPlaying(false);
  };

  const resumeTrack = () => {
    if (!audioRef.current) return;
    const playPromise = audioRef.current.play();
    if (playPromise !== undefined) {
      playPromise.then(() => {
        setIsPlaying(true);
        if (audioRef.current) {
          audioRef.current.playbackRate = playbackRate;
          audioRef.current.muted = isMuted;
        }
      }).catch(console.warn);
    }
  };

  const closePlayer = () => {
    if (!audioRef.current) return;
    audioRef.current.pause();
    audioRef.current.src = '';
    setCurrentTrack(null);
    setIsPlaying(false);
    setProgress(0);
    setCurrentTime(0);
  };

  const seek = (percentage: number) => {
    if (!audioRef.current || !duration || !isFinite(duration) || duration <= 0) return;
    if (isNaN(percentage) || !isFinite(percentage)) return;
    const clampedPercentage = Math.max(0, Math.min(100, percentage));
    const newTime = (clampedPercentage / 100) * duration;
    audioRef.current.currentTime = newTime;
    setCurrentTime(newTime);
    setProgress(clampedPercentage);
  };

  return (
    <AudioContext.Provider value={{
      currentTrack,
      isPlaying,
      progress,
      duration,
      currentTime,
      playTrack,
      pauseTrack,
      resumeTrack,
      closePlayer,
      seek,
      playbackRate,
      setPlaybackRate,
      isPlayerHidden,
      setIsPlayerHidden,
      isMuted,
      toggleMute
    }}>
      {children}
    </AudioContext.Provider>
  );
};
