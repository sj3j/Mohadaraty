import React from 'react';
import { FileText } from 'lucide-react';

interface PdfThumbnailCardProps {
  thumbnail: string | null;
  aspectRatio?: number;
  isLoading: boolean;
  error: boolean;
  onClick?: () => void;
  actionBadge?: React.ReactNode;
  actionLabel?: string;
  fallback: React.ReactNode;
  className?: string;
}

/**
 * Renders an auto-fitting slide preview card for lecture PDFs.
 * Dynamically adjusts to the slide's exact natural aspect ratio (widescreen 16:9, 4:3, etc.)
 * so horizontal slide text and headers are never cropped.
 */
export default function PdfThumbnailCard({
  thumbnail,
  aspectRatio,
  isLoading,
  error,
  onClick,
  actionBadge,
  actionLabel,
  fallback,
  className = '',
}: PdfThumbnailCardProps) {
  const effectiveRatio = aspectRatio && aspectRatio > 0.2 ? aspectRatio : 16 / 9;

  // If loading and we don't have a cached thumbnail yet, show skeleton shimmer
  if (isLoading && !thumbnail) {
    return (
      <div
        style={{ aspectRatio: `${effectiveRatio}` }}
        className={`w-full max-w-xs sm:max-w-sm mx-auto rounded-2xl bg-slate-100 dark:bg-zinc-800/80 border border-slate-200/80 dark:border-zinc-700/80 shadow-md relative overflow-hidden flex flex-col items-center justify-between p-3.5 animate-pulse ${className}`}
        aria-busy="true"
        aria-label="Loading PDF preview"
      >
        <div className="w-full flex items-center justify-between opacity-40">
          <div className="w-16 h-2 bg-slate-300 dark:bg-zinc-600 rounded-full" />
          <div className="w-4 h-4 rounded bg-slate-300 dark:bg-zinc-600" />
        </div>
        <div className="flex flex-col items-center justify-center opacity-40">
          <FileText className="w-9 h-9 text-slate-400 dark:text-zinc-500 mb-1" />
          <div className="w-24 h-1.5 bg-slate-300 dark:bg-zinc-600 rounded-full" />
        </div>
        <div className="w-full space-y-1.5 opacity-40">
          <div className="w-full h-2 bg-slate-300 dark:bg-zinc-600 rounded-full" />
          <div className="w-3/4 h-2 bg-slate-300 dark:bg-zinc-600 rounded-full" />
        </div>
      </div>
    );
  }

  // If there's an error or no thumbnail could be produced, display fallback icon
  if (error || !thumbnail) {
    return <>{fallback}</>;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      style={{ aspectRatio: `${effectiveRatio}` }}
      className={`group relative w-full max-w-xs sm:max-w-sm mx-auto rounded-2xl overflow-hidden bg-slate-900/5 dark:bg-zinc-950/60 border border-slate-200/90 dark:border-zinc-700/90 shadow-md hover:shadow-xl hover:border-sky-400 dark:hover:border-sky-500 transition-all duration-300 transform hover:-translate-y-0.5 active:scale-[0.99] cursor-pointer focus:outline-none focus:ring-2 focus:ring-sky-500/50 flex items-center justify-center ${className}`}
      title={actionLabel}
      aria-label={actionLabel || 'PDF Preview'}
    >
      <img
        src={thumbnail}
        alt="Lecture slide preview"
        className="w-full h-full object-contain select-none pointer-events-none"
        loading="lazy"
      />

      {/* Document format badge */}
      <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded text-[8px] sm:text-[9px] font-black tracking-wider uppercase bg-slate-900/80 text-white backdrop-blur-xs shadow-xs">
        PDF
      </div>

      {/* Interactive hover / focus action overlay */}
      <div className="absolute inset-0 bg-slate-950/45 opacity-0 group-hover:opacity-100 group-focus:opacity-100 transition-opacity duration-200 flex flex-col items-center justify-center p-3 text-white gap-1.5 backdrop-blur-[1px]">
        {actionBadge && (
          <div className="w-9 h-9 rounded-full bg-white/25 backdrop-blur-md flex items-center justify-center shadow-sm transform scale-90 group-hover:scale-100 transition-transform">
            {actionBadge}
          </div>
        )}
        {actionLabel && (
          <span className="text-[11px] font-bold text-center leading-tight drop-shadow-sm">
            {actionLabel}
          </span>
        )}
      </div>
    </button>
  );
}
