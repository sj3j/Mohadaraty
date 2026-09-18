/**
 * Verifies the service-account private-key normaliser.
 *
 * Run with:  npm --prefix bot run test
 *
 * Every case below is a real mangling that a hosting panel, a shell or a
 * copy-paste has been observed to produce, and all of them fail identically at
 * runtime with OpenSSL's `error:1E08010C:DECODER routines::unsupported` - a
 * message that names neither the cause nor the variable. That is precisely why
 * this logic is worth pinning: the failure it prevents is expensive to diagnose
 * and trivially easy to reintroduce.
 *
 * The double-backslash case is not hypothetical. It is what crashed the bot on
 * Wispbyte: `.replace(/\\n/g, '\n')` consumes one backslash out of two and
 * leaves the other at the head of every line.
 */
import { normalizePrivateKey, PrivateKeyFormatError, describePrivateKey, unquote } from '../src/privateKey.ts';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); failed++; }
};

// A plausible key body: 4 full 64-char lines plus a short final line.
const BODY_LINES = [
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDHl1yZ3PqRstMY',
  'b2hVQ0tGbGFnc2FyZW5vdHJlYWxqdXN0bG9uZ2Jhc2U2NGZvcnRlc3RpbmdwdXJw',
  'b3Nlc29ubHlhbmR0aGlzaXNub3RhcHJpdmF0ZWtleWF0YWxsaXRpc3BhZGRpbmc5',
  'OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5OTk5',
  'OTk5OTk5OTk=',
];
const BODY = BODY_LINES.join('');
const CANONICAL = `-----BEGIN PRIVATE KEY-----\n${BODY_LINES.join('\n')}\n-----END PRIVATE KEY-----\n`;

console.log('\nThe canonical form is a fixed point');

check('an already-correct PEM is returned unchanged',
  normalizePrivateKey(CANONICAL) === CANONICAL);
check('normalising twice changes nothing',
  normalizePrivateKey(normalizePrivateKey(CANONICAL)) === CANONICAL);

console.log('\nEscape spellings all collapse to real newlines');

const singleEscaped = `-----BEGIN PRIVATE KEY-----\\n${BODY_LINES.join('\\n')}\\n-----END PRIVATE KEY-----\\n`;
check('single-escaped \\n (the documented form)',
  normalizePrivateKey(singleEscaped) === CANONICAL);

// THE WISPBYTE CASE. Two literal backslashes before the n.
const doubleEscaped = `-----BEGIN PRIVATE KEY-----\\\\n${BODY_LINES.join('\\\\n')}\\\\n-----END PRIVATE KEY-----\\\\n`;
check('DOUBLE-escaped \\\\n - the case that crashed on Wispbyte',
  normalizePrivateKey(doubleEscaped) === CANONICAL,
  JSON.stringify(normalizePrivateKey(doubleEscaped).slice(0, 60)));

const quadEscaped = `-----BEGIN PRIVATE KEY-----\\\\\\\\n${BODY}\\\\\\\\n-----END PRIVATE KEY-----`;
check('quadruple-escaped, for good measure',
  normalizePrivateKey(quadEscaped) === CANONICAL);

check('escaped \\r\\n pairs',
  normalizePrivateKey(`-----BEGIN PRIVATE KEY-----\\r\\n${BODY}\\r\\n-----END PRIVATE KEY-----`) === CANONICAL);

check('real CRLF newlines',
  normalizePrivateKey(`-----BEGIN PRIVATE KEY-----\r\n${BODY_LINES.join('\r\n')}\r\n-----END PRIVATE KEY-----\r\n`) === CANONICAL);

console.log('\nQuotes a panel stored as part of the value');

check('double quotes are stripped',
  normalizePrivateKey(`"${singleEscaped}"`) === CANONICAL);
check('single quotes are stripped',
  normalizePrivateKey(`'${singleEscaped}'`) === CANONICAL);
check('both, nested',
  normalizePrivateKey(`"'${singleEscaped}'"`) === CANONICAL);
check('leading and trailing whitespace',
  normalizePrivateKey(`\n\t  ${singleEscaped}   \n`) === CANONICAL);

console.log('\nSeparators lost entirely are rebuilt');

check('no separators at all - line wrapping is reconstructed',
  normalizePrivateKey(`-----BEGIN PRIVATE KEY-----${BODY}-----END PRIVATE KEY-----`) === CANONICAL);
check('spaces instead of newlines',
  normalizePrivateKey(`-----BEGIN PRIVATE KEY----- ${BODY_LINES.join(' ')} -----END PRIVATE KEY-----`) === CANONICAL);

console.log('\nOther key labels keep their own label');

const rsa = `-----BEGIN RSA PRIVATE KEY-----\n${BODY_LINES.join('\n')}\n-----END RSA PRIVATE KEY-----\n`;
check('RSA PRIVATE KEY is preserved, not rewritten',
  normalizePrivateKey(rsa.replace(/\n/g, '\\n')) === rsa);

console.log('\nMalformed input fails with a NAMED error, not an OpenSSL decoder error');

const rejects = (label: string, input: string, expect: RegExp) => {
  try {
    normalizePrivateKey(input);
    check(label, false, 'did not throw');
  } catch (error) {
    const ok = error instanceof PrivateKeyFormatError && expect.test(error.message);
    check(label, ok, error instanceof Error ? error.message : String(error));
  }
};

rejects('empty string', '', /BEGIN/);
rejects('no markers at all', BODY, /BEGIN/);
rejects('header only, truncated', `-----BEGIN PRIVATE KEY-----${BODY}`, /BEGIN/);
rejects('header and footer disagree',
  `-----BEGIN PRIVATE KEY-----\n${BODY}\n-----END PUBLIC KEY-----`, /closes with/);
rejects('body far too short to be a key',
  '-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----', /too short|base64 characters/);

console.log('\nThe service-account blob survives the same wrapping');

// FIREBASE_SERVICE_ACCOUNT is the recommended shape precisely because its
// newlines are JSON escapes rather than something we unescape by hand - but
// it reaches the process through the same panel field, so it picks up the
// same wrapping quotes. Quoted, it fails JSON.parse on character one.
const BLOB = JSON.stringify({
  project_id: 'mylectures-app',
  client_email: 'bot@mylectures-app.iam.gserviceaccount.com',
  private_key: CANONICAL,
});
const parses = (raw: string) => {
  try { return JSON.parse(unquote(raw)).project_id === 'mylectures-app'; }
  catch { return false; }
};

check('a bare blob parses', parses(BLOB));
check('double-quoted by the panel', parses('"' + BLOB + '"'));
check('single-quoted by the panel', parses("'" + BLOB + "'"));
check('surrounding whitespace', parses('  ' + BLOB + '  '));
// The braces must NOT be mistaken for a wrapping to strip.
check('an unwrapped blob is left exactly alone', unquote(BLOB) === BLOB);
// The key inside it round-trips without the normaliser touching it.
check('the key inside a blob needs no repair',
  normalizePrivateKey(JSON.parse(BLOB).private_key) === CANONICAL);

console.log('\nThe log fingerprint reveals nothing sensitive');

const described = describePrivateKey(CANONICAL);
check('reports a length', /\d+ base64 chars/.test(described), described);
check('shows at most the last 6 characters',
  !described.includes(BODY.slice(0, 20)), described);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
