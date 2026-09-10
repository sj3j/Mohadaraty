// Icon registry for the Settings screens.
//
// Plain data, no JSX, so any renderer can share it - the same shape Varmacy
// uses. Each entry pairs a lucide glyph with a foreground colour and the tint
// of the plate it sits on.
//
// Tailwind must see every class as a literal to emit it, so these are written
// out in full rather than composed like `bg-${hue}-100`.
import {
  Bell, Palette, Languages, ShieldCheck, User, Flame, Trophy, CreditCard,
  GraduationCap, CalendarDays, Users, FileText, HardDrive, Crown, LogOut,
  Ban, Info, Shield, BookOpen, Inbox, Layers, Sparkles, KeyRound, Send, type LucideIcon,
} from 'lucide-react';

export interface SettingsIcon {
  Icon: LucideIcon;
  /** Colour of the glyph. */
  className: string;
  /** Tint of the plate behind it. */
  tile: string;
}

export const SETTINGS_ICONS: Record<string, SettingsIcon> = {
  // --- student-facing -------------------------------------------------------
  account:       { Icon: User,          className: 'text-sky-500',     tile: 'bg-sky-100 dark:bg-sky-900/30' },
  appearance:    { Icon: Palette,       className: 'text-violet-500',  tile: 'bg-violet-100 dark:bg-violet-900/30' },
  language:      { Icon: Languages,     className: 'text-cyan-500',    tile: 'bg-cyan-100 dark:bg-cyan-900/30' },
  notifications: { Icon: Bell,          className: 'text-amber-500',   tile: 'bg-amber-100 dark:bg-amber-900/30' },
  inbox:         { Icon: Inbox,         className: 'text-sky-500',     tile: 'bg-sky-100 dark:bg-sky-900/30' },
  privacy:       { Icon: ShieldCheck,   className: 'text-indigo-500',  tile: 'bg-indigo-100 dark:bg-indigo-900/30' },
  blocked:       { Icon: Ban,           className: 'text-rose-500',    tile: 'bg-rose-100 dark:bg-rose-900/30' },
  streak:        { Icon: Flame,         className: 'text-orange-500',  tile: 'bg-orange-100 dark:bg-orange-900/30' },
  grades:        { Icon: Trophy,        className: 'text-emerald-500', tile: 'bg-emerald-100 dark:bg-emerald-900/30' },
  subscription:  { Icon: CreditCard,    className: 'text-fuchsia-500', tile: 'bg-fuchsia-100 dark:bg-fuchsia-900/30' },
  // Store builds show this instead of `subscription`. A credit-card glyph is
  // payment iconography on a screen that must not offer a payment.
  access:        { Icon: KeyRound,      className: 'text-fuchsia-500', tile: 'bg-fuchsia-100 dark:bg-fuchsia-900/30' },
  about:         { Icon: Info,          className: 'text-slate-500',   tile: 'bg-slate-100 dark:bg-zinc-800' },
  logout:        { Icon: LogOut,        className: 'text-rose-500',    tile: 'bg-rose-100 dark:bg-rose-900/30' },

  // --- staff ----------------------------------------------------------------
  calendar:      { Icon: CalendarDays,  className: 'text-sky-500',     tile: 'bg-sky-100 dark:bg-sky-900/30' },
  simosan:       { Icon: Sparkles,      className: 'text-violet-500',  tile: 'bg-violet-100 dark:bg-violet-900/30' },
  students:      { Icon: Users,         className: 'text-emerald-500', tile: 'bg-emerald-100 dark:bg-emerald-900/30' },
  assistants:    { Icon: Shield,        className: 'text-indigo-500',  tile: 'bg-indigo-100 dark:bg-indigo-900/30' },
  streakAdmin:   { Icon: Flame,         className: 'text-orange-500',  tile: 'bg-orange-100 dark:bg-orange-900/30' },
  gradesAdmin:   { Icon: HardDrive,     className: 'text-fuchsia-500', tile: 'bg-fuchsia-100 dark:bg-fuchsia-900/30' },
  logs:          { Icon: FileText,      className: 'text-slate-500',   tile: 'bg-slate-100 dark:bg-zinc-800' },
  subsAdmin:     { Icon: Crown,         className: 'text-amber-500',   tile: 'bg-amber-100 dark:bg-amber-900/30' },
  progression:   { Icon: GraduationCap, className: 'text-violet-500',  tile: 'bg-violet-100 dark:bg-violet-900/30' },
  subjects:      { Icon: BookOpen,      className: 'text-teal-500',    tile: 'bg-teal-100 dark:bg-teal-900/30' },
  stage:         { Icon: Layers,        className: 'text-sky-500',     tile: 'bg-sky-100 dark:bg-sky-900/30' },
  telegram:      { Icon: Send,          className: 'text-cyan-500',    tile: 'bg-cyan-100 dark:bg-cyan-900/30' },
};
