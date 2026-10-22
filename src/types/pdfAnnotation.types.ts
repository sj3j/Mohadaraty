/**
 * Device-local PDF annotations.
 *
 * These never reach Firestore. They live in IndexedDB on the one device that
 * created them, which is a deliberate product decision, not an oversight - see
 * the notes drawer's JSON export for the migration path off a dying phone.
 */

/** Bump when canonicalizePage() changes. Invalidates the offset fast-path only. */
export const ANCHOR_ALGO = 1;

/** Bump when the PdfAnnotation record shape changes. Migrated lazily on read. */
export const SCHEMA_VERSION = 1;

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'orange';

export const HIGHLIGHT_COLORS: Record<HighlightColor, string> = {
  yellow: '#fde68a',
  green: '#bbf7d0',
  blue: '#bfdbfe',
  pink: '#fbcfe8',
  orange: '#fed7aa',
};

/**
 * Where a highlight lives in a page's text.
 *
 * Three redundant locators, deliberately. Offsets are exact but brittle - they
 * break the moment the canonicalizer changes or the PDF is re-uploaded. The
 * quote (W3C TextQuoteSelector) survives both. Quads survive even a total loss
 * of the text layer, but only while the page geometry is unchanged.
 *
 * Nothing here is in pixels. Quads are PDF user space, so they stay correct at
 * any zoom and at any rotation.
 */
export interface TextAnchor {
  algo: number;
  /** Char offsets into the canonical page text. */
  start: number;
  end: number;
  /** The selected text itself, capped so a runaway selection cannot bloat the record. */
  exact: string;
  /** 32 chars either side, to disambiguate a repeated `exact`. */
  prefix: string;
  suffix: string;
  /** [x0,y0,x1,y1] in PDF user space, one per visual line of the selection. */
  quads: [number, number, number, number][];
  /** Page size at scale 1 / rotation 0, as a geometry sanity check for `quads`. */
  pageW: number;
  pageH: number;
}

export interface PdfAnnotation {
  id: string;
  lectureId: string;
  /** pdfDoc.fingerprints[0] - detects the PDF being replaced at the same URL. */
  docFingerprint: string;
  kind: 'highlight' | 'pin' | 'text';
  /** 1-based, matching what the reader shows the student. */
  page: number;
  color: HighlightColor;
  /** Direct text content for kind === 'text' */
  text?: string;
  /** Font size for kind === 'text': 'sm' (14px), 'base' (18px), 'lg' (24px) */
  fontSize?: 'sm' | 'base' | 'lg';
  /** Presence of a note is what earns the highlight a badge or mirrors text for search */
  note?: string;
  /** Required when kind === 'highlight'. */
  anchor?: TextAnchor;
  /** PDF user space or normalized coordinates (0.0 - 1.0). Required for 'pin' and 'text'. */
  point?: { x: number; y: number };
  /** Ties the per-page fragments of one selection that crossed a page boundary. */
  groupId?: string;
  createdAt: number;
  updatedAt: number;
  schema: number;
}

/** How resolveAnchor() found the text. Derived per render - never persisted. */
export type ResolvedBy = 'offsets' | 'quote' | 'search' | 'quads';

export interface ResolvedAnchor {
  start: number;
  end: number;
  resolvedBy: ResolvedBy;
}

/** Per-document reading state, so reopening a lecture resumes where it left off. */
export interface DocMeta {
  key: string;
  fingerprint: string;
  pageCount: number;
  lastPage: number;
  lastScale: number;
  updatedAt: number;
}
