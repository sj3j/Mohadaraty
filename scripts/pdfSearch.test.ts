/**
 * Verifies find-in-PDF matching.
 *
 * Run with:  npm run test:search
 *
 * Pure functions only - no browser, no pdf.js. The case that matters most is
 * Arabic: a student types a word bare, the PDF spells it with tashkeel, and the
 * match still has to land on the vocalized word AND cover its diacritics, or
 * the highlight would clip mid-letter.
 */
import {
  foldForSearch,
  buildPageSearchIndex,
  searchPageIndex,
  canonicalRangeToItemSpans,
  MIN_QUERY_LENGTH,
} from '../src/lib/pdfSearch';
import type { TextItemLike } from '../src/lib/pdfAnchor';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); failed++; }
};

const items = (...strs: (string | [string, boolean])[]): TextItemLike[] =>
  strs.map(s => Array.isArray(s) ? { str: s[0], hasEOL: s[1] } : { str: s });

console.log('Folding:');
{
  check('strips harakat', foldForSearch('كِتَاب').text === 'كتاب', foldForSearch('كِتَاب').text);
  check('folds alef hamza forms', foldForSearch('أإآٱ').text === 'اااا', foldForSearch('أإآٱ').text);
  check('folds alef maksura to ya', foldForSearch('مصطفى').text === 'مصطفي');
  check('folds ta marbuta to ha', foldForSearch('خلية').text === 'خليه');
  check('folds Arabic-Indic digits', foldForSearch('٢٠٢٥').text === '2025');
  check('folds extended Arabic-Indic digits', foldForSearch('۲۰۲۵').text === '2025');
  check('lowercases Latin', foldForSearch('Cell Membrane').text === 'cell membrane');
  check('leaves hamza carriers alone', foldForSearch('مسؤول').text === 'مسؤول');
  check('collapses whitespace runs', foldForSearch('a \n\t b').text === 'a b');
  check('does not lead with a space', foldForSearch('   abc').text === 'abc');
  check('does not trail a space', foldForSearch('abc   ').text === 'abc');
}

console.log('\nIndex map:');
{
  const f = foldForSearch('كِتَاب ٢٠٢٥');
  check('map has one entry per folded char', f.map.length === f.text.length,
    `${f.map.length} vs ${f.text.length}`);
  check('map is non-decreasing', f.map.every((v, i) => i === 0 || v >= f.map[i - 1]));
  check('map stays in source bounds', f.map.every(v => v >= 0 && v < 'كِتَاب ٢٠٢٥'.length));
}

console.log('\nMatching:');
{
  // The PDF spells it vocalized; the student types it bare.
  const idx = buildPageSearchIndex(3, items('الخَلِيَّة ', 'هي وحدة البناء'));
  const hits = searchPageIndex(idx, 'الخلية');

  check('bare query matches vocalized text', hits.length === 1, JSON.stringify(hits));
  check('match reports its page', hits[0]?.pageNumber === 3);

  const covered = idx.canonical.slice(hits[0].start, hits[0].end);
  check('range covers the vocalized word', covered === 'الخَلِيَّة', JSON.stringify(covered));
  check('range folds back to the query', foldForSearch(covered).text === 'الخليه',
    foldForSearch(covered).text);
}

{
  const idx = buildPageSearchIndex(1, items('the cell wall, the cell membrane'));
  const hits = searchPageIndex(idx, 'CELL');
  check('finds every occurrence', hits.length === 2, String(hits.length));
  check('occurrences are in reading order', hits[0].start < hits[1].start);
  check('is case-insensitive', idx.canonical.slice(hits[0].start, hits[0].end) === 'cell');
}

{
  // pdf.js routinely splits a phrase across items; canonical text joins them.
  const idx = buildPageSearchIndex(1, items('cell ', 'membrane'));
  check('matches across an item boundary', searchPageIndex(idx, 'cell membrane').length === 1);
}

{
  const idx = buildPageSearchIndex(1, items('aaaa'));
  const hits = searchPageIndex(idx, 'aa');
  check('overlapping matches advance and terminate', hits.length === 2, String(hits.length));
}

{
  const idx = buildPageSearchIndex(1, items('anything at all'));
  check('rejects a query under MIN_QUERY_LENGTH',
    searchPageIndex(idx, 'a'.repeat(MIN_QUERY_LENGTH - 1)).length === 0);
  check('rejects an empty query', searchPageIndex(idx, '').length === 0);
  check('rejects a whitespace-only query', searchPageIndex(idx, '   ').length === 0);
  check('respects the per-page limit', searchPageIndex(buildPageSearchIndex(1, items('ab '.repeat(50))), 'ab', 10).length === 10);
}

console.log('\nSnippets:');
{
  const idx = buildPageSearchIndex(1, items('x'.repeat(100) + ' target ' + 'y'.repeat(100)));
  const [hit] = searchPageIndex(idx, 'target');
  check('snippet contains the hit', hit.snippet.includes('target'));
  check('snippet offsets locate the hit',
    hit.snippet.slice(hit.snippetStart, hit.snippetEnd) === 'target',
    JSON.stringify(hit.snippet.slice(hit.snippetStart, hit.snippetEnd)));
  check('snippet is elided at both ends',
    hit.snippet.startsWith('…') && hit.snippet.endsWith('…'));
}

console.log('\nItem spans:');
{
  const idx = buildPageSearchIndex(1, items('cell ', 'membrane'));
  const [hit] = searchPageIndex(idx, 'cell membrane');
  const spans = canonicalRangeToItemSpans(idx.itemRanges, hit.start, hit.end);

  check('splits the range across both items', spans.length === 2, JSON.stringify(spans));
  check('every span is non-empty', spans.every(s => s.to > s.from));
  check('spans reassemble the matched text',
    spans.map(s => items('cell ', 'membrane')[s.itemIndex].str!.slice(s.from, s.to)).join('')
      === 'cell membrane');
}

{
  const idx = buildPageSearchIndex(1, items('abc', 'def'));
  // A range ending exactly on the first item's boundary must not emit an empty
  // span for the second.
  const spans = canonicalRangeToItemSpans(idx.itemRanges, 0, 3);
  check('drops zero-width boundary touches', spans.length === 1, JSON.stringify(spans));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
