#!/usr/bin/env node
/**
 * Firestore composite-index drift check.
 *
 * Firestore throws FAILED_PRECONDITION at *runtime* when a query combines
 * equality filters with an orderBy on a different field and no composite index
 * covers it. Nothing in `tsc --noEmit` or the rules tests catches that, so a
 * missing index ships to production and fails for users.
 *
 * This scans the source for query shapes and reports any that need a composite
 * index but have no matching entry in firestore.indexes.json.
 *
 * Advisory by design: regex-based extraction cannot see dynamically built
 * queries, so it exits 0 unless --strict is passed. Treat findings as leads.
 *
 *   node scripts/checkIndexDrift.mjs [--strict] [--verbose]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const STRICT = process.argv.includes('--strict');
const VERBOSE = process.argv.includes('--verbose');

const SCAN_TARGETS = ['src', 'api', 'shared', 'functions', 'server.ts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'android', 'graphify-out']);
const EXTS = /\.(ts|tsx|js|jsx|mjs)$/;

/** Collect candidate source files. */
function collect(target) {
  const abs = join(ROOT, target);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return [];
  }
  if (st.isFile()) return EXTS.test(abs) ? [abs] : [];

  const out = [];
  for (const entry of readdirSync(abs)) {
    if (SKIP_DIRS.has(entry)) continue;
    const child = join(abs, entry);
    const cst = statSync(child);
    if (cst.isDirectory()) out.push(...collect(relative(ROOT, child)));
    else if (EXTS.test(child)) out.push(child);
  }
  return out;
}

/** Line number for a character offset. */
const lineAt = (src, idx) => src.slice(0, idx).split('\n').length;

/**
 * Extract query shapes.
 *
 * Modular SDK:  query(collection(db, 'x'), where('a','==',v), orderBy('b','desc'))
 * Admin SDK:    db.collection('x').where('a','==',v).orderBy('b','desc')
 *
 * Both are matched by anchoring on the collection name and reading a forward
 * window, which is enough for the chained/comma'd forms used in this repo.
 */
