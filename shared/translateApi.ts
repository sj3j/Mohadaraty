/**
 * Server-side translation handler mounted by both server.ts and api/index.ts.
 *
 * Sits behind serverCache so repetitive academic/medical queries (e.g. common
 * lecture terms) resolve in 0ms without consuming external network quota.
 */
import type { Request, Response } from 'express';
import { serverCache } from './serverCache.js';

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

const MAX_TRANSLATE_CHARS = 1500;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function createTranslateHandlers() {
  return {
    translate: async (req: Request, res: Response) => {
      try {
        const rawText = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
        const targetLang = req.body?.targetLang === 'en' ? 'en' : 'ar';
        const sourceLang = req.body?.sourceLang === 'ar' || req.body?.sourceLang === 'en'
          ? req.body.sourceLang
          : (/[أ-ي\u0600-\u06FF]/.test(rawText) ? 'ar' : 'en');

        if (!rawText) {
          return res.status(400).json({ error: 'empty_text' });
        }

        const text = rawText.length > MAX_TRANSLATE_CHARS ? rawText.slice(0, MAX_TRANSLATE_CHARS) : rawText;
        const cacheKey = `tr:${sourceLang}:${targetLang}:${text}`;

        const cached = serverCache.get<string>(cacheKey);
        if (cached) {
          return res.json({
            translatedText: cached,
            sourceLang,
            targetLang,
            source: 'cache',
          });
        }

        // Tier 1: MyMemory API
        const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${sourceLang}|${targetLang}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);

        try {
          const apiRes = await fetch(url, { signal: controller.signal });
          clearTimeout(timeout);

          if (apiRes.ok) {
            const data: any = await apiRes.json();
            const translated = data?.responseData?.translatedText;
            if (translated && typeof translated === 'string' && !translated.startsWith('MYMEMORY WARNING')) {
              const cleaned = decodeHtmlEntities(translated).trim();
              serverCache.set(cacheKey, cleaned, CACHE_TTL_MS);
              return res.json({
                translatedText: cleaned,
                sourceLang,
                targetLang,
                source: 'server_api',
              });
            }
          }
        } catch (fetchErr) {
          clearTimeout(timeout);
          console.warn('[translateApi] fetch failed or timed out:', fetchErr);
        }

        // If external API failed or warning returned
        return res.status(502).json({ error: 'translation_unavailable' });
      } catch (err: any) {
        console.error('[translateApi] unexpected error:', err);
        return res.status(500).json({ error: 'internal_error' });
      }
    },
  };
}
