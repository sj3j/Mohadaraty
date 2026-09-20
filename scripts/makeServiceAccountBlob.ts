/**
 * Rebuilds a service-account JSON blob from the three FIREBASE_* variables
 * already in .env, for pasting into a hosting panel's FIREBASE_SERVICE_ACCOUNT
 * field.
 *
 * Run with:  npx tsx scripts/makeServiceAccountBlob.ts
 * Writes:    serviceAccountKey.json  (gitignored AND dockerignored)
 *
 * WHY THIS EXISTS
 *
 * A PEM pasted into a single-line panel field comes back double-escaped,
 * quoted or whitespace-collapsed, and every one of those failures surfaces as
 * the same useless `error:1E08010C:DECODER routines::unsupported`. Inside a
 * JSON blob the key is a JSON *string*, so its newlines survive via JSON.parse
 * by spec - there is no hand-rolled unescaping anywhere in the path for a text
 * field to break.
 *
 * This generates nothing new and rotates nothing. It is a reformat of
 * credentials that are already on this machine, so the existing key keeps
 * working everywhere else it is used.
 *
 * It prints a FINGERPRINT, never the key. The value is only ever written to the
 * file - a terminal transcript is not a place for a private key.
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { normalizePrivateKey, describePrivateKey } from '../bot/src/privateKey.ts';

const OUT = 'serviceAccountKey.json';

const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
const rawKey = process.env.FIREBASE_PRIVATE_KEY;

const missing = [
  !projectId && 'FIREBASE_PROJECT_ID',
  !clientEmail && 'FIREBASE_CLIENT_EMAIL',
  !rawKey && 'FIREBASE_PRIVATE_KEY',
].filter(Boolean);

if (missing.length) {
  console.error(`Missing from .env: ${missing.join(', ')}`);
  process.exit(1);
}

let privateKey: string;
try {
  // Repaired with the same normaliser the bot uses, so what lands in the file
  // is canonical regardless of how .env happens to have stored it.
  privateKey = normalizePrivateKey(rawKey!);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

// Only the three fields bot/src/env.ts reads. A downloaded key file carries
// more (type, private_key_id, client_id, the auth URIs), but firebase-admin's
// cert() needs exactly these, so a minimal blob is a complete one here.
const blob = { project_id: projectId, client_email: clientEmail, private_key: privateKey };

// One line: the panel field is single-line, and a pretty-printed blob pasted
// into one arrives with its newlines eaten.
writeFileSync(OUT, JSON.stringify(blob), { encoding: 'utf8' });

console.log(`Wrote ${OUT}`);
console.log(`  project:     ${projectId}`);
console.log(`  client:      ${clientEmail}`);
console.log(`  private key: ${describePrivateKey(privateKey)}`);
console.log(`  blob length: ${JSON.stringify(blob).length} characters, on one line`);
console.log('');
console.log('Open it, copy the WHOLE line into the panel\'s FIREBASE_SERVICE_ACCOUNT');
console.log('field, then delete the file. It is gitignored and dockerignored, but');
console.log('it is still a private key sitting in your working tree.');
