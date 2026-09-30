/**
 * Verifies the PDF highlight anchoring core.
 *
 * Run with:  npm run test:anchor
 *
 * Pure functions only - no browser, no pdf.js. This decides whether a highlight
 * still lands on the right words after a zoom, a reopen, or a re-upload of the
 * PDF, so each failure mode is pinned down explicitly rather than assumed.
 */
import {
  canonicalizePage,
  canonicalOffsetWithin,
  rawOffsetForCanonical,
  tagTextLayerSpans,
  buildAnchor,
  resolveAnchor,
  geometryMatches,
  quadsToRects,
  rectsToQuads,
  type TextItemLike,
} from '../src/lib/pdfAnchor';
import { ANCHOR_ALGO } from '../src/types/pdfAnnotation.types';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); failed++; }
};

const items = (...strs: (string | [string, boolean])[]): TextItemLike[] =>
  strs.map(s => Array.isArray(s) ? { str: s[0], hasEOL: s[1] } : { str: s });

console.log('Canonicalization:');
{
  const c = canonicalizePage(items('Hello ', 'world'));
  check('concatenates items', c.text === 'Hello world', JSON.stringify(c.text));
  check('records a range per item', c.itemRanges.length === 2);
  check('ranges are contiguous', c.itemRanges[0].end === c.itemRanges[1].start);
  check('range maps back to its item text',
    c.text.slice(c.itemRanges[1].start, c.itemRanges[1].end) === 'world');
}
{
  const c = canonicalizePage(items(['line one', true], 'line two'));
  check('hasEOL inserts a newline', c.text === 'line one\nline two', JSON.stringify(c.text));
}
{
  const c = canonicalizePage(items('a  \t  b'));
  check('collapses whitespace runs', c.text === 'a b', JSON.stringify(c.text));
}
{
  // Tatweel is a justification glyph that producers sprinkle inconsistently.
  const c = canonicalizePage(items('محـــمد'));
  check('strips tatweel', c.text === 'محمد', JSON.stringify(c.text));
}
{
  // Decomposed vs precomposed must fold together, or Arabic offsets would
  // depend on which tool exported the PDF.
  // Alef + combining hamza above (U+0627 U+0654) must fold to the precomposed
  // alef-with-hamza (U+0623). Built from code points so the two sides cannot
  // accidentally be the same literal.
  const decomposed = canonicalizePage(items('أ'));
  const precomposed = canonicalizePage(items('أ'));
  check('NFC folds decomposed forms', decomposed.text === precomposed.text,
    `${JSON.stringify(decomposed.text)} vs ${JSON.stringify(precomposed.text)}`);
  check('and the fold yields one precomposed char',
    decomposed.text === 'أ' && decomposed.text.length === 1,
    `len=${decomposed.text.length}`);
}
{
  // Diacritics carry meaning in Arabic and must survive normalization.
  const withHarakat = 'مُحَمَّد';
  const c = canonicalizePage(items(withHarakat));
  check('keeps diacritics', c.text === withHarakat, JSON.stringify(c.text));
}
{
  // The determinism guarantee: an item's canonical length must not depend on
  // its neighbours, or offsets stop being reproducible across opens.
  const split = canonicalizePage(items('foo  ', '  bar'));
  const alone = canonicalizePage(items('foo  '));
  check('per-item normalization is neighbour-independent',
    split.itemRanges[0].end === alone.itemRanges[0].end,
    `${split.itemRanges[0].end} vs ${alone.itemRanges[0].end}`);
}

console.log('\nDOM offset mapping:');
check('canonical offset of a raw prefix', canonicalOffsetWithin('a  b', 4) === 3,
  String(canonicalOffsetWithin('a  b', 4)));
check('offset 0 stays 0', canonicalOffsetWithin('anything', 0) === 0);

console.log('\nText layer span tagging:');
{
  // pdf.js drops empty items, so span index and item index drift apart.
  const spans = ['alpha', 'gamma'].map(t =>
    ({ textContent: t, dataset: {} as Record<string, string> }) as unknown as HTMLElement);
  const n = tagTextLayerSpans(spans, items('alpha', '', 'gamma'));
  check('tags every rendered span', n === 2, String(n));
  check('skips past the dropped empty item', spans[1].dataset.itemIndex === '2',
    spans[1].dataset.itemIndex);
}

console.log('\nAnchor resolution:');
const page = canonicalizePage(items('The quick brown fox jumps over the lazy dog'));
const at = page.text.indexOf('brown fox');
const anchor = buildAnchor({
  text: page.text, start: at, end: at + 'brown fox'.length,
  quads: [[10, 20, 110, 40]], pageW: 600, pageH: 800,
});

