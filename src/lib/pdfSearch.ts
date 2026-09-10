/**
 * Find-in-PDF over the same canonical text the highlight anchors use.
 *
 * WHY THIS DOES NOT REUSE `normalizeRun` DIRECTLY
 *
 * `canonicalizePage()` deliberately KEEPS Arabic diacritics, and its comment
 * gives the reason: canonical text "is compared against itself, never
 * fuzzy-matched". Search is the case that breaks that premise. Nobody types
 * tashkeel into a search box, but lecture PDFs are full of it, so an exact
 * substring test against canonical text misses every vocalized word.
 *
 * The fix is a SECOND fold applied on top of canonical text, never a change to
 * `normalizeRun` - editing that would change every stored offset and force an
 * ANCHOR_ALGO bump, demoting every highlight a student has already made.
 *
 * The fold deletes characters, so it carries an index map back to canonical
 * space. That is what lets a match found in folded text resolve to real text
 * items, and from there to the same quads the highlight renderer already draws.
 */

import type { ItemRange, TextItemLike } from './pdfAnchor';
import { canonicalizePage } from './pdfAnchor';

/** Below this a query matches so much of a lecture that the results are noise. */
export const MIN_QUERY_LENGTH = 2;

/** Harakat, Quranic annotation marks, and the superscript alef - all droppable. */
const ARABIC_DIACRITICS = /[ً-ٰٟۖ-ۭ]/;

/** Tatweel is already gone from canonical text; kept here so the fold is total. */
const TATWEEL = 'ـ';

const ARABIC_INDIC_ZERO = 0x0660;
const EXTENDED_ARABIC_INDIC_ZERO = 0x06F0;

/**
 * Map one character to its search-equivalent form, or to '' to delete it.
 *
 * Substitutions are 1:1 so they cost nothing in the index map; only deletions
 * shift offsets. The four letter classes folded here are the ones students
 * actually type differently from the way a PDF spells them:
 *
 *   - alef with any hamza or wasla  -> bare alef
 *   - alef maksura                  -> ya
 *   - ta marbuta                    -> ha
 *   - Arabic-Indic digits           -> ASCII digits
 *
 * Hamza carriers (ؤ, ئ) are left alone: folding them merges words that differ
 * in meaning far more often than it rescues a typo.
 */
function foldChar(ch: string): string {
  if (ARABIC_DIACRITICS.test(ch)) return '';
  if (ch === TATWEEL) return '';

  switch (ch) {
    case 'أ': case 'إ': case 'آ': case 'ٱ':
      return 'ا';
    case 'ى':
      return 'ي';
    case 'ة':
      return 'ه';
    default:
      break;
  }

  const code = ch.codePointAt(0)!;
  if (code >= ARABIC_INDIC_ZERO && code <= ARABIC_INDIC_ZERO + 9) {
    return String(code - ARABIC_INDIC_ZERO);
  }
  if (code >= EXTENDED_ARABIC_INDIC_ZERO && code <= EXTENDED_ARABIC_INDIC_ZERO + 9) {
    return String(code - EXTENDED_ARABIC_INDIC_ZERO);
  }

  return ch.toLowerCase();
}

export interface FoldedText {
  text: string;
  /** `map[i]` is the index in the SOURCE string that folded char `i` came from. */
  map: number[];
}

/**
 * Fold text for matching, recording where each surviving character came from.
 *
 * Whitespace is collapsed to a single space so a query typed as one phrase
 * still matches text the PDF broke across two items or a line.
 */
export function foldForSearch(input: string): FoldedText {
  let text = '';
  const map: number[] = [];
  // Index of the whitespace run's FIRST character, not of the word after it.
  // A match ending on the last letter of a word takes the following folded
  // char's source index as its exclusive end, so pointing this forward would
  // pull the separating space into every such match.
  let pendingSpaceAt = -1;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (/\s/.test(ch)) {
      // Never open with a space, and never emit two in a row.
      if (text.length > 0 && pendingSpaceAt === -1) pendingSpaceAt = i;
      continue;
    }

    const folded = foldChar(ch);
    if (!folded) continue;

    if (pendingSpaceAt !== -1) {
      text += ' ';
      map.push(pendingSpaceAt);
      pendingSpaceAt = -1;
    }

    for (const out of folded) {
      text += out;
      map.push(i);
    }
  }

  return { text, map };
}

