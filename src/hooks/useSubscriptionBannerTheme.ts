import { useState, useEffect } from 'react';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { UserProfile } from '../types';

export type BannerThemeId = 'gold' | 'pink' | 'black' | 'white';

export interface BannerThemeConfig {
  id: BannerThemeId;
  nameAr: string;
  nameEn: string;
  cardBg: string;
  cardBorder: string;
  shadow: string;
  badgeBg: string;
  textMuted: string;
  accentButton: string;
  shimmerColor: string;
  swatchPreview: string;
  iconBg: string;
}

export const BANNER_THEMES: Record<BannerThemeId, BannerThemeConfig> = {
  gold: {
    id: 'gold',
    nameAr: 'الذهبي الملكي',
    nameEn: 'Royal Gold',
    cardBg: 'bg-gradient-to-br from-amber-500 via-amber-600 to-yellow-600 text-white',
    cardBorder: 'border-amber-300/60 dark:border-amber-400/50',
    shadow: 'shadow-lg shadow-amber-500/20',
    badgeBg: 'bg-amber-400/25 text-yellow-100 border border-amber-300/40',
    textMuted: 'text-amber-100',
    accentButton: 'bg-white text-amber-900 hover:bg-amber-50 active:scale-95 shadow-md shadow-black/10',
    shimmerColor: 'from-transparent via-white/30 to-transparent',
    swatchPreview: 'bg-gradient-to-tr from-amber-500 via-yellow-400 to-amber-600',
    iconBg: 'bg-white/20 text-white',
  },
  pink: {
    id: 'pink',
    nameAr: 'الوردي الفاخر',
    nameEn: 'Rose Pink',
    cardBg: 'bg-gradient-to-br from-pink-500 via-rose-600 to-fuchsia-600 text-white',
    cardBorder: 'border-pink-300/60 dark:border-pink-400/50',
    shadow: 'shadow-lg shadow-pink-500/20',
    badgeBg: 'bg-pink-400/25 text-pink-100 border border-pink-300/40',
    textMuted: 'text-pink-100',
    accentButton: 'bg-white text-rose-900 hover:bg-rose-50 active:scale-95 shadow-md shadow-black/10',
    shimmerColor: 'from-transparent via-white/35 to-transparent',
    swatchPreview: 'bg-gradient-to-tr from-pink-500 via-rose-400 to-fuchsia-500',
    iconBg: 'bg-white/20 text-white',
  },
  black: {
    id: 'black',
    nameAr: 'الأسود الحالك',
    nameEn: 'Obsidian Black',
    cardBg: 'bg-gradient-to-br from-zinc-950 via-neutral-900 to-black text-white ring-1 ring-zinc-700/80',
    cardBorder: 'border-zinc-700/80 dark:border-zinc-600/70',
    shadow: 'shadow-xl shadow-black/50',
    badgeBg: 'bg-zinc-800/90 text-zinc-100 border border-zinc-700',
    textMuted: 'text-zinc-300',
    accentButton: 'bg-white text-black hover:bg-zinc-100 active:scale-95 shadow-md shadow-black/20',
    shimmerColor: 'from-transparent via-white/25 to-transparent',
    swatchPreview: 'bg-gradient-to-tr from-black via-zinc-800 to-zinc-900 border border-zinc-700',
    iconBg: 'bg-zinc-800 text-white border border-zinc-700',
  },
  white: {
    id: 'white',
    nameAr: 'الأبيض اللؤلؤي',
    nameEn: 'Frost Pearl',
    cardBg: 'bg-gradient-to-br from-slate-50 via-white to-slate-100 text-slate-900 border-2 border-slate-300/90 dark:border-zinc-400/80 shadow-md',
    cardBorder: 'border-slate-300/90 dark:border-zinc-400/80',
    shadow: 'shadow-lg shadow-slate-300/40 dark:shadow-black/50',
    badgeBg: 'bg-slate-200/90 text-slate-800 border border-slate-300',
    textMuted: 'text-slate-600',
    accentButton: 'bg-slate-900 text-white hover:bg-black active:scale-95 shadow-md shadow-black/15',
    shimmerColor: 'from-transparent via-sky-400/20 to-transparent',
    swatchPreview: 'bg-gradient-to-tr from-slate-100 via-white to-slate-200 border border-slate-300',
    iconBg: 'bg-slate-200/90 text-slate-800 border border-slate-300',
  },
};

const THEME_STORAGE_KEY = 'subscriptionBannerTheme';
const THEME_CHANGE_EVENT = 'subscription-banner-theme-changed';

export function getStoredBannerTheme(): BannerThemeId {
  if (typeof window === 'undefined') return 'gold';
  const stored = localStorage.getItem(THEME_STORAGE_KEY) as BannerThemeId;
  if (stored && BANNER_THEMES[stored]) {
    return stored;
  }
  return 'gold';
}

export function setStoredBannerTheme(theme: BannerThemeId) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: theme }));
}

export function useSubscriptionBannerTheme(user?: UserProfile | null) {
  const [themeId, setThemeId] = useState<BannerThemeId>(() => {
    if (user?.subscriptionBannerTheme && BANNER_THEMES[user.subscriptionBannerTheme]) {
      return user.subscriptionBannerTheme;
    }
    return getStoredBannerTheme();
  });

  // Sync if profile theme changes from remote Firestore
  useEffect(() => {
    if (user?.subscriptionBannerTheme && BANNER_THEMES[user.subscriptionBannerTheme] && user.subscriptionBannerTheme !== themeId) {
      setThemeId(user.subscriptionBannerTheme);
      setStoredBannerTheme(user.subscriptionBannerTheme);
    }
  }, [user?.subscriptionBannerTheme]);

  useEffect(() => {
    const handleCustomChange = (e: Event) => {
      const customEvent = e as CustomEvent<BannerThemeId>;
      if (customEvent.detail && BANNER_THEMES[customEvent.detail]) {
        setThemeId(customEvent.detail);
      }
    };

    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY && e.newValue && BANNER_THEMES[e.newValue as BannerThemeId]) {
        setThemeId(e.newValue as BannerThemeId);
      }
    };

    window.addEventListener(THEME_CHANGE_EVENT, handleCustomChange);
    window.addEventListener('storage', handleStorageChange);
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, handleCustomChange);
      window.removeEventListener('storage', handleStorageChange);
    };
  }, []);

  const changeTheme = async (newTheme: BannerThemeId) => {
    setStoredBannerTheme(newTheme);
    setThemeId(newTheme);

    // If user is authenticated, sync to Firestore and backend API immediately
    if (user?.uid) {
      try {
        await setDoc(doc(db, 'users', user.uid), { subscriptionBannerTheme: newTheme }, { merge: true });
      } catch (err) {
        console.warn('Direct Firestore write failed, trying fallback API:', err);
      }

      try {
        await fetch('/api/me/banner-theme', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ theme: newTheme }),
        });
      } catch {
        // Ignored, client and Firestore already handled
      }
    }
  };

  return {
    themeId,
    theme: BANNER_THEMES[themeId],
    changeTheme,
    allThemes: Object.values(BANNER_THEMES),
  };
}