function extractShapes(src, file) {
  const shapes = [];
  const anchor = /(?:collection\(\s*(?:db|adminDb|firestore)\s*,\s*|\.collection\(\s*)['"`]([A-Za-z0-9_]+)['"`]/g;

  let m;
  while ((m = anchor.exec(src)) !== null) {
    const collectionGroup = m[1];
    const window = src.slice(m.index, m.index + 700);

    // Stop at the end of the statement so we don't bleed into the next query.
    const end = window.search(/;\s*\n|\n\s*\n/);
    const scope = end === -1 ? window : window.slice(0, end);

    const equality = [];
    const inequality = [];
    const whereRe = /where\(\s*['"`]([A-Za-z0-9_.]+)['"`]\s*,\s*['"`]([^'"`]+)['"`]/g;
    let w;
    while ((w = whereRe.exec(scope)) !== null) {
      (w[2] === '==' ? equality : inequality).push(w[1]);
    }

    const seenOrder = new Set();
    const orderBys = [];
    const orderRe = /orderBy\(\s*['"`]([A-Za-z0-9_.]+)['"`]\s*(?:,\s*['"`](asc|desc)['"`])?/g;
    let o;
    while ((o = orderRe.exec(scope)) !== null) {
      const key = `${o[1]}:${(o[2] || 'asc').toLowerCase()}`;
      if (seenOrder.has(key)) continue; // window can re-match the same clause
      seenOrder.add(key);
      orderBys.push({ field: o[1], dir: (o[2] || 'asc').toLowerCase() });
    }

    if (!orderBys.length && equality.length + inequality.length < 2) continue;

    shapes.push({
      file,
      line: lineAt(src, m.index),
      collectionGroup,
      equality: [...new Set(equality)],
      inequality: [...new Set(inequality)],
      orderBys,
    });
  }
  return shapes;
}

/**
 * Does this shape require a composite index?
 *
 * Firestore serves these from automatic single-field indexes, so they do NOT
 * need one:
 *   - any number of equality filters with no orderBy (zigzag merge join)
 *   - a range filter plus an orderBy on that same field
 *   - a lone orderBy
 *
 * A composite index IS required when the query sorts by one field while
 * filtering on another, sorts by more than one field, or - with no orderBy at
 * all - pairs a range filter with an equality filter on a different field.
 */
function needsComposite(shape) {
  const { equality, inequality, orderBys } = shape;
  const ineqFields = new Set(inequality);

  if (orderBys.length === 0) {
    // Equality-only is served by the zigzag merge join, and a lone range filter
    // by that field's own single-field index.
    if (ineqFields.size === 0) return false;
    // Range filters spanning two different fields always need a composite index.
    if (ineqFields.size > 1) return true;
    // ONE range filter alongside an equality filter needs one too. This arm was
    // missing, and it is the exact shape of the leaderboard's "what is my rank"
    // count - role == x, stageId == y, streakCount > n - which failed in
    // production with FAILED_PRECONDITION while this checker reported no drift.
    return equality.some((f) => !ineqFields.has(f));
  }
  if (orderBys.length > 1) return true;

  const sortField = orderBys[0].field;
  return [...new Set([...equality, ...inequality])].some((f) => f !== sortField);
}

/** Is the shape covered by a declared index? */
function isCovered(shape, indexes) {
  const required = new Set([
    ...shape.equality,
    ...shape.inequality,
    ...shape.orderBys.map((o) => o.field),
  ]);

  return indexes.some((idx) => {
    if (idx.collectionGroup !== shape.collectionGroup) return false;
    const declared = idx.fields.map((f) => f.fieldPath);
    // Every field the query constrains must appear in the index.
    for (const f of required) if (!declared.includes(f)) return false;
    // The final orderBy must be the trailing index field, in the same direction.
    const last = shape.orderBys[shape.orderBys.length - 1];
    if (!last) return true;
    const tail = idx.fields[idx.fields.length - 1];
    if (tail.fieldPath !== last.field) return false;
    if (!tail.order) return true;
    return tail.order.toLowerCase().startsWith(last.dir === 'desc' ? 'desc' : 'asc');
  });
}

const indexFile = JSON.parse(readFileSync(join(ROOT, 'firestore.indexes.json'), 'utf8'));
const indexes = indexFile.indexes || [];

const files = SCAN_TARGETS.flatMap(collect);
const shapes = files.flatMap((f) => extractShapes(readFileSync(f, 'utf8'), relative(ROOT, f).replace(/\\/g, '/')));

const composite = shapes.filter(needsComposite);
const missing = composite.filter((s) => !isCovered(s, indexes));

const fmt = (s) =>
  `${s.collectionGroup}: ` +
  [
    ...s.equality.map((f) => `where(${f} ==)`),
    ...s.inequality.map((f) => `where(${f} range)`),
    ...s.orderBys.map((o) => `orderBy(${o.field} ${o.dir})`),
  ].join(' + ');

console.log('Firestore index drift check');
console.log(`  files scanned      ${files.length}`);
console.log(`  query shapes found ${shapes.length}`);
console.log(`  need composite     ${composite.length}`);
console.log(`  declared indexes   ${indexes.length}`);
console.log('');

if (VERBOSE) {
  for (const s of composite) {
    console.log(`  ${isCovered(s, indexes) ? 'ok     ' : 'MISSING'} ${s.file}:${s.line}  ${fmt(s)}`);
  }
  console.log('');
}

if (!missing.length) {
  console.log('No missing composite indexes detected.');
  process.exit(0);
}

console.log(`${missing.length} query shape(s) may lack a composite index:\n`);
for (const s of missing) {
  console.log(`  ${s.file}:${s.line}`);
  console.log(`    ${fmt(s)}`);
  console.log(
    `    suggested: { collectionGroup: "${s.collectionGroup}", queryScope: "COLLECTION", fields: [` +
      [...s.equality, ...s.inequality]
        .map((f) => `{ fieldPath: "${f}", order: "ASCENDING" }`)
        .concat(
          s.orderBys.map(
            (o) => `{ fieldPath: "${o.field}", order: "${o.dir === 'desc' ? 'DESCENDING' : 'ASCENDING'}" }`,
          ),
        )
        .join(', ') +
      '] }',
  );
  console.log('');
}

console.log('Verify each against the real query before adding an index — this check is');
console.log('regex-based and cannot see dynamically composed queries.');

process.exit(STRICT ? 1 : 0);