export interface PageSearchIndex {
  pageNumber: number;
  canonical: string;
  itemRanges: ItemRange[];
  folded: FoldedText;
}

/** Build the searchable form of one page from its pdf.js text items. */
export function buildPageSearchIndex(pageNumber: number, items: TextItemLike[]): PageSearchIndex {
  const { text, itemRanges } = canonicalizePage(items);
  return {
    pageNumber,
    canonical: text,
    itemRanges,
    folded: foldForSearch(text),
  };
}

export interface SearchMatch {
  pageNumber: number;
  /** Offsets into the page's CANONICAL text - the same space anchors use. */
  start: number;
  end: number;
  /** Surrounding canonical text for the results list, and where the hit sits in it. */
  snippet: string;
  snippetStart: number;
  snippetEnd: number;
}

const SNIPPET_CONTEXT = 40;

function buildSnippet(canonical: string, start: number, end: number) {
  const from = Math.max(0, start - SNIPPET_CONTEXT);
  const to = Math.min(canonical.length, end + SNIPPET_CONTEXT);
  const raw = canonical.slice(from, to);

  // Newlines would break the single-line result row; the offsets stay valid
  // because this is a 1:1 substitution.
  const snippet = raw.replace(/\s+/g, ' ');

  return {
    snippet: (from > 0 ? '…' : '') + snippet + (to < canonical.length ? '…' : ''),
    snippetStart: start - from + (from > 0 ? 1 : 0),
    snippetEnd: end - from + (from > 0 ? 1 : 0),
  };
}

/**
 * All matches for `query` on one page, in reading order.
 *
 * `limit` caps the per-page result count: a two-letter query against a
 * three-hundred-page lecture would otherwise build tens of thousands of objects
 * before the UI could show the first one.
 */
export function searchPageIndex(
  index: PageSearchIndex,
  query: string,
  limit = 200,
): SearchMatch[] {
  const q = foldForSearch(query).text;
  if (q.length < MIN_QUERY_LENGTH) return [];

  const { folded, canonical } = index;
  const matches: SearchMatch[] = [];

  let from = 0;
  while (matches.length < limit) {
    const at = folded.text.indexOf(q, from);
    if (at === -1) break;

    const start = folded.map[at];
    // The exclusive end is the START of the next folded character, not the
    // source index of the last matched one - that is what keeps diacritics
    // trailing the final letter inside the highlighted range.
    const end = at + q.length < folded.map.length
      ? folded.map[at + q.length]
      : canonical.length;

    matches.push({
      pageNumber: index.pageNumber,
      start,
      end,
      ...buildSnippet(canonical, start, end),
    });

    from = at + Math.max(1, q.length);
  }

  return matches;
}

export interface ItemSpan {
  itemIndex: number;
  /** Offsets WITHIN that item's canonical text. */
  from: number;
  to: number;
}

/**
 * Split a canonical range into the per-item pieces it covers.
 *
 * The text layer is one span per item, so painting a match means walking these
 * and converting each canonical offset back to a raw DOM offset with
 * `rawOffsetForCanonical`. Items the range only touches at a zero-width
 * boundary are dropped, or the caller would build empty Ranges.
 */
export function canonicalRangeToItemSpans(
  itemRanges: ItemRange[],
  start: number,
  end: number,
): ItemSpan[] {
  const spans: ItemSpan[] = [];

  for (const r of itemRanges) {
    if (r.end <= start) continue;
    if (r.start >= end) break;

    const from = Math.max(start, r.start) - r.start;
    const to = Math.min(end, r.end) - r.start;
    if (to > from) spans.push({ itemIndex: r.itemIndex, from, to });
  }

  return spans;
}
