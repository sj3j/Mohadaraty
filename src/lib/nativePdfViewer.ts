import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface InteractiveZone {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface OpenPdfOptions {
  filePath: string;
  initialPage?: number;
  nightMode?: boolean;
  swipeHorizontal?: boolean;
}

export interface PageChangeEvent {
  page: number;
  pageCount: number;
}

export interface DocumentTouchEvent {
  x: number;
  y: number;
}

export interface MohadaratyPdfPluginInterface {
  openPdf(options: OpenPdfOptions): Promise<{ success: boolean }>;
  closePdf(): Promise<void>;
  goToPage(options: { page: number }): Promise<void>;
  setNightMode(options: { nightMode: boolean }): Promise<void>;
  setInteractiveZones(options: { zones: InteractiveZone[] }): Promise<void>;
  addListener(
    eventName: 'onPageChange',
    listenerFunc: (event: PageChangeEvent) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'onDocumentTap' | 'onDocumentLongPress',
    listenerFunc: (event: DocumentTouchEvent) => void
  ): Promise<PluginListenerHandle>;
}

export const NativePdf = registerPlugin<MohadaratyPdfPluginInterface>('MohadaratyPdf');

export function isNativePdfSupported(): boolean {
  return Capacitor.isNativePlatform();
}
