import { useEffect, useRef } from 'react';

/**
 * Dismiss a stacked overlay with the Android hardware back button.
 *
 * Capacitor 7's bridge does NOT route hardware back to `WebView.goBack()`. With
 * no `backButton` listener registered it simply finishes the Activity, which is
 * why pressing back anywhere in this app used to drop the student straight out
 * to the launcher - mid-lecture, mid-quiz, mid-anything. A `history.pushState`
 * trick cannot fix that, because the entries are never consumed.
 *
 * So the native path listens for Capacitor's own `backButton` event and owns the
 * decision. Registering a listener also suppresses the default exit, so the
 * empty-stack case has to reproduce it deliberately (see below) or back would
 * stop working at the top level.
 *
 * The layers share ONE listener and a stack: a back press must dismiss exactly
 * the topmost layer, not every open one.
 *
 * On the web there is no hardware back, so this is a no-op by design - the
 * browser's own back already leaves the page and overlays have visible close
 * buttons.
 */

interface Layer {
  key: string;
  dismiss: () => void;
}

const layers: Layer[] = [];
let removeListener: (() => void) | null = null;
let starting = false;

async function handleBack(canGoBack: boolean) {
  // Peek rather than pop. Normal dismissals unmount and remove their own layer;
  // a non-dismissible layer (the forced-update gate) must remain on the stack
  // for every subsequent Back press as well as the first.
  const top = layers[layers.length - 1];
  if (top) {
    top.dismiss();
    return;
  }

  // Nothing of ours is open, so restore the platform default. minimizeApp keeps
  // the app warm in recents, which is what a student pressing back on the home
  // tab expects - closer to native behaviour than killing the process.
  const { App } = await import('@capacitor/app');
  if (canGoBack) window.history.back();
  else App.minimizeApp().catch(() => { /* not fatal */ });
}

async function ensureListener() {
  if (removeListener || starting) return;
  starting = true;
  try {
    const { Capacitor } = await import('@capacitor/core');
    if (!Capacitor?.isNativePlatform?.()) return;

    const { App } = await import('@capacitor/app');
    const handle = await App.addListener('backButton', ({ canGoBack }) => {
      void handleBack(!!canGoBack);
    });
    removeListener = () => { handle.remove(); };
  } catch (e) {
    console.warn('[back] could not attach backButton listener', e);
  } finally {
    starting = false;
  }
}

export function useBackDismiss(active: boolean, onDismiss: () => void, key: string): void {
  const cb = useRef(onDismiss);
  cb.current = onDismiss;

  useEffect(() => {
    if (!active) return;

    const layer: Layer = { key, dismiss: () => cb.current() };
    layers.push(layer);
    void ensureListener();

    return () => {
      const i = layers.indexOf(layer);
      if (i !== -1) layers.splice(i, 1);
    };
  }, [active, key]);
}
