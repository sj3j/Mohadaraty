/**
 * Rebuilds a service-account JSON blob from the three FIREBASE_* variables
 * already in .env, for pasting into a hosting panel's FIREBASE_SERVICE_ACCOUNT
 * field.
 *
 * Run with:  npx tsx scripts/makeServiceAccountBlob.ts
 * Writes:    serviceAccountKey.json     the blob         (git+dockerignored)
 *            serviceAccountKey.b64.txt  the same, base64 (git+dockerignored)
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
 * WHY THERE IS ALSO A BASE64 COPY
 *
 * Because the blob was not enough. A panel handed one back escaped
 * (`{\"project_id\":...`) and the bot exited on every boot with JSON.parse's
 * `position 1` - a message V8 emits for six unrelated manglings, so it named
 * none of them. bot/src/serviceAccount.ts now repairs that shape, but repair is
 * the second-best answer: base64 contains no quote, backslash, newline or smart
 * quote, so there is nothing in it for a text field to damage in the first
 * place. Paste the .b64.txt into FIREBASE_SERVICE_ACCOUNT_B64 and the whole
 * class of failure is gone rather than handled.
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
const OUT_B64 = 'serviceAccountKey.b64.txt';

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
const json = JSON.stringify(blob);
const base64 = Buffer.from(json, 'utf8').toString('base64');

writeFileSync(OUT, json, { encoding: 'utf8' });
writeFileSync(OUT_B64, base64, { encoding: 'utf8' });

console.log(`Wrote ${OUT} and ${OUT_B64}`);
console.log(`  project:     ${projectId}`);
console.log(`  client:      ${clientEmail}`);
console.log(`  private key: ${describePrivateKey(privateKey)}`);
console.log(`  blob:        ${json.length} characters, on one line`);
console.log(`  base64:      ${base64.length} characters, on one line`);
console.log('');
console.log(`PREFER the base64: copy the WHOLE line of ${OUT_B64} into the panel's`);
console.log('FIREBASE_SERVICE_ACCOUNT_B64 field. It has no quote, backslash or newline');
console.log('in it, so there is nothing a single-line field can damage.');
console.log('');
console.log(`If the panel already holds a working ${OUT} blob in FIREBASE_SERVICE_ACCOUNT,`);
console.log('leave it - that still works. Set one or the other, not both: _B64 wins.');
console.log('');
console.log('Delete BOTH files afterwards. They are gitignored and dockerignored, but');
console.log('they are still a private key sitting in your working tree.');
