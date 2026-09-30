/**
 * Turning a text selection into something that still points at the same words
 * next week.
 *
 * Deliberately free of React, of DOM writes, and of any `pdfjs-dist` import -
 * it takes the shapes it needs structurally. That keeps it unit-testable
 * without a headless browser and keeps pdf.js out of any chunk that only wants
 * to resolve an anchor.
 */

import { ANCHOR_ALGO, type TextAnchor, type ResolvedAnchor } from '../types/pdfAnnotation.types';

/** The parts of pdf.js's TextItem we rely on. */
export interface TextItemLike {
  str: string;
  hasEOL?: boolean;
}

/** The parts of pdf.js's PageViewport we rely on. */
export interface ViewportLike {
  convertToPdfPoint(x: number, y: number): any[];
  convertToViewportPoint?(x: number, y: number): any[];
  convertToViewportRectangle?(rect: any[]): any[];
}

export interface ItemRange {
  itemIndex: number;
  start: number;
  end: number;
}

export interface CanonicalPage {
  text: string;
  itemRanges: ItemRange[];
}

const MAX_EXACT = 512;
const CONTEXT = 32;

/**
 * Normalize one text run.
 *
 * NFC so that decomposed and precomposed Arabic compare equal. Tatweel (U+0640)
 * is a pure justification glyph carrying no meaning, and PDF producers insert it
 * inconsistently, so it would otherwise make offsets depend on the exporter.
 * Diacritics are deliberately KEPT - stripping them would collapse distinct
 * Arabic words, and this text is compared against itself, never fuzzy-matched.
 */
function normalizeRun(s: string): string {
  return s
    .normalize('NFC')
    .replace(/ـ/g, '')
    .replace(/[ \t ]+/g, ' ');
}

/**
 * Build the page's canonical text plus the map from item index to its span in
 * that text.
 *
 * Each item is normalized INDEPENDENTLY and then concatenated, rather than
 * normalizing the joined string. That matters: collapsing a whitespace run that
 * straddles an item boundary would make an item's length depend on its
 * neighbour, and the offsets would stop being reproducible. Per-item
 * normalization is what makes this a pure function of the PDF.
 */
export function canonicalizePage(items: TextItemLike[]): CanonicalPage {
  let text = '';
  const itemRanges: ItemRange[] = [];

  for (let i = 0; i < items.length; i++) {
    const piece = normalizeRun(items[i].str ?? '');
    const start = text.length;
    text += piece;
    itemRanges.push({ itemIndex: i, start, end: text.length });
    if (items[i].hasEOL) text += '\n';
  }

  return { text, itemRanges };
}

/** Canonical length of a raw prefix - converts a DOM offset into canonical space. */
export function canonicalOffsetWithin(rawText: string, domOffset: number): number {
  return normalizeRun(rawText.slice(0, domOffset)).length;
}

/**
 * Stamp `data-item-index` onto the text layer's spans.
 *
 * pdf.js emits one span per text item but SKIPS items whose `str` is empty, so
 * span index and item index drift apart. A two-pointer walk re-establishes the
 * correspondence by matching text content. Returns the number of spans tagged so
 * the caller can assert the walk consumed everything.
 */
export function tagTextLayerSpans(spans: HTMLElement[], items: TextItemLike[]): number {
  let item = 0;
  let tagged = 0;

  for (const span of spans) {
    const content = span.textContent ?? '';
    // Skip past items pdf.js chose not to render.
    while (item < items.length && (items[item].str ?? '') !== content) item++;
    if (item >= items.length) break;
    span.dataset.itemIndex = String(item);
    item++;
    tagged++;
  }

  return tagged;
}

/** Client rects → quads in PDF user space, relative to the page element's box. */
export function rectsToQuads(
  rects: DOMRect[],
  pageBox: { left: number; top: number },
  viewport: ViewportLike,
): [number, number, number, number][] {
  const quads: [number, number, number, number][] = [];
  for (const r of rects) {
    if (r.width < 0.5 || r.height < 0.5) continue; // collapsed rects from empty ranges
    const x = r.left - pageBox.left;
    const y = r.top - pageBox.top;
    // Bottom-left and top-right, because PDF user space has y growing upward.
    const [x0, y0] = viewport.convertToPdfPoint(x, y + r.height);
    const [x1, y1] = viewport.convertToPdfPoint(x + r.width, y);
    quads.push([x0, y0, x1, y1]);
  }
  return quads;
}

