import React, { useState } from 'react';
import { FileText, Download, X } from 'lucide-react';
import { forceDownload } from '../../lib/utils';
import type { Attachment } from '../../types/announcement.types';
import VoiceMessagePlayer from './VoiceMessagePlayer';

export const isAudioAttachment = (attachment: Attachment): boolean => {
  if (attachment.kind === 'audio') return true;
  if (attachment.mime?.startsWith('audio/')) return true;
  return /\.(ogg|oga|opus|mp3|wav|m4a|aac)$/i.test(attachment.name || '');
};

/**
 * Attachments as the reader sees them.
 *
 * Images lay out as a Telegram-style album - one fills the width, two split it,
 * three or more become a square grid with a "+N" cap on the fourth tile. Videos
 * and documents always get their own full-width row, because a video thumbnail
 * inside a 3-up grid is too small to tell what it is.
 */

const humanSize = (bytes: number): string => {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

interface Props {
  attachments: Attachment[];
  isRtl: boolean;
}

export default function AttachmentGrid({ attachments, isRtl }: Props) {
  const [lightbox, setLightbox] = useState<Attachment | null>(null);

  if (!attachments?.length) return null;

  const images = attachments.filter(a => a.kind === 'image');
  const videos = attachments.filter(a => a.kind === 'video');
  const audios = attachments.filter(isAudioAttachment);
  const files = attachments.filter(a => a.kind === 'file' && !isAudioAttachment(a));

  const visible = images.slice(0, 4);
  const overflow = images.length - visible.length;

  const gridClass =
    images.length === 1 ? 'grid-cols-1'
    : images.length === 2 ? 'grid-cols-2'
    : 'grid-cols-2';

  return (
    <>
      {images.length > 0 && (
        <div className={`grid ${gridClass} gap-1 rounded-xl overflow-hidden mb-2`}>
          {visible.map((image, i) => (
            <button
              key={image.id}
              type="button"
              onClick={() => setLightbox(image)}
              className={`relative bg-slate-100 dark:bg-zinc-800 ${
                images.length === 3 && i === 0 ? 'col-span-2' : ''
              }`}
            >
              <img
                src={image.url}
                alt={image.name}
                loading="lazy"
                referrerPolicy="no-referrer"
                className={`w-full object-cover ${images.length === 1 ? 'max-h-[280px]' : 'h-32 sm:h-36'}`}
              />
              {overflow > 0 && i === visible.length - 1 && (
                <span className="absolute inset-0 bg-black/55 text-white text-xl font-black flex items-center justify-center">
                  +{overflow}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {videos.map(video => (
        <div key={video.id} className="rounded-xl overflow-hidden mb-2 bg-black">
          <video src={video.url} controls preload="metadata" className="w-full h-auto max-h-[280px] object-contain" />
        </div>
      ))}

      {audios.map(audio => (
        <VoiceMessagePlayer key={audio.id} attachment={audio} isRtl={isRtl} />
      ))}

      {files.map(file => (
        <button
          key={file.id}
          type="button"
          onClick={() => forceDownload(file.url, file.name)}
          className="mt-1.5 w-full flex items-center gap-3 p-2.5 rounded-xl bg-slate-50 dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-700/50 hover:bg-slate-100 dark:hover:bg-zinc-800/80 transition-colors text-start"
        >
          <span className="w-9 h-9 shrink-0 rounded-lg bg-sky-100 dark:bg-sky-900/40 text-sky-600 dark:text-sky-400 flex items-center justify-center">
            <FileText className="w-4 h-4" strokeWidth={2.5} />
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-sm font-bold text-slate-800 dark:text-slate-200 truncate" dir="auto">{file.name}</span>
            <span className="block text-[11px] text-slate-500 dark:text-slate-400">
              {humanSize(file.size)} · {isRtl ? 'اضغط للتحميل' : 'Tap to download'}
            </span>
          </span>
          <Download className="w-4 h-4 shrink-0 text-slate-400" />
        </button>
      ))}

      {lightbox && (
        <div
          className="fixed inset-0 z-[220] bg-black/90 flex items-center justify-center p-4"
          onClick={() => setLightbox(null)}
          role="dialog"
          aria-modal="true"
        >
          <button
            type="button"
            onClick={() => setLightbox(null)}
            aria-label={isRtl ? 'إغلاق' : 'Close'}
            className="absolute top-[calc(env(safe-area-inset-top)+0.75rem)] end-3 w-10 h-10 rounded-full bg-white/10 text-white flex items-center justify-center"
          >
            <X className="w-5 h-5" />
          </button>
          <img
            src={lightbox.url}
            alt={lightbox.name}
            onClick={e => e.stopPropagation()}
            className="max-w-full max-h-full object-contain rounded-lg"
          />
        </div>
      )}
    </>
  );
}
