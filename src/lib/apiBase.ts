import { IS_STORE_BUILD } from './platform';

/**
 * Where /api/* actually lives.
 *
 * On the web the app is served from the same origin as the API, so a relative
 * path is correct. Inside Capacitor the WebView origin is `https://localhost`
 * and the bundle is on the device - a relative `/api/login` would resolve to
 * the phone itself, where nothing is listening, and every backend call fails
 * with a confusing network error rather than an HTTP status.
 *
 * So native builds get an absolute base. Override with VITE_API_BASE_URL to
 * point a test build at a LAN dev server instead of production.
 */
const CONFIGURED = ((typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_BASE_URL) || '')
  .trim()
  .replace(/\/+$/, '');

export const API_BASE: string = CONFIGURED || (IS_STORE_BUILD ? 'https://mohadaraty.vercel.app' : '');

/** `apiUrl('/api/login')` -> relative on web, absolute on device. */
export function apiUrl(path: string): string {
  if (!API_BASE) return path;
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}
