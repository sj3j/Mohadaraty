/**
 * Official Google Cloud Translation API v2 service.
 *
 * Communicates with https://translation.googleapis.com/language/translate/v2
 * using POST with Content-Type: application/json.
 *
 * Includes:
 * 1. Secure Vite environment variable configuration via VITE_GOOGLE_TRANSLATE_API_KEY.
 * 2. In-memory LRU cache to minimize network roundtrips and billing consumption.
 * 3. Human-friendly Arabic error mapping for HTTP codes.
 * 4. Resilient fallback to secondary translation tier if API key is not configured or exceeds quota (HTTP 403).
 * 5. AbortSignal support for canceling in-flight requests.
 */
import {
  translatePassage as fallbackTranslate,
  isArabicText,
  detectLanguage,
  openExternalTranslate,
  speakText,
} from './translationService';

export { isArabicText, detectLanguage, openExternalTranslate, speakText };

const GOOGLE_TRANSLATE_ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';
const clientCache = new Map<string, string>();
const MAX_CACHE_SIZE = 200;

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

/**
 * Human-friendly localized error mapping for Google Cloud Translation HTTP status codes.
 */
function mapHttpErrorToArabic(status: number): string {
  switch (status) {
    case 400:
      return 'تعذّر إتمام الترجمة (الطلب غير صالح).';
    case 403:
      return 'تم استنفاد حصة الترجمة المتاحة أو المفتاح غير مصرح به.';
    case 429:
      return 'تم تجاوز الحد المسموح للطلبات. يرجى الانتظار قليلاً.';
    case 500:
    case 502:
    case 503:
    case 504:
      return 'خدمة الترجمة غير متاحة حالياً. يرجى المحاولة لاحقاً.';
    default:
      return 'تعذّر جلب الترجمة. يرجى التحقق من اتصال الإنترنت.';
  }
}

/**
 * Translates a given text using Google Cloud Translation API v2.
 *
 * @param text The input passage to translate.
 * @param targetLang Target ISO-639-1 language code (defaults to 'ar' or 'en' based on source).
 * @param signal Optional AbortSignal to cancel the in-flight request.
 * @returns The translated string.
 */
export async function translateText(
  text: string,
  targetLang?: string,
  signal?: AbortSignal,
): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('النص المحدّد فارغ.');
  }

  const finalTarget = targetLang || (isArabicText(trimmed) ? 'en' : 'ar');
  const cacheKey = `${finalTarget}:${trimmed}`;

  // 1. Check in-memory cache
  const cached = clientCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const apiKey = (import.meta.env?.VITE_GOOGLE_TRANSLATE_API_KEY || '').trim();

  // 2. If API Key is missing, log warning and use fallback tier
  if (!apiKey) {
    console.warn(
      '[translateService] VITE_GOOGLE_TRANSLATE_API_KEY is not defined. Delegating to secondary translation tier.',
    );
    try {
      const fallbackResult = await fallbackTranslate({
        text: trimmed,
        targetLang: finalTarget as 'ar' | 'en',
        signal,
      });
      clientCache.set(cacheKey, fallbackResult.translatedText);
      return fallbackResult.translatedText;
    } catch (fallbackErr: any) {
      if (fallbackErr?.name === 'AbortError') throw fallbackErr;
      throw new Error('تعذّر إكمال الترجمة. يرجى المحاولة مرة أخرى.');
    }
  }

  // 3. Primary: Google Cloud Translation API v2 via POST
  try {
    const url = `${GOOGLE_TRANSLATE_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: [trimmed],
        target: finalTarget,
        format: 'text',
      }),
      signal,
    });

    if (!response.ok) {
      const status = response.status;
      console.warn(`[translateService] Google Cloud API error (${status}):`, response.statusText);

      // On quota/auth failure (403, 429) or server outage, gracefully attempt fallback tier
      if (status === 403 || status === 429 || status >= 500) {
        try {
          const fallbackRes = await fallbackTranslate({
            text: trimmed,
            targetLang: finalTarget as 'ar' | 'en',
            signal,
          });
          clientCache.set(cacheKey, fallbackRes.translatedText);
          return fallbackRes.translatedText;
        } catch (e: any) {
          if (e?.name === 'AbortError') throw e;
          // Throw the human-friendly message if fallback also fails
        }
      }

      throw new Error(mapHttpErrorToArabic(status));
    }

    const json = await response.json();
    const rawTranslation = json?.data?.translations?.[0]?.translatedText;

    if (!rawTranslation || typeof rawTranslation !== 'string') {
      throw new Error('استجابة غير متوقعة من خدمة الترجمة.');
    }

    const cleaned = decodeHtmlEntities(rawTranslation).trim();

    // Cache the successful result (LRU eviction if over limit)
    if (clientCache.size >= MAX_CACHE_SIZE) {
      const oldestKey = clientCache.keys().next().value;
      if (oldestKey) clientCache.delete(oldestKey);
    }
    clientCache.set(cacheKey, cleaned);

    return cleaned;
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw error;
    }

    // If an error is already human-friendly Arabic, bubble it up
    if (error instanceof Error && error.message && /[\u0600-\u06FF]/.test(error.message)) {
      throw error;
    }

    // Try fallback tier as last line of defense before surfacing generic error
    try {
      const fallbackRes = await fallbackTranslate({
        text: trimmed,
        targetLang: finalTarget as 'ar' | 'en',
        signal,
      });
      clientCache.set(cacheKey, fallbackRes.translatedText);
      return fallbackRes.translatedText;
    } catch (e: any) {
      if (e?.name === 'AbortError') throw e;
    }

    throw new Error('تعذّر الاتصال بخدمة الترجمة. يرجى التحقق من اتصال الإنترنت.');
  }
}
