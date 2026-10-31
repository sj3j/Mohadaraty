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

/**
 * Module-level persistent Set to retain active SpeechSynthesisUtterance instances.
 * This defeats Chromium / Android WebView V8 garbage collection mid-speech cutoffs.
 */
export const activeUtterances = new Set<SpeechSynthesisUtterance>();

/**
 * Split text into natural sentence and clause chunks (<= maxLen characters).
 * Splits on punctuation: '.', '!', '?', '،', '؛', '؟', ':', or line breaks '\n'.
 * Falls back to word-level splitting if an individual clause exceeds maxLen.
 */
export function segmentText(text: string, maxLen = 160): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxLen) return [trimmed];

  const rawSentences = trimmed
    .split(/(?<=[.!?؟،؛:])\s+|\r?\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let currentChunk = '';

  for (const s of rawSentences) {
    if (!currentChunk) {
      if (s.length <= maxLen) {
        currentChunk = s;
      } else {
        // Sentence itself is longer than maxLen, split by words
        const words = s.split(/\s+/).filter(Boolean);
        for (const w of words) {
          if (!currentChunk) {
            currentChunk = w;
          } else if ((currentChunk + ' ' + w).length <= maxLen) {
            currentChunk = currentChunk + ' ' + w;
          } else {
            chunks.push(currentChunk);
            currentChunk = w;
          }
        }
      }
    } else {
      if ((currentChunk + ' ' + s).length <= maxLen) {
        currentChunk = currentChunk + ' ' + s;
      } else {
        chunks.push(currentChunk);
        if (s.length <= maxLen) {
          currentChunk = s;
        } else {
          const words = s.split(/\s+/).filter(Boolean);
          currentChunk = '';
          for (const w of words) {
            if (!currentChunk) {
              currentChunk = w;
            } else if ((currentChunk + ' ' + w).length <= maxLen) {
              currentChunk = currentChunk + ' ' + w;
            } else {
              chunks.push(currentChunk);
              currentChunk = w;
            }
          }
        }
      }
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  // Safety pass: ensure no individual chunk exceeds maxLen (handles oversized unbreakable tokens)
  const finalChunks: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxLen) {
      finalChunks.push(chunk);
    } else {
      for (let i = 0; i < chunk.length; i += maxLen) {
        finalChunks.push(chunk.slice(i, i + maxLen));
      }
    }
  }

  return finalChunks;
}

/**
 * Find the most suitable SpeechSynthesisVoice matching the target language.
 * Checks for dialect match (e.g. ar-SA, en-US) or prefix match (ar, en).
 */
export function getMatchingVoice(lang: 'ar' | 'en'): SpeechSynthesisVoice | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  try {
    const voices = window.speechSynthesis.getVoices();
    if (!voices || voices.length === 0) return null;

    const prefix = lang === 'ar' ? 'ar' : 'en';
    const targetTag = lang === 'ar' ? 'ar-sa' : 'en-us';

    // 1. Exact dialect match (case/hyphen insensitive)
    const exact = voices.find((v) => {
      const code = (v.lang || '').toLowerCase().replace('_', '-');
      return code === targetTag;
    });
    if (exact) return exact;

    // 2. Starts with target language prefix (e.g. 'ar-EG', 'en-GB')
    const prefixMatch = voices.find((v) => {
      const code = (v.lang || '').toLowerCase().replace('_', '-');
      return code.startsWith(prefix);
    });
    if (prefixMatch) return prefixMatch;

    return null;
  } catch {
    return null;
  }
}

// Warm voices cache when available in browser
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  try {
    if (typeof window.speechSynthesis.onvoiceschanged !== 'undefined') {
      window.speechSynthesis.onvoiceschanged = () => {
        try {
          window.speechSynthesis.getVoices();
        } catch {}
      };
    }
  } catch {}
}

let watchdogTimer: ReturnType<typeof setInterval> | null = null;

function stopWatchdog(): void {
  if (watchdogTimer !== null) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

function startWatchdog(onAutoRecover?: () => void): void {
  stopWatchdog();
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  watchdogTimer = setInterval(() => {
    try {
      if (window.speechSynthesis) {
        if (window.speechSynthesis.speaking) {
          // Keep-alive heartbeat: pause + resume defeats Chromium 15-second speech freeze
          window.speechSynthesis.pause();
          window.speechSynthesis.resume();
        } else if (!window.speechSynthesis.pending && activeUtterances.size > 0) {
          // Engine died silently without onend
          stopWatchdog();
          activeUtterances.clear();
          onAutoRecover?.();
        }
      }
    } catch {
      stopWatchdog();
    }
  }, 10000);
}

/**
 * Speak text using native Web Speech API with V8 GC keep-alive, sentence segmentation,
 * pause/resume watchdog, and guaranteed UI state reset. Returns a cancellation callback.
 */
export function speakText(
  text: string,
  lang: 'ar' | 'en',
  onStateChange?: (speaking: boolean) => void,
): () => void {
  const trimmed = text.trim();
  if (!trimmed || !isSpeechSupported()) {
    onStateChange?.(false);
    return () => {};
  }

  try {
    // 1. Cancel previous speech engine session
    stopWatchdog();
    try {
      window.speechSynthesis.cancel();
    } catch {}
    activeUtterances.clear();

    // 2. Natural sentence & clause segmentation (<= 160 characters)
    const chunks = segmentText(trimmed, 160);
    if (chunks.length === 0) {
      onStateChange?.(false);
      return () => {};
    }

    let isCleanedUp = false;
    const cleanup = () => {
      if (isCleanedUp) return;
      isCleanedUp = true;
      stopWatchdog();
      activeUtterances.clear();
      onStateChange?.(false);
    };

    const matchedVoice = getMatchingVoice(lang);

    // 3. Queue utterances sequentially through the speech synthesis queue
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const utterance = new SpeechSynthesisUtterance(chunk);
      utterance.lang = lang === 'ar' ? 'ar-SA' : 'en-US';
      utterance.rate = 0.95;
      if (matchedVoice) {
        utterance.voice = matchedVoice;
      }

      // GC retention: store active instance until completion
      activeUtterances.add(utterance);

      utterance.onend = () => {
        activeUtterances.delete(utterance);
        if (activeUtterances.size === 0) {
          cleanup();
        }
      };

      utterance.onerror = () => {
        activeUtterances.delete(utterance);
        cleanup();
      };

      window.speechSynthesis.speak(utterance);
    }

    // 4. Signal speaking state true and activate 10-second keep-alive watchdog
    onStateChange?.(true);
    startWatchdog(cleanup);

    return () => {
      try {
        window.speechSynthesis.cancel();
      } catch {}
      cleanup();
    };
  } catch (e) {
    console.warn('[translationService] speechSynthesis error:', e);
    stopWatchdog();
    activeUtterances.clear();
    onStateChange?.(false);
    return () => {};
  }
}
