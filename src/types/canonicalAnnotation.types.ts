/**
 * Canonical Cross-Platform Annotation Models for Mohadaraty PDF Reader.
 *
 * Provides a versioned, durable, platform-independent representation of student annotations.
 * All spatial coordinates are normalized [0.0 ... 1.0] in PDF-page space, invariant across
 * zoom, screen DPI, aspect-fit scaling, and device orientation.
 */

export const CANONICAL_SCHEMA_VERSION = 2;

export type CanonicalAnnotationKind = 'ink' | 'highlighter' | 'text' | 'text_highlight';

export interface CanonicalPoint {
  /** Normalized X [0.0 .. 1.0], 0 = left edge of page crop-box, 1 = right edge */
  x: number;
  /** Normalized Y [0.0 .. 1.0], 0 = top edge of page crop-box, 1 = bottom edge */
  y: number;
  /** Stylus / S-Pen / Apple Pencil pressure [0.0 .. 1.0] */
  pressure?: number;
  /** Milliseconds offset from stroke start */
  timeOffsetMs?: number;
}

export interface CanonicalAnnotationBase {
  /** Stable unique identifier (UUID v4 or nanoid) */
  id: string;
  /** Schema version for migration safety */
  schemaVersion: number;
  /** Stable document association (lectureId or document fingerprint) */
  documentId: string;
  /** 1-based page index matching student UI */
  pageIndex: number;
  /** Kind of annotation */
  kind: CanonicalAnnotationKind;
  /** Milliseconds epoch timestamp */
  createdAt: number;
  /** Milliseconds epoch timestamp */
  updatedAt: number;
  /** Monotonically increasing revision counter per annotation */
  revision: number;
}

export interface CanonicalInkAnnotation extends CanonicalAnnotationBase {
  kind: 'ink' | 'highlighter';
  /** Array of normalized points */
  points: CanonicalPoint[];
  /** Color in hex format (e.g., #4f46e5) */
  color: string;
  /** Opacity [0.0 .. 1.0]. Typically 1.0 for ink/pen, ~0.38 for highlighter */
  opacity: number;
  /** Base stroke width in PDF points */
  width: number;
}

export interface CanonicalTextAnnotation extends CanonicalAnnotationBase {
  kind: 'text';
  /** Normalized anchor position (top-left of text box) */
  point: { x: number; y: number };
  /** Text content */
  text: string;
  /** Font size token or points */
  fontSize: 'sm' | 'base' | 'lg';
  /** Text color in hex format */
  color: string;
  /** Optional background badge or note */
  note?: string;
  /** Explicit text box width in normalized coordinates if wrapped */
  width?: number;
}

export interface CanonicalTextHighlightAnnotation extends CanonicalAnnotationBase {
  kind: 'text_highlight';
  /** Highlight color name */
  colorName: 'yellow' | 'green' | 'blue' | 'pink' | 'orange';
  /** Color in hex format */
  color: string;
  /** Optional associated user note or card */
  note?: string;
  /** Normalized bounding quads [x0, y0, x1, y1] in PDF space */
  quads?: [number, number, number, number][];
  /** The selected text excerpt */
  exactText?: string;
}

export type CanonicalAnnotation =
  | CanonicalInkAnnotation
  | CanonicalTextAnnotation
  | CanonicalTextHighlightAnnotation;

export interface PageGeometryMetadata {
  pageWidth: number;
  pageHeight: number;
  rotation: number;
  coordinateSystem: 'pdf-page-normalized';
}

/**
 * Operation deltas for atomic persistence and native-to-web synchronization.
 * Uses unique operation IDs to guarantee idempotency and avoid duplicate or out-of-order writes.
 */
export type CanonicalAnnotationOperation =
  | {
      opId: string;
      type: 'add';
      documentId: string;
      pageIndex: number;
      annotation: CanonicalAnnotation;
      clientTimestamp: number;
    }
  | {
      opId: string;
      type: 'update';
      documentId: string;
      pageIndex: number;
      annotation: CanonicalAnnotation;
      clientTimestamp: number;
    }
  | {
      opId: string;
      type: 'delete';
      documentId: string;
      pageIndex: number;
      annotationId: string;
      clientTimestamp: number;
    };

export interface CanonicalDocumentState {
  documentId: string;
  schemaVersion: number;
  lastRevision: number;
  annotationsByPage: Record<number, CanonicalAnnotation[]>;
  updatedAt: number;
}

export interface DurableOperationJournal {
  documentId: string;
  schemaVersion: number;
  processedOpIds: string[];
  lastRevision: number;
  pendingOps: CanonicalAnnotationOperation[];
  updatedAt: number;
}