/** Quads → CSS-pixel boxes for the current viewport. Correct at any scale/rotation. */
export function quadsToRects(
  quads: [number, number, number, number][],
  viewport: ViewportLike,
): { left: number; top: number; width: number; height: number }[] {
  return quads.map((q) => {
    let left: number;
    let top: number;
    let width: number;
    let height: number;

    if (typeof viewport.convertToViewportPoint === 'function') {
      const [x0, y0] = viewport.convertToViewportPoint(q[0], q[1]);
      const [x1, y1] = viewport.convertToViewportPoint(q[2], q[3]);
      left = Math.min(x0, x1);
      top = Math.min(y0, y1);
      width = Math.abs(x1 - x0);
      height = Math.abs(y1 - y0);
    } else if (typeof viewport.convertToViewportRectangle === 'function') {
      const r = viewport.convertToViewportRectangle(q);
      left = Math.min(r[0], r[2]);
      top = Math.min(r[1], r[3]);
      width = Math.abs(r[2] - r[0]);
      height = Math.abs(r[3] - r[1]);
    } else {
      left = Math.min(q[0], q[2]);
      top = Math.min(q[1], q[3]);
      width = Math.abs(q[2] - q[0]);
      height = Math.abs(q[3] - q[1]);
    }

    return { left, top, width, height };
  });
}

export interface BuildAnchorInput {
  /** The canonical page text the offsets index into. */
  text: string;
  start: number;
  end: number;
  quads: [number, number, number, number][];
  pageW: number;
  pageH: number;
}

export function buildAnchor({ text, start, end, quads, pageW, pageH }: BuildAnchorInput): TextAnchor {
  return {
    algo: ANCHOR_ALGO,
    start,
    end,
    exact: text.slice(start, end).slice(0, MAX_EXACT),
    prefix: text.slice(Math.max(0, start - CONTEXT), start),
    suffix: text.slice(end, end + CONTEXT),
    quads,
    pageW,
    pageH,
  };
}

/** Every index at which `needle` occurs in `hay`. */
function allIndexesOf(hay: string, needle: string): number[] {
  if (!needle) return [];
  const out: number[] = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/**
 * Find where this anchor's text lives in the page as it is TODAY.
 *
 * Ordered cheapest-and-most-certain first. Returning null is not a failure to be
 * papered over - the caller marks the annotation orphaned and still shows the
 * student their note. Losing someone's note to a heuristic is the one outcome
 * worth engineering against.
 */
export function resolveAnchor(anchor: TextAnchor, canonicalText: string): ResolvedAnchor | null {
  const { exact, prefix, suffix, start, end } = anchor;

  if (!exact) return null;

  // 1. The offsets still say what they said. Only valid if the canonicalizer
  //    hasn't changed under us.
  if (anchor.algo === ANCHOR_ALGO && canonicalText.slice(start, end) === exact) {
    return { start, end, resolvedBy: 'offsets' };
  }

  // 2. Quote with its surrounding context - unique enough to trust outright.
  const withContext = prefix + exact + suffix;
  const ctxHits = allIndexesOf(canonicalText, withContext);
  if (ctxHits.length === 1) {
    const s = ctxHits[0] + prefix.length;
    return { start: s, end: s + exact.length, resolvedBy: 'quote' };
  }

  // 3. The quote alone. If the text repeats, prefer the occurrence closest to
  //    where it used to be - the page rarely reshuffles that much.
  const hits = allIndexesOf(canonicalText, exact);
  if (hits.length > 0) {
    let best = hits[0];
    for (const h of hits) {
      if (Math.abs(h - start) < Math.abs(best - start)) best = h;
    }
    return { start: best, end: best + exact.length, resolvedBy: 'search' };
  }

  return null;
}

/** Whether stored quads may still be trusted - i.e. the page is the same size. */
export function geometryMatches(anchor: TextAnchor, pageW: number, pageH: number): boolean {
  return Math.abs(anchor.pageW - pageW) < 1 && Math.abs(anchor.pageH - pageH) < 1;
}

/**
 * Inverse of canonicalOffsetWithin: the raw index whose canonical prefix length
 * is `target`.
 *
 * Deliberately defined BY canonicalOffsetWithin rather than by re-deriving the
 * normalization backwards, so the two can never disagree. Spans are short
 * (a text run, not a page), so the linear scan is cheap and, unlike an
 * incremental normalizer, it is exactly consistent by construction.
 */
export function rawOffsetForCanonical(rawText: string, target: number): number {
  if (target <= 0) return 0;
  for (let i = 0; i <= rawText.length; i++) {
    if (canonicalOffsetWithin(rawText, i) >= target) return i;
  }
  return rawText.length;
}
