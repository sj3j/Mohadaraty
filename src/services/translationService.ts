/**
 * Client translation service for the in-reader floating translation sheet.
 *
 * Tier 1: In-memory client LRU cache (0ms for repeated terms).
 * Tier 2: Server-side /api/translate with serverCache.
 * Tier 3: Client-side CORS direct fallback to public translation API if server unreachable.
 * Tier 4: Safety valve external Google Translate launcher.
 */
import { apiUrl } from '../lib/apiBase';

export interface TranslationResult {
  translatedText: string;
  sourceLang: 'ar' | 'en';
  targetLang: 'ar' | 'en';
  source: 'cache' | 'server' | 'fallback_api';
}

export interface TranslationOptions {
  text: string;
  targetLang?: 'ar' | 'en';
  sourceLang?: 'ar' | 'en';
  signal?: AbortSignal;
}

const clientCache = new Map<string, TranslationResult>();
const MAX_CACHE_ENTRIES = 200;

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

/** Detect if string contains Arabic characters. */
export function isArabicText(text: string): boolean {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text);
}

/** Detect source language heuristically. */
export function detectLanguage(text: string): 'ar' | 'en' {
  return isArabicText(text) ? 'ar' : 'en';
}

/** Build web URL for Google Translate. */
export function buildExternalTranslateUrl(text: string, targetLang: 'ar' | 'en'): string {
  const t = text.trim().slice(0, 1200);
  return `https://translate.google.com/?sl=auto&tl=${targetLang}&op=translate&text=${encodeURIComponent(t)}`;
}

/**
 * Open external translation page outside the reader via Capacitor Browser or window.open.
 */
export async function openExternalTranslate(text: string, targetLang: 'ar' | 'en'): Promise<void> {
  const url = buildExternalTranslateUrl(text, targetLang);
  try {
    const { Capacitor } = await import('@capacitor/core');
    if (Capacitor?.isNativePlatform?.()) {
      const { Browser } = await import('@capacitor/browser');
      await Browser.open({ url });
      return;
    }
  } catch {
    // web fallback
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * Fetch translation for selected text using multi-tier strategy.
 */
export async function translatePassage({
  text,
  targetLang,
  sourceLang,
  signal,
}: TranslationOptions): Promise<TranslationResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('empty_text');
  }

  const detectedSource = sourceLang ?? detectLanguage(trimmed);
  const finalTarget: 'ar' | 'en' = targetLang ?? (detectedSource === 'ar' ? 'en' : 'ar');
  const cacheKey = `${detectedSource}:${finalTarget}:${trimmed}`;

  // 1. Client Memory Cache
  const cached = clientCache.get(cacheKey);
  if (cached) {
    return { ...cached, source: 'cache' };
  }

  // Helper to store in LRU cache
  const saveToCache = (result: TranslationResult) => {
    if (clientCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = clientCache.keys().next().value;
      if (oldestKey) clientCache.delete(oldestKey);
    }
    clientCache.set(cacheKey, result);
  };

  // 2. Primary: Server /api/translate
  try {
    const res = await fetch(apiUrl('/api/translate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: trimmed,
        targetLang: finalTarget,
        sourceLang: detectedSource,
      }),
      signal,
    });

    if (res.ok) {
      const data = await res.json();
      if (data?.translatedText && typeof data.translatedText === 'string') {
        const result: TranslationResult = {
          translatedText: data.translatedText,
          sourceLang: detectedSource,
          targetLang: finalTarget,
          source: 'server',
        };
        saveToCache(result);
        return result;
      }
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw err;
    }
    console.warn('[translationService] server endpoint failed or offline, falling back to direct API', err);
  }

  // 3. Fallback: Direct client fetch to public translation API (MyMemory)
  try {
    const directUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(trimmed.slice(0, 500))}&langpair=${detectedSource}|${finalTarget}`;
    const directRes = await fetch(directUrl, { signal });
    if (directRes.ok) {
      const data: any = await directRes.json();
      const rawTranslated = data?.responseData?.translatedText;
      if (rawTranslated && typeof rawTranslated === 'string' && !rawTranslated.startsWith('MYMEMORY WARNING')) {
        const cleaned = decodeHtmlEntities(rawTranslated).trim();
        const result: TranslationResult = {
          translatedText: cleaned,
          sourceLang: detectedSource,
          targetLang: finalTarget,
          source: 'fallback_api',
        };
        saveToCache(result);
        return result;
      }
    }
  } catch (directErr: any) {
    if (directErr?.name === 'AbortError') {
      throw directErr;
    }
    console.warn('[translationService] direct fallback failed:', directErr);
  }

  throw new Error('translation_failed');
}

/** Check if Web Speech API is supported in the current environment. */
export function isSpeechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

/** Speak text using native Web Speech API. Returns a cancellation callback. */
export function speakText(
  text: string,
  lang: 'ar' | 'en',
  onStateChange?: (speaking: boolean) => void,
): () => void {
  if (!isSpeechSupported()) {
    onStateChange?.(false);
    return () => {};
  }

  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang === 'ar' ? 'ar-SA' : 'en-US';
    utterance.rate = 0.95;

    utterance.onstart = () => onStateChange?.(true);
    utterance.onend = () => onStateChange?.(false);
    utterance.onerror = () => onStateChange?.(false);

    window.speechSynthesis.speak(utterance);

    return () => {
      window.speechSynthesis.cancel();
      onStateChange?.(false);
    };
  } catch (e) {
    console.warn('[translationService] speechSynthesis error:', e);
    onStateChange?.(false);
    return () => {};
  }
}
