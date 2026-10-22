/**
 * Vector Drawing & Freehand Annotation types for Mohadaraty PDF Reader.
 * Reverse-engineered from Notewise drawing architecture.
 */

export type DrawingTool = 'pencil' | 'free_highlighter' | 'text' | 'text_highlight' | 'eraser';

export type StrokeWidth = 'thin' | 'medium' | 'thick';

export const PENCIL_WIDTHS: Record<StrokeWidth, number> = {
  thin: 2,
  medium: 4,
  thick: 7,
};

export const FREE_HIGHLIGHTER_WIDTHS: Record<StrokeWidth, number> = {
  thin: 14,
  medium: 22,
  thick: 32,
};

export interface StrokePoint {
  /** Normalized X coordinate: 0.0 at left edge, 1.0 at right edge */
  x: number;
  /** Normalized Y coordinate: 0.0 at top edge, 1.0 at bottom edge */
  y: number;
  /** Pressure (if supported by stylus / S-Pen), normalized 0.0 to 1.0 */
  p?: number;
}

export interface PdfStroke {
  id: string;
  lectureId: string;
  page: number;
  tool: 'pencil' | 'free_highlighter';
  color: string;
  width: number; // base thickness in points
  opacity: number; // 1.0 for pencil, ~0.35-0.4 for free highlighter
  points: StrokePoint[];
  createdAt: number;
}

export interface DrawingHistoryState {
  past: PdfStroke[][];
  present: PdfStroke[];
  future: PdfStroke[][];
}
