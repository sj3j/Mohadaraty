/**
 * Send a selected passage somewhere else - clipboard, share sheet, translator,
 * web search.
 *
 * Everything here is reachable from the PDF reader's selection toolbar. Two
 * constraints shaped the implementation:
 *
 *   1. **No custom native plugin.** Translate and Search go through Custom Tabs
 *      rather than ACTION_PROCESS_TEXT / ACTION_WEB_SEARCH. A targeted intent
 *      would need a <queries> declaration to survive targetSdk 36's package
 *      visibility filtering, and without one `resolveActivity` returns null and
 *      the intent silently does nothing. @capacitor/browser already ships the
 *      Custom Tabs <queries> entry in its own manifest, so this path needs no
 *      manifest edit and cannot fail that way. Share is exempt because the
 *      system chooser runs in the system process.
 *
 *   2. **Capacitor modules are imported dynamically**, the same way
 *      useBackDismiss does it, so the web bundle never pulls native code in.
 */

/** Custom Tabs and most search engines truncate well before this; keep URLs sane. */
const MAX_URL_TEXT = 1200;

function clip(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > MAX_URL_TEXT ? t.slice(0, MAX_URL_TEXT) : t;
}

async function isNative(): Promise<boolean> {
  try {
    const { Capacitor } = await import('@capacitor/core');
    return Capacitor?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

/**
 * Open a URL outside the reader.
 *
 * Custom Tabs on native keeps the student in the app's task - back returns to
 * the lecture rather than to the launcher, which a plain intent would not
 * guarantee. `_blank` on web is the same idea.
 */
async function openExternal(url: string): Promise<void> {
  if (await isNative()) {
    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url });
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

export type ActionResult = 'ok' | 'copied' | 'failed';

/**
 * Copy to the OS clipboard.
 *
 * navigator.clipboard needs a secure context; Capacitor serves from
 * https://localhost so it is available on device. The execCommand fallback is
 * for the http dev server, where it is not.
 */
export async function copyText(text: string): Promise<ActionResult> {
  const t = text.trim();
  if (!t) return 'failed';

  try {
    await navigator.clipboard.writeText(t);
    return 'ok';
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok ? 'ok' : 'failed';
    } catch {
      return 'failed';
    }
  }
}

/**
 * Native share sheet, so the passage can go to Notes, a messaging app, or any
 * other installed target.
 *
 * Returns 'copied' when neither a native nor a Web Share target exists and the
 * text went to the clipboard instead - the caller says so rather than claiming
 * a share happened.
 */
export async function shareText(text: string, title?: string): Promise<ActionResult> {
  const t = text.trim();
  if (!t) return 'failed';

  if (await isNative()) {
    try {
      const { Share } = await import('@capacitor/share');
      await Share.share({ text: t, title, dialogTitle: title });
      return 'ok';
    } catch (e) {
      // A dismissed chooser rejects the same way a missing one does, so a
      // clipboard fallback here would fire on a deliberate cancel. Report the
      // no-op instead.
      return 'failed';
    }
  }

  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ text: t, title });
      return 'ok';
    } catch {
      return 'failed';
    }
  }

  return (await copyText(t)) === 'ok' ? 'copied' : 'failed';
}

/**
 * Google Translate, source auto-detected.
 *
 * `target` is the student's own UI language, not the opposite of the detected
 * source: a student reading an English lecture in an Arabic UI wants Arabic,
 * and one reading an Arabic lecture already has it.
 */
export async function translateText(text: string, target: 'ar' | 'en'): Promise<ActionResult> {
  const t = clip(text);
  if (!t) return 'failed';

  const url =
    `https://translate.google.com/?sl=auto&tl=${target}&op=translate&text=${encodeURIComponent(t)}`;

  try {
    await openExternal(url);
    return 'ok';
  } catch {
    return 'failed';
  }
}

/** Web search for the passage, in whatever browser the device defaults to. */
export async function webSearchText(text: string): Promise<ActionResult> {
  const t = clip(text);
  if (!t) return 'failed';

  try {
    await openExternal(`https://www.google.com/search?q=${encodeURIComponent(t)}`);
    return 'ok';
  } catch {
    return 'failed';
  }
}
