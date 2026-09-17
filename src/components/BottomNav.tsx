import React from 'react';
import { Bell, BookOpen, User, Trophy, Sparkles } from 'lucide-react';
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
    { id: 'simosan', icon: Sparkles, label: isRtl ? 'سيموسان' : 'Simosan' },
    { id: 'leaderboard', icon: Trophy, label: isRtl ? 'المتصدرين' : 'Leaderboard', isFab: true },
    { id: 'announcements', icon: Bell, label: isRtl ? 'التبليغات' : 'Alerts' },
    { id: 'profile', icon: User, label: isRtl ? 'الملف الشخصي' : 'Profile' },
  ];

  return (
    <div className="fixed bottom-0 left-0 right-0 pointer-events-none pb-[calc(1rem+env(safe-area-inset-bottom))] sm:pb-[calc(1.5rem+env(safe-area-inset-bottom))] px-4 z-50 flex justify-center">
      <div 
        className="flex justify-around items-center h-[72px] w-full max-w-md bg-white dark:bg-zinc-900 rounded-[36px] px-2 shadow-[0_8px_30px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.5)] pointer-events-auto border border-slate-100 dark:border-zinc-800" 
        dir={isRtl ? 'rtl' : 'ltr'}
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = currentTab === tab.id || (tab.id === 'home' && (currentTab === 'lectures' || currentTab === 'weekly'));
          
          if (tab.isFab) {
             return (
               <div key={tab.id} className="relative -top-6">
                 <button
                   onClick={() => setCurrentTab(tab.id)}
                   className="w-[60px] h-[60px] bg-[#2196F3] rounded-full flex items-center justify-center shadow-lg shadow-blue-500/30 border-4 border-white dark:border-zinc-900 text-white hover:scale-105 active:scale-95 transition-all"
                 >
                   <Icon className="w-7 h-7" />
                 </button>
               </div>
             );
          }
          
          return (
            <button
              key={tab.id}
              onClick={() => setCurrentTab(tab.id)}
              className={`flex flex-col items-center justify-center w-14 h-full relative transition-all group ${
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
              <span className={`text-[10px] font-medium transition-all ${isActive ? 'font-bold opacity-100' : 'opacity-70'}`}>
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
    </div>
  );
}
