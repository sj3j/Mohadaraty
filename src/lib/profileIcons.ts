/**
 * Icon registry for the profile screen.
 *
 * Ported from Varmacy's src/lib/profileIcons.ts, with one difference that
 * matters: Varmacy is light-only and remaps its greys through a theme class,
 * while this app has real dark mode and uses explicit `dark:` variants
 * everywhere. So every tile here carries both halves.
 *
 * Plain data, no JSX, so the stat tiles, the admin rows and anything else can
 * share one definition - a metric must not show one picture in one place and a
 * different one somewhere else.
 */
import {
  Award,
  BarChart3,
  Flame,
  GraduationCap,
  Hash,
  Shield,
  Trophy,
  Users,
  type LucideIcon,
} from 'lucide-react';

export interface ProfileIcon {
  Icon: LucideIcon;
  /** Foreground colour. Split from the tile so a muted state can drop the tint
   *  and keep the shape. */
  className: string;
  tile: string;
}

/**
 * Colour classes are written out in full rather than built from a hue variable,
 * because Tailwind scans source text for complete class names. A template-built
 * `bg-${hue}-100` never reaches the stylesheet and the tile renders transparent.
 */
export const STAT_ICONS = {
  streak: { Icon: Flame, className: 'text-orange-600 dark:text-orange-400', tile: 'bg-orange-100 dark:bg-orange-900/30' },
  longest: { Icon: Award, className: 'text-amber-600 dark:text-amber-400', tile: 'bg-amber-100 dark:bg-amber-900/30' },
  shields: { Icon: Shield, className: 'text-sky-600 dark:text-sky-400', tile: 'bg-sky-100 dark:bg-sky-900/30' },
  rank: { Icon: Trophy, className: 'text-amber-600 dark:text-amber-400', tile: 'bg-amber-100 dark:bg-amber-900/30' },
  degree: { Icon: BarChart3, className: 'text-rose-600 dark:text-rose-400', tile: 'bg-rose-100 dark:bg-rose-900/30' },
  examCode: { Icon: Hash, className: 'text-indigo-600 dark:text-indigo-400', tile: 'bg-indigo-100 dark:bg-indigo-900/30' },
  group: { Icon: Users, className: 'text-emerald-600 dark:text-emerald-400', tile: 'bg-emerald-100 dark:bg-emerald-900/30' },
  stage: { Icon: GraduationCap, className: 'text-violet-600 dark:text-violet-400', tile: 'bg-violet-100 dark:bg-violet-900/30' },
} satisfies Record<string, ProfileIcon>;
