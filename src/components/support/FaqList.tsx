import React, { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { Language } from '../../types';
import { FAQ_ITEMS, SUPPORT_CHANNELS, SUPPORT_PROMPT } from '../../lib/support';

/**
 * The FAQ itself: a card of expandable questions, then the support accounts.
 *
 * Rendered by the Settings sub-page and by the FAQ sheet on the login and
 * signup screens, so it takes `lang` directly and reads no context - the auth
 * screens mount before any provider does.
 *
 * Visually it is the settings card: a muted heading over a rounded card whose
 * rows are separated by hairlines, with the same 36px icon plate. Mirroring
 * comes from the ancestor's `dir`; the chevron is the one thing direction
 * cannot flip, and it rotates rather than points, so it needs no swap.
 */
export default function FaqList({ lang }: { lang: Language }) {
  const isRtl = lang === 'ar';
  const [open, setOpen] = useState<string | null>(FAQ_ITEMS[0]?.id ?? null);

  return (
    <div className="space-y-6">
      <section>
        <div className="bg-white dark:bg-zinc-900 border-2 border-slate-100 dark:border-zinc-800 rounded-2xl overflow-hidden shadow-sm divide-y-2 divide-slate-100 dark:divide-zinc-800">
          {FAQ_ITEMS.map(item => {
            const expanded = open === item.id;
            return (
              <div key={item.id}>
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : item.id)}
                  aria-expanded={expanded}
                  className="w-full flex items-center gap-3 px-4 py-4 text-start transition-colors hover:bg-slate-50 dark:hover:bg-zinc-800/60 active:bg-slate-100 dark:active:bg-zinc-800"
                >
                  <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${item.tile}`}>
                    <item.icon className={`w-5 h-5 ${item.className}`} strokeWidth={2.5} />
                  </div>
                  <span className="flex-1 min-w-0 font-bold text-[15px] leading-snug text-slate-800 dark:text-slate-100">
                    {isRtl ? item.question.ar : item.question.en}
                  </span>
                  <ChevronDown
                    className={`w-5 h-5 shrink-0 text-slate-300 dark:text-zinc-600 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
                    strokeWidth={2.5}
                  />
                </button>

                <AnimatePresence initial={false}>
                  {expanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2, ease: 'easeOut' }}
                      className="overflow-hidden"
                    >
                      {/* Indented past the plate (16px padding + 36px plate +
                          12px gap) so the answer hangs under the question text. */}
                      <p className="ps-16 pe-4 pb-4 -mt-1 text-sm font-medium leading-relaxed text-slate-500 dark:text-slate-400">
                        {isRtl ? item.answer.ar : item.answer.en}
                      </p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="text-xs font-black uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-2 px-1">
          {isRtl ? SUPPORT_PROMPT.ar : SUPPORT_PROMPT.en}
        </h2>
        <div className="bg-white dark:bg-zinc-900 border-2 border-slate-100 dark:border-zinc-800 rounded-2xl overflow-hidden shadow-sm divide-y-2 divide-slate-100 dark:divide-zinc-800">
          {SUPPORT_CHANNELS.map(channel => (
            <a
              key={channel.id}
              href={channel.url}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full flex items-center gap-3 px-4 py-4 text-start transition-colors hover:bg-slate-50 dark:hover:bg-zinc-800/60 active:bg-slate-100 dark:active:bg-zinc-800"
            >
              <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${channel.tile}`}>
                <channel.icon className={`w-5 h-5 ${channel.className}`} strokeWidth={2.5} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-bold text-[15px] leading-snug truncate text-slate-800 dark:text-slate-100">
                  {isRtl ? channel.label.ar : channel.label.en}
                </div>
                {/* <bdi>, not dir="auto": a handle like "@Varmacybot" needs to
                    read left-to-right, but the row itself stays aligned with the
                    label above it, which dir="auto" would flip to the far edge. */}
                <div className="text-xs font-bold text-slate-400 dark:text-slate-500 leading-snug mt-0.5 truncate">
                  <bdi>{isRtl ? channel.sublabel.ar : channel.sublabel.en}</bdi>
                </div>
              </div>
              <ExternalLink className="w-4 h-4 text-slate-300 dark:text-zinc-600 shrink-0" strokeWidth={2.5} />
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}
