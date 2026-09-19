#!/usr/bin/env node
/**
 * Security-rules deployment drift check.
 *
 * `npm run test:rules` runs the emulator against the LOCAL firestore.rules and
 * proves nothing whatsoever about what is live. The two drifted far enough apart
 * that production was missing the support role, the narrowed settings write, the
 * subscription-ledger tightening, storage's payment_receipts block - and the
 * timetable collections, whose absence denied every client read while the Admin
 * SDK went on writing them happily. Data present in the console, invisible in
 * the app, surviving a refresh: it reads as a client bug and it is not one.
 *
 * Firestore denies a path with NO matching rule, so the dangerous drift is not a
 * changed condition but a MISSING `match` block. This reports those first.
 *
 * Reads the deployed rulesets through the Firebase Rules REST API using the same
 * FIREBASE_* service-account credentials every other script here uses.
 *
 *   node scripts/checkRulesDeployed.mjs [--verbose]
 *
 * Exits 1 on drift, on missing credentials, or if the API cannot be reached -
 * a check that passes when it could not actually check is worse than no check.
 */

import { readFileSync } from 'node:fs';
import { GoogleAuth } from 'google-auth-library';
import 'dotenv/config';

const VERBOSE = process.argv.includes('--verbose');

const TARGETS = [
  { label: 'firestore', releasePrefix: 'cloud.firestore', file: 'firestore.rules' },
  { label: 'storage', releasePrefix: 'firebase.storage', file: 'storage.rules' },
];

const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
  console.error('Missing FIREBASE_* credentials in the environment.');
  console.error('This check talks to the live project; it cannot run without them.');
  process.exit(1);
}

const auth = new GoogleAuth({
  credentials: {
    client_email: FIREBASE_CLIENT_EMAIL,
    // Same normalisation as every other script here. A key pasted into a
    // hosting panel arrives with literal backslash-n rather than newlines.
    private_key: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/firebase.readonly'],
});

const client = await auth.getClient();

async function api(path) {
  const url = `https://firebaserules.googleapis.com/v1/${path}`;
  const res = await client.request({ url });
  return res.data;
}

/**
 * Compare ignoring only what cannot matter: line endings, trailing whitespace
 * and trailing blank lines. Comments are deliberately NOT stripped - they carry
 * the reasoning in this repo, and a deployed ruleset whose comments have drifted
 * is still a ruleset nobody has redeployed.
 */
const normalize = (text) =>
  String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');

/** Every `match /collection` path a ruleset declares. */
const matchBlocks = (text) => {
  const found = new Set();
  const re = /match\s+(\/[A-Za-z0-9_{}$()=*.\-/]+)/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[1].startsWith('/databases') || m[1].startsWith('/b/')) continue;
    found.add(m[1]);
  }
  return found;
};

let drifted = 0;

for (const target of TARGETS) {
  const local = normalize(readFileSync(target.file, 'utf8'));

  let releases;
  try {
    releases = await api(`projects/${FIREBASE_PROJECT_ID}/releases`);
  } catch (err) {
    console.error(`  FAIL  ${target.label}: could not list releases -> ${err?.message || err}`);
    process.exit(1);
  }

  const release = (releases.releases || []).find((r) =>
    String(r.name || '').split('/releases/')[1]?.startsWith(target.releasePrefix),
  );
  if (!release) {
    console.error(`  FAIL  ${target.label}: no deployed release found for ${target.releasePrefix}`);
    console.error('        Nothing has ever been deployed for this service.');
    drifted++;
    continue;
  }

  let ruleset;
  try {
    ruleset = await api(release.rulesetName);
  } catch (err) {
    console.error(`  FAIL  ${target.label}: could not read ruleset -> ${err?.message || err}`);
    process.exit(1);
  }

  const files = ruleset?.source?.files || [];
  const deployed = normalize(files.map((f) => f.content).join('\n'));

  if (deployed === local) {
    console.log(`  PASS  ${target.label}: deployed ruleset matches ${target.file}`);
    if (VERBOSE) console.log(`        released ${release.updateTime || release.createTime}`);
    continue;
  }

  drifted++;
  console.log(`  FAIL  ${target.label}: ${target.file} differs from what is deployed`);
  console.log(`        deployed ${deployed.split('\n').length} lines, local ${local.split('\n').length}`);
  if (release.updateTime || release.createTime) {
    console.log(`        last released ${release.updateTime || release.createTime}`);
  }

  // The failure mode that actually bites: a collection with no rule at all is
  // DENIED, and the Admin SDK still writes it, so the app looks broken client-side.
  const localMatches = matchBlocks(local);
  const deployedMatches = matchBlocks(deployed);
  const missing = [...localMatches].filter((p) => !deployedMatches.has(p));
  const extra = [...deployedMatches].filter((p) => !localMatches.has(p));

  if (missing.length) {
    console.log('');
    console.log('        NOT DEPLOYED - every client read of these is denied by default:');
    missing.forEach((p) => console.log(`          ${p}`));
  }
  if (extra.length) {
    console.log('');
    console.log('        Deployed but no longer in the repo:');
    extra.forEach((p) => console.log(`          ${p}`));
  }

  if (!missing.length && !extra.length) {
    const d = deployed.split('\n');
    const l = local.split('\n');
    const at = d.findIndex((line, i) => line !== l[i]);
    console.log('');
    console.log('        Same collections, changed conditions. First difference:');
    console.log(`          line ${at + 1}`);
    console.log(`          deployed: ${(d[at] ?? '<end of file>').trim().slice(0, 100)}`);
    console.log(`          local:    ${(l[at] ?? '<end of file>').trim().slice(0, 100)}`);
  }
  console.log('');
}

console.log('');
if (drifted) {
  console.log(`${drifted} ruleset(s) out of date. Deploy with:`);
  console.log('  npx -y firebase-tools@13 deploy --only firestore:rules,storage \\');
  console.log(`    --project ${FIREBASE_PROJECT_ID}`);
  process.exit(1);
}

console.log('Deployed rules match the repo.');
process.exit(0);
