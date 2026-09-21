/**
 * Verifies the service-account blob decoder.
 *
 * Run with:  npm --prefix bot run test
 *
 * Every case below is a shape a hosting panel has produced or plausibly can,
 * and the point of pinning them is that JSON.parse reports ALL of them as
 * `Expected property name or '}' in JSON at position 1`. That message names
 * nothing, and acting on it means re-pasting a value that may already be
 * correct - which is exactly the loop the mirror was stuck in on Wispbyte.
 *
 * The assertion that matters most is not "it parsed". It is that the private
 * key comes out byte-for-byte identical after every repair: a decoder that
 * recovers the JSON but mangles the PEM inside it has moved the failure to
 * OpenSSL, where the message is even worse.
 */
import {
  decodeServiceAccount,
  describeBlob,
  ServiceAccountFormatError,
} from '../src/serviceAccount.ts';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); failed++; }
};

// The same fixture shape as privateKey.test.ts: long enough to be realistic,
// not a key.
const BODY_LINES = [
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDHl1yZ3PqRstMY',
  'b2hVQ0tGbGFnc2FyZW5vdHJlYWxqdXN0bG9uZ2Jhc2U2NGZvcnRlc3RpbmdwdXJw',
  'b3Nlc29ubHlhbmR0aGlzaXNub3RhcHJpdmF0ZWtleWF0YWxsaXRpc3BhZGRpbmc5',
  'OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5',
  'OTk5OTk5OTk=',
];
const PEM = `-----BEGIN PRIVATE KEY-----\n${BODY_LINES.join('\n')}\n-----END PRIVATE KEY-----\n`;

const BLOB = {
  project_id: 'mylectures-app',
  client_email: 'mirror@mylectures-app.iam.gserviceaccount.com',
  private_key: PEM,
};

/** What makeServiceAccountBlob.ts writes and DEPLOY.txt tells you to paste. */
const HEALTHY = JSON.stringify(BLOB);

/** Asserts a candidate decodes to the same three fields, key intact. */
const decodesTo = (name: string, raw: string, expectedRepair: string) => {
  let result;
  try {
    result = decodeServiceAccount(raw);
  } catch (error) {
    check(name, false, error instanceof Error ? error.message.split('\n')[0] : String(error));
    return;
  }
  const { fields, repairedBy } = result;
  check(
    name,
    fields.project_id === BLOB.project_id &&
    fields.client_email === BLOB.client_email &&
    fields.private_key === PEM &&
    repairedBy === expectedRepair,
    `repairedBy=${repairedBy} (wanted ${expectedRepair}), key intact=${fields.private_key === PEM}`,
  );
};

console.log('\nA clean blob is passed through unchanged');

decodesTo('the one-line blob makeServiceAccountBlob.ts writes', HEALTHY, 'none');
decodesTo('a pretty-printed blob with real newlines', JSON.stringify(BLOB, null, 2), 'none');
decodesTo('surrounding whitespace', `\n  ${HEALTHY}\n `, 'none');

console.log('\nEvery "position 1" mangling that is recoverable, is recovered');

// THE WISPBYTE CASE: the panel handed back an encoded copy of the value.
decodesTo('double-encoded (JSON.stringify applied twice)', JSON.stringify(HEALTHY), 'double-encoded');
decodesTo('triple-encoded, for good measure', JSON.stringify(JSON.stringify(HEALTHY)), 'double-encoded');

// Quotes the panel stored as part of the value rather than as shell syntax.
decodesTo('wrapped in single quotes', `'${HEALTHY}'`, 'unquoted');
decodesTo('wrapped twice, which unquote() loops for', `''${HEALTHY}''`, 'unquoted');

// An escaped copy whose outer quotes the field dropped: `{\"project_id\":...`
// This is the shape that `unquote`-then-parse can never recover, because
// stripping the quotes off a JSON string literal is not the same as parsing it.
const escapedNoQuotes = JSON.stringify(HEALTHY).slice(1, -1);
decodesTo('escaped copy with the outer quotes dropped', escapedNoQuotes, 'escaped');

decodesTo('smart quotes throughout', HEALTHY.replace(/"/g, '“'), 'smart-quotes');

console.log('\nBase64 - the form a text field cannot damage');

const b64 = Buffer.from(HEALTHY, 'utf8').toString('base64');
decodesTo('standard base64', b64, 'base64');
decodesTo('base64 with the whitespace a wrapped paste adds', b64.replace(/(.{40})/g, '$1\n'), 'base64');
decodesTo(
  'base64url (- and _ instead of + and /)',
  b64.replace(/\+/g, '-').replace(/\//g, '_'),
  'base64',
);
decodesTo('base64 of an already double-encoded blob', Buffer.from(JSON.stringify(HEALTHY)).toString('base64'), 'base64');

console.log('\nWhat cannot be repaired is NAMED, not reported as "position 1"');

const failsWith = (name: string, raw: string, needle: string) => {
  try {
    decodeServiceAccount(raw);
    check(name, false, 'decoded when it should have thrown');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(
      name,
      error instanceof ServiceAccountFormatError && message.includes(needle),
      message.split('\n')[0],
    );
  }
};

failsWith('truncated to a single brace', '{', 'truncated');
failsWith('truncated by a 255-character field cap', HEALTHY.slice(0, 255), 'does not close');
failsWith('a file path instead of the contents', '/home/container/serviceAccountKey.json', 'U+002F');
failsWith('a stray character at the front', `garbage ${HEALTHY}`, 'U+0067');
// Unparseable AND not a service account: the message should lead with the
// wrong-file problem, since re-pasting it more carefully cannot help.
failsWith(
  'an unparseable config that is not a service account',
  `{apiKey:"${'AIza'.padEnd(220, 'x')}",projectId:"mylectures-app"}`,
  'no private_key field',
);
failsWith(
  'single-quoted keys, retyped rather than copied',
  HEALTHY.replace(/"/g, "'"),
  'single quotes',
);

console.log('\nThe error message shows the shape and not the key');

const sketch = describeBlob(HEALTHY);
check('names the field that identifies the file', sketch.includes('project_id'));
check('does not contain the key body', !sketch.includes(BODY_LINES[1]));
check(
  'contains no long base64 run at all',
  !/[A-Za-z0-9+/=]{20,}/.test(sketch),
  sketch.slice(0, 80),
);
check('is capped in length', describeBlob(HEALTHY.repeat(5)).length <= 201);

console.log('\nA valid JSON file of the wrong kind is not the decoder\'s problem');
// An API-key file parses perfectly well - it is simply missing the fields.
// env.ts owns that message ("that is the shape of an API-key file"), so the
// decoder hands the object back rather than second-guessing it here.
check(
  'an object with no credentials decodes rather than throwing',
  Object.keys(decodeServiceAccount(JSON.stringify({ apiKey: 'AIza', projectId: 'x' })).fields).length === 2,
);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
