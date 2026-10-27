import { IS_MACOS_BUILD } from '../lib/platform';

export const MAC_BRIDGE_VERSION = 1 as const;

export type MacBridgeService = 'environment' | 'attendance' | 'files' | 'presentation';

export interface MacRuntimeDescriptor {
  platform: 'macos';
  bridgeVersion: 1;
  appVersion: string;
  capabilities: readonly string[];
}

export interface MacBridgeRequest {
  version: 1;
  requestId: string;
  service: MacBridgeService;
  method: string;
  payload: unknown;
}

export type MacBridgeResponse<T> =
  | { version: 1; requestId: string; ok: true; value: T }
  | {
      version: 1;
      requestId: string;
      ok: false;
      error: { code: string; message: string; retryable: boolean };
    };

declare global {
  interface Window {
    __MOHADARATY_MAC__?: MacRuntimeDescriptor;
    webkit?: {
      messageHandlers?: {
        mohadaraty?: { postMessage(request: MacBridgeRequest): Promise<MacBridgeResponse<unknown>> };
      };
    };
  }
}

export class MacBridgeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'MacBridgeError';
  }
}

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `mac-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function isMacRuntime(): boolean {
  return IS_MACOS_BUILD &&
    typeof window !== 'undefined' &&
    window.__MOHADARATY_MAC__?.platform === 'macos' &&
    window.__MOHADARATY_MAC__?.bridgeVersion === MAC_BRIDGE_VERSION;
}

export function requireMacRuntime(): MacRuntimeDescriptor {
  if (!isMacRuntime()) throw new MacBridgeError('mac_bridge_unavailable', 'The macOS native bridge is unavailable.');
  return window.__MOHADARATY_MAC__!;
}

export async function callMacBridge<T>(
  service: MacBridgeService,
  method: string,
  payload: unknown = {},
): Promise<T> {
  requireMacRuntime();
  const handler = window.webkit?.messageHandlers?.mohadaraty;
  if (!handler?.postMessage) throw new MacBridgeError('mac_bridge_unavailable', 'The macOS message handler is unavailable.');

  const id = requestId();
  let response: MacBridgeResponse<unknown>;
  try {
    response = await handler.postMessage({ version: MAC_BRIDGE_VERSION, requestId: id, service, method, payload });
  } catch (error) {
    throw new MacBridgeError('mac_bridge_transport', (error as Error)?.message || 'Native bridge transport failed.', true);
  }
  if (!response || response.version !== MAC_BRIDGE_VERSION || response.requestId !== id) {
    throw new MacBridgeError('mac_bridge_protocol', 'Native bridge returned an invalid response.');
  }
  if (response.ok === false) throw new MacBridgeError(response.error.code, response.error.message, response.error.retryable);
  return response.value as T;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export type MacFileResult = { status: 'saved' | 'shared' | 'cancelled'; path?: string };

export const macFiles = {
  saveRemoteFile(url: string, suggestedName: string, mimeType: string): Promise<MacFileResult> {
    return callMacBridge('files', 'saveRemoteFile', { url, suggestedName, mimeType });
  },
  saveData(data: ArrayBuffer | string, suggestedName: string, mimeType: string): Promise<MacFileResult> {
    const payload = typeof data === 'string'
      ? { encoding: 'utf8', data, suggestedName, mimeType }
      : { encoding: 'base64', data: arrayBufferToBase64(data), suggestedName, mimeType };
    return callMacBridge('files', 'saveData', payload);
  },
  shareData(data: ArrayBuffer | string, suggestedName: string, mimeType: string): Promise<MacFileResult> {
    const payload = typeof data === 'string'
      ? { encoding: 'utf8', data, suggestedName, mimeType }
      : { encoding: 'base64', data: arrayBufferToBase64(data), suggestedName, mimeType };
    return callMacBridge('files', 'shareData', payload);
  },
  shareRemoteFile(url: string, suggestedName: string, mimeType: string): Promise<MacFileResult> {
    return callMacBridge('files', 'shareRemoteFile', { url, suggestedName, mimeType });
  },
  revealSavedFile(path: string): Promise<void> {
    return callMacBridge('files', 'revealSavedFile', { path });
  },
};

export const macPresentation = {
  showQr(dataUrl: string, title = '', subtitle = ''): Promise<void> {
    return callMacBridge('presentation', 'showQr', { dataUrl, title, subtitle });
  },
  close(): Promise<void> {
    return callMacBridge('presentation', 'close', {});
  },
};

