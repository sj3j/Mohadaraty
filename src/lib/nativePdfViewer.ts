import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { DrawingTool } from '../types/pdfDrawing.types';

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
  /** Rollback gate for the Phase 1 router. Defaults to true in native code. */
  stableInteractionRouting?: boolean;
  /** Phase 2 native gesture coordinator & native inking overlay */
  nativeInkV2?: boolean;
}

export type ReaderMode = 'read' | 'annotate';

export interface ReaderInteractionState {
  mode: ReaderMode;
  tool: DrawingTool;
  color?: string;
  width?: string;
  fingerDrawing: boolean;
  chromeVisible: boolean;
  webOverlayActive: boolean;
  revision: number;
}

export interface SetInteractionResult {
  appliedRevision: number;
  appliedState: ReaderInteractionState;
  deferred?: boolean;
  stale?: boolean;
}

export interface PageChangeEvent {
  page: number;
  pageCount: number;
}

export interface DocumentTouchEvent {
  x: number;
  y: number;
}

export interface NativeStrokeUpdateEvent {
  page: number;
  action: 'add' | 'erase' | 'replace';
  strokes: import('../types/pdfDrawing.types').PdfStroke[];
}

export interface MohadaratyPdfPluginInterface {
  openPdf(options: OpenPdfOptions): Promise<{ success: boolean; nativeInkAvailable?: boolean }>;
  closePdf(): Promise<void>;
  goToPage(options: { page: number }): Promise<void>;
  setNightMode(options: { nightMode: boolean }): Promise<void>;
  setInteraction(state: ReaderInteractionState): Promise<SetInteractionResult>;
  setPageStrokes(options: { page: number; strokes: import('../types/pdfDrawing.types').PdfStroke[] }): Promise<void>;
  /** @deprecated Rollback-only compatibility path. */
  setInteractiveZones(options: { zones: InteractiveZone[] }): Promise<void>;
  addListener(
    eventName: 'onPageChange',
    listenerFunc: (event: PageChangeEvent) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'onDocumentTap' | 'onDocumentLongPress',
    listenerFunc: (event: DocumentTouchEvent) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'onStrokesUpdated',
    listenerFunc: (event: NativeStrokeUpdateEvent) => void
  ): Promise<PluginListenerHandle>;
}

export const NativePdf = registerPlugin<MohadaratyPdfPluginInterface>('MohadaratyPdf');

export function isNativePdfSupported(): boolean {
  return Capacitor.isNativePlatform();
}
