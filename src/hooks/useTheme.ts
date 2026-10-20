import { useCallback, useEffect, useState } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';

interface SystemBarsPlugin {
  setStyle(options: { darkBackground: boolean }): Promise<{ darkBackground: boolean }>;
}

const SystemBars = registerPlugin<SystemBarsPlugin>('SystemBars');

function syncNativeSystemBars(darkBackground: boolean) {
  if (!Capacitor.isNativePlatform()) return;
  void SystemBars.setStyle({ darkBackground })
    .catch(error => console.warn('[system-bars] Failed to synchronize icon contrast:', error));
}

/**
 * Light / dark / true-black / follow-system.
 *
 * Replaces the two-way light-dark toggle. `black` deliberately applies BOTH
 * `.dark` and `.theme-black`: every existing `dark:` utility in the app keeps
 * matching, and theme-black only deepens the greys those utilities already
 * produce. Applying it instead of `.dark` would leave the whole app in light
 * colours on a black background.
 *
 * `system` follows prefers-color-scheme live, so a phone on a dark-mode
 * schedule flips the app without a restart.
 */
export type ThemeChoice = 'light' | 'dark' | 'black' | 'system';

const STORAGE_KEY = 'theme';

function readStored(): ThemeChoice {
  if (typeof window === 'undefined') return 'system';
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === 'light' || raw === 'dark' || raw === 'black' || raw === 'system') return raw;
  // Legacy values from the old two-way toggle.
  return raw === 'dark' ? 'dark' : 'system';
}

function prefersDark(): boolean {
  return typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
}

function apply(choice: ThemeChoice) {
  const root = document.documentElement;
  const dark = choice === 'dark' || choice === 'black' || (choice === 'system' && prefersDark());
  root.classList.toggle('dark', dark);
  root.classList.toggle('theme-black', choice === 'black');
  syncNativeSystemBars(dark);

  // Keeps the Android status bar and the browser chrome in step with the app.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', choice === 'black' ? '#000000' : dark ? '#18181b' : '#0284c7');
  }
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeChoice>(readStored);

  useEffect(() => {
    apply(theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  // Only 'system' cares about the OS flipping underneath us.
  useEffect(() => {
    if (theme !== 'system' || typeof window === 'undefined') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  const setTheme = useCallback((next: ThemeChoice) => setThemeState(next), []);

  /** Kept for the existing header button: cycles light -> dark -> black. */
  const cycleTheme = useCallback(() => {
    setThemeState(prev => (prev === 'light' ? 'dark' : prev === 'dark' ? 'black' : 'light'));
  }, []);

  const isDark = theme === 'dark' || theme === 'black' || (theme === 'system' && prefersDark());

  return { theme, setTheme, cycleTheme, isDark };
}
