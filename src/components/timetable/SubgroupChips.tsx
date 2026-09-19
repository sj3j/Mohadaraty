/**
 * Who attends a session, as chips.
 *
 * The "الجميع" chip is not a subgroup - it clears the selection to `[]`, which
 * is how a stage-wide session is stored. That is deliberately NOT the same as
 * ticking every subgroup: an expanded list freezes the group structure at edit
 * time, so a group added to the stage later would silently stop seeing a
 * lecture everyone is supposed to attend. Selecting every chip individually
 * therefore collapses back to الجميع, which is also what the parser does.
 */
import React from 'react';
import { Users } from 'lucide-react';
import { subgroupOptions, type GroupConfigLike } from '../../../shared/groups';

interface SubgroupChipsProps {
  value: string[];
  onChange: (next: string[]) => void;
  config: GroupConfigLike;
  isRtl: boolean;
}

export default function SubgroupChips({ value, onChange, config, isRtl }: SubgroupChipsProps) {
  const options = subgroupOptions(config);
  const universal = !value || value.length === 0;

  const toggle = (subgroup: string) => {
    const next = value.includes(subgroup)
      ? value.filter(v => v !== subgroup)
      : [...value, subgroup];
    // Every subgroup selected means everyone - store it the way everyone is
    // stored, not as a snapshot of today's groups.
    onChange(next.length === options.length ? [] : next);
  };

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <button
        type="button"
        onClick={() => onChange([])}
        className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-bold transition-colors ${
          universal
            ? 'bg-sky-500 text-white'
            : 'bg-slate-100 dark:bg-zinc-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-zinc-600'
        }`}
      >
        <Users className="w-3 h-3" />
        {isRtl ? 'الجميع' : 'Everyone'}
      </button>

      {options.map(option => {
        const on = !universal && value.includes(option);
        return (
          <button
            key={option}
            type="button"
            onClick={() => toggle(option)}
            dir="ltr"
            className={`px-2 py-1 rounded-lg text-xs font-bold transition-colors ${
              on
                ? 'bg-emerald-500 text-white'
                : 'bg-slate-100 dark:bg-zinc-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-zinc-600'
            }`}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}
