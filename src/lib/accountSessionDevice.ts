import { Capacitor } from '@capacitor/core';
import packageInfo from '../../package.json';

export interface AccountSessionDevicePayload {
  kind: 'mobile' | 'web' | 'desktop' | 'unknown';
  name: string;
  platform: string;
  operatingSystem: string;
  browser: string;
  appVersion: string;
  location?: { city: string; country: string };
}

const match = (value: string, pattern: RegExp) => value.match(pattern)?.[1]?.replace(/_/g, '.') || '';

let cachedClientLocation: { city: string; country: string } | null = null;
let clientLocationPromise: Promise<{ city: string; country: string } | null> | null = null;

export async function primeClientSessionLocation(): Promise<{ city: string; country: string } | null> {
  if (cachedClientLocation) return cachedClientLocation;
  if (clientLocationPromise) return clientLocationPromise;
  if (typeof window === 'undefined' || typeof fetch === 'undefined') return null;

  clientLocationPromise = (async () => {
    try {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? window.setTimeout(() => controller.abort(), 2500) : null;
      const res = await fetch('https://ipwho.is/', controller ? { signal: controller.signal } : undefined).catch(() => null);
      if (timer) window.clearTimeout(timer);
      if (!res || !res.ok) return null;
      const data = await res.json().catch(() => null);
      if (data && data.success !== false && (data.country_code || data.city)) {
        cachedClientLocation = {
          city: String(data.city || data.region || 'Unknown').trim(),
          country: String(data.country_code || data.country || 'Unknown').trim(),
        };
        return cachedClientLocation;
      }
    } catch {
      // Non-blocking background fetch
    } finally {
      clientLocationPromise = null;
    }
    return null;
  })();

  return clientLocationPromise;
}

if (typeof window !== 'undefined') {
  void primeClientSessionLocation();
}

export function collectAccountSessionDevice(): AccountSessionDevicePayload {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const nativePlatform = Capacitor.getPlatform();
  const native = Capacitor.isNativePlatform();
  const operatingSystem =
    match(ua, /Android\s+([\d.]+)/i) ? `Android ${match(ua, /Android\s+([\d.]+)/i)}` :
    match(ua, /(?:iPhone OS|CPU OS)\s+([\d_]+)/i) ? `iOS ${match(ua, /(?:iPhone OS|CPU OS)\s+([\d_]+)/i)}` :
    /Windows NT/i.test(ua) ? 'Windows' : /Mac OS X/i.test(ua) ? 'macOS' :
    /Linux/i.test(ua) ? 'Linux' : 'Unknown';
  const browser =
    match(ua, /Edg\/([\d.]+)/) ? `Microsoft Edge ${match(ua, /Edg\/([\d.]+)/)}` :
    match(ua, /Firefox\/([\d.]+)/) ? `Firefox ${match(ua, /Firefox\/([\d.]+)/)}` :
    match(ua, /(?:Chrome|CriOS)\/([\d.]+)/) ? `Chrome ${match(ua, /(?:Chrome|CriOS)\/([\d.]+)/)}` :
    match(ua, /Version\/([\d.]+).*Safari/) ? `Safari ${match(ua, /Version\/([\d.]+).*Safari/)}` :
    native ? 'App WebView' : 'Unknown';
  const androidModel = match(ua, /Android[^;]*;\s*([^;)]+?)(?:\s+Build\/|;|\))/i);
  const deviceName = /iPad/i.test(ua) ? 'iPad' : /iPhone/i.test(ua) ? 'iPhone' :
    androidModel || `${browser.split(' ')[0] || 'Browser'} on ${operatingSystem}`;

  return {
    kind: native ? 'mobile' : /Mobi|Android|iPhone|iPad/i.test(ua) ? 'mobile' : 'web',
    name: deviceName,
    platform: native ? nativePlatform : (typeof navigator !== 'undefined' ? navigator.platform || 'Web' : 'Unknown'),
    operatingSystem,
    browser,
    appVersion: packageInfo.version,
    ...(cachedClientLocation ? { location: cachedClientLocation } : {}),
  };
}

export async function collectAccountSessionDeviceAsync(): Promise<AccountSessionDevicePayload> {
  if (!cachedClientLocation) {
    try {
      await Promise.race([
        primeClientSessionLocation(),
        new Promise(resolve => setTimeout(resolve, 800)),
      ]);
    } catch { /* proceed */ }
  }
  return collectAccountSessionDevice();
}
