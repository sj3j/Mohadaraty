import React from 'react';
import { Bell, BookOpen, User, Trophy, LayoutGrid } from 'lucide-react';
import { Language, TRANSLATIONS } from '../types';
import { motion } from 'motion/react';

export type Tab = 'home' | 'announcements' | 'leaderboard' | 'simosan' | 'profile' | 'subscription' | 'settings';

interface BottomNavProps {
  currentTab: Tab | 'weekly' | 'lectures'; // keep old tabs for backwards compat if needed temporarily
  setCurrentTab: (tab: any) => void;
  lang: Language;
  hasUnreadAnnouncements?: boolean;
  /** Unread admin inbox. The inbox lives under Profile -> Settings now that the
   *  app header that used to carry its badge is gone, so the badge has to travel
   *  with it or a new message is three taps deep and completely silent. */
  hasUnreadInbox?: boolean;
}

export default function BottomNav({ currentTab, setCurrentTab, lang, hasUnreadAnnouncements, hasUnreadInbox }: BottomNavProps) {
  const isRtl = lang === 'ar';

  const tabs = [
    { id: 'home', icon: BookOpen, label: isRtl ? 'قسم الدراسة' : 'Study' },
    { id: 'simosan', icon: LayoutGrid, label: isRtl ? 'الخدمات' : 'Services' },
    { id: 'leaderboard', icon: Trophy, label: isRtl ? 'المتصدرين' : 'Leaderboard', isFab: true },
    { id: 'announcements', icon: Bell, label: isRtl ? 'التبليغات' : 'Alerts' },
    { id: 'profile', icon: User, label: isRtl ? 'الملف الشخصي' : 'Profile' },
  ];

  return (
    <nav
      aria-label={isRtl ? 'التنقل الرئيسي' : 'Primary navigation'}
      className="fixed bottom-0 left-0 right-0 pointer-events-none pb-[calc(var(--bottom-nav-gap)+env(safe-area-inset-bottom))] px-[clamp(0.5rem,3vw,1rem)] z-50 flex justify-center"
    >
      <div 
        className="flex items-center h-[var(--bottom-nav-height)] w-full max-w-md bg-white dark:bg-zinc-900 rounded-[calc(var(--bottom-nav-height)/2)] px-[clamp(0.125rem,1vw,0.5rem)] shadow-[0_8px_30px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.5)] pointer-events-auto border border-slate-100 dark:border-zinc-800" 
        dir={isRtl ? 'rtl' : 'ltr'}
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = currentTab === tab.id || (tab.id === 'home' && (currentTab === 'lectures' || currentTab === 'weekly'));
          
          if (tab.isFab) {
             return (
               <div key={tab.id} className="relative -top-[clamp(1rem,5vw,1.5rem)] flex flex-1 min-w-0 justify-center">
                 <button
                   onClick={() => setCurrentTab(tab.id)}
                   aria-label={tab.label}
                   className="size-[clamp(3.25rem,16vw,3.75rem)] bg-[#2196F3] rounded-full flex items-center justify-center shadow-lg shadow-blue-500/30 border-[clamp(3px,1vw,4px)] border-white dark:border-zinc-900 text-white hover:scale-105 active:scale-95 transition-all"
                 >
                   <Icon className="size-[clamp(1.5rem,7vw,1.75rem)]" />
                 </button>
               </div>
             );
          }
          
          return (
            <button
              key={tab.id}
              onClick={() => setCurrentTab(tab.id)}
              className={`flex flex-1 min-w-0 flex-col items-center justify-center h-full px-0.5 relative transition-all group ${
                isActive ? 'text-[#2196F3]' : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'
              }`}
            >
              <div className="relative mb-1">
                <Icon className={`w-6 h-6 transition-all ${isActive ? 'fill-current stroke-[1.5px]' : 'stroke-2'}`} />
                {tab.id === 'announcements' && hasUnreadAnnouncements && (
                  <span className="absolute -top-1 -right-0.5 w-2.5 h-2.5 bg-red-500 border-2 border-white dark:border-[#1A1A2E] rounded-full"></span>
                )}
                {tab.id === 'profile' && hasUnreadInbox && (
                  <span className="absolute -top-1 -right-0.5 w-2.5 h-2.5 bg-red-500 border-2 border-white dark:border-[#1A1A2E] rounded-full"></span>
                )}
              </div>
              <span className={`max-w-full truncate text-[clamp(8px,2.6vw,10px)] leading-tight font-medium transition-all ${isActive ? 'font-bold opacity-100' : 'opacity-70'}`}>
                {tab.label}
              </span>
              {isActive && (
                <motion.div 
                   layoutId="bottom-nav-indicator"
                   className="absolute bottom-2 w-1.5 h-1.5 bg-[#2196F3] rounded-full"
                />
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