check('captures the exact text', anchor.exact === 'brown fox', anchor.exact);
check('captures leading context', anchor.prefix.endsWith('quick '), JSON.stringify(anchor.prefix));
check('stamps the algo version', anchor.algo === ANCHOR_ALGO);
{
  const r = resolveAnchor(anchor, page.text);
  check('unchanged page resolves via offsets', r?.resolvedBy === 'offsets', r?.resolvedBy);
  check('offsets point at the right text', page.text.slice(r!.start, r!.end) === 'brown fox');
}
{
  // Text prepended: the offsets are stale, the quote must rescue it.
  const shifted = 'PREAMBLE. ' + page.text;
  const r = resolveAnchor(anchor, shifted);
  check('shifted page resolves via quote', r?.resolvedBy === 'quote', r?.resolvedBy);
  check('quote lands on the right text', shifted.slice(r!.start, r!.end) === 'brown fox');
}
{
  // The quote occurs twice; the nearer one to the original offset should win.
  const doubled = page.text + ' ... brown fox again';
  const stale = { ...anchor, start: 0, end: 9, algo: 999 };
  const r = resolveAnchor(stale, doubled);
  check('repeated text picks the nearest occurrence',
    r?.start === doubled.indexOf('brown fox'), String(r?.start));
}
{
  const r = resolveAnchor(anchor, 'completely unrelated content');
  check('unfindable text returns null rather than guessing', r === null, JSON.stringify(r));
}
{
  // A canonicalizer change must not silently trust the old offsets.
  const oldAlgo = { ...anchor, algo: ANCHOR_ALGO - 1 };
  const r = resolveAnchor(oldAlgo, page.text);
  check('stale algo refuses the offset fast-path', r?.resolvedBy !== 'offsets', r?.resolvedBy);
  check('stale algo still finds the text', page.text.slice(r!.start, r!.end) === 'brown fox');
}

console.log('\nGeometry guard:');
check('same page size matches', geometryMatches(anchor, 600, 800));
check('different page size does not', !geometryMatches(anchor, 612, 792));

console.log('\nQuad round-trip (scale independence):');
{
  // Stand-in for pdf.js's real PageViewport at scale s: y flips, origin top-left.
  const vp = (s: number, h = 800) => ({
    convertToPdfPoint: (x: number, y: number) => [x / s, (h * s - y) / s],
    convertToViewportPoint: (x: number, y: number) => [x * s, h * s - y * s],
  });

  const rect = { left: 100, top: 200, width: 50, height: 10 } as DOMRect;
  const captured = rectsToQuads([rect], { left: 0, top: 0 }, vp(1));

  const at1x = quadsToRects(captured, vp(1))[0];
  check('round-trips at the capture scale',
    Math.abs(at1x.left - 100) < 0.01 && Math.abs(at1x.top - 200) < 0.01
    && Math.abs(at1x.width - 50) < 0.01 && Math.abs(at1x.height - 10) < 0.01,
    JSON.stringify(at1x));

  const at2x = quadsToRects(captured, vp(2))[0];
  check('scales cleanly to 2x zoom',
    Math.abs(at2x.left - 200) < 0.01 && Math.abs(at2x.width - 100) < 0.01
    && Math.abs(at2x.height - 20) < 0.01,
    JSON.stringify(at2x));

  // Legacy mock fallback with convertToViewportRectangle
  const vpLegacy = (s: number, h = 800) => ({
    convertToPdfPoint: (x: number, y: number) => [x / s, (h * s - y) / s],
    convertToViewportRectangle: (r: any[]) => [r[0] * s, h * s - r[1] * s, r[2] * s, h * s - r[3] * s],
  });
  const at1xLegacy = quadsToRects(captured, vpLegacy(1))[0];
  check('fallback to convertToViewportRectangle works',
    Math.abs(at1xLegacy.left - 100) < 0.01 && Math.abs(at1xLegacy.width - 50) < 0.01);
}
{
  const vp1 = {
    convertToPdfPoint: (x: number, y: number) => [x, 800 - y],
    convertToViewportPoint: (x: number, y: number) => [x, 800 - y],
  };
  const zero = rectsToQuads([{ left: 0, top: 0, width: 0, height: 0 } as DOMRect], { left: 0, top: 0 }, vp1);
  check('drops collapsed rects', zero.length === 0, String(zero.length));
}

console.log('\nCanonical -> raw offset inverse:');
check('inverse of a collapsed whitespace run', rawOffsetForCanonical('a  b', 3) === 4,
  String(rawOffsetForCanonical('a  b', 3)));
check('target 0 maps to 0', rawOffsetForCanonical('anything', 0) === 0);
check('inverse round-trips at every index', (() => {
  // The two functions must never disagree, since highlight rects are rebuilt
  // from live DOM offsets while anchors are stored in canonical ones.
  const raw = 'foo  bar\tbaz  qux';
  for (let i = 0; i <= raw.length; i++) {
    const c = canonicalOffsetWithin(raw, i);
    if (canonicalOffsetWithin(raw, rawOffsetForCanonical(raw, c)) !== c) return false;
  }
  return true;
})());
check('inverse survives Arabic tatweel removal', (() => {
  const raw = 'محــمد';
  const c = canonicalOffsetWithin(raw, raw.length);
  return canonicalOffsetWithin(raw, rawOffsetForCanonical(raw, c)) === c;
})());

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
