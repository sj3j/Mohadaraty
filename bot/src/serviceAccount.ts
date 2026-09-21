import { unquote } from './privateKey.ts';

/**
 * Recovers a service-account object from whatever a hosting panel stored.
 *
 * WHY THIS IS NOT JUST `JSON.parse`
 *
 * V8 reports the SAME message - `Expected property name or '}' in JSON at
 * position 1` - for at least six completely unrelated manglings:
 *
 *   {\"project_id\":...}   an escaped copy of the file (double-encoded)
 *   {'project_id':...}     single quotes
 *   {project_id:...}       unquoted keys
 *   {\n  "project_id"...   a literal backslash-n where a newline was
 *   {“project_id”...       smart quotes, from a paste through a chat app
 *   {                      truncated by a field with a length cap
 *
 * So "position 1" identifies nothing, and surfacing it as the diagnosis - which
 * is what crashed the mirror on Wispbyte - tells the operator to re-paste a
 * value that may already be correct. Every shape above except the last two is
 * mechanically recoverable, and the two that are not can at least be NAMED.
 *
 * The ladder below therefore tries each repair in turn and reports which one
 * worked, so the boot log says what arrived rather than only that it parsed.
 */

/** Thrown with a message that names the shape, never V8's offset alone. */
export class ServiceAccountFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceAccountFormatError';
  }
}

export type Repair =
  | 'none'
  | 'unquoted'
  | 'double-encoded'
  | 'escaped'
  | 'smart-quotes'
  | 'base64';

export interface DecodedServiceAccount {
  fields: Record<string, unknown>;
  /** Which rung produced it. `none` means the panel value was already clean. */
  repairedBy: Repair;
}

/** A real blob is ~1750 characters; anything this short lost most of itself. */
const PLAUSIBLE_MIN_LENGTH = 200;

/** Bounds rung 2. Two levels of encoding is a real accident; ten is a loop. */
const MAX_DEPTH = 3;

// Two spellings of the same class, deliberately. `.test()` on a /g regex is
// stateful - it advances lastIndex and returns false on every other call - so
// the detector must not carry the flag the replacer needs.
const SMART_QUOTE = /[“”‘’]/;
const SMART_QUOTE_G = /[“”‘’]/g;

function tryParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The ladder. Returns the first rung that yields an OBJECT.
 *
 * Order matters in one specific place: the raw value is parsed BEFORE any
 * quote-stripping. `unquote()` removes the quotes around a JSON string literal
 * instead of parsing them, so a double-encoded blob that JSON.parse would have
 * recovered in one step arrives at the parser as `{\"project_id\"...` and can
 * never succeed. Stripping first is what turned a recoverable value into a
 * fatal one.
 */
function climb(value: string, depth: number): { fields: Record<string, unknown>; repairedBy: Repair } | undefined {
  if (depth > MAX_DEPTH) return undefined;

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  // 1. Already valid.
  const direct = tryParse(trimmed);
  if (isObject(direct)) return { fields: direct, repairedBy: depth === 0 ? 'none' : 'double-encoded' };

  // 2. Valid JSON, but it decoded to a STRING: the blob was encoded twice.
  if (typeof direct === 'string') {
    const inner = climb(direct, depth + 1);
    if (inner) return { fields: inner.fields, repairedBy: 'double-encoded' };
  }

  // 3. Wrapping quotes the panel stored as part of the value.
  const unquoted = unquote(trimmed);
  if (unquoted !== trimmed) {
    const parsed = tryParse(unquoted);
    if (isObject(parsed)) return { fields: parsed, repairedBy: 'unquoted' };
  }

  // 4. An escaped copy whose outer quotes were dropped: `{\"project_id\":...`.
  //    Re-adding the quotes turns it back into a parseable string literal. Only
  //    attempted when no BARE quote is present, since one would end the literal
  //    early and parse a truncated prefix as if it were the whole value.
  for (const candidate of new Set([trimmed, unquoted])) {
    if (candidate.startsWith('{') && candidate.includes('\\"') && !/(^|[^\\])"/.test(candidate)) {
      const unescaped = tryParse(`"${candidate}"`);
      if (typeof unescaped === 'string') {
        const parsed = tryParse(unescaped);
        if (isObject(parsed)) return { fields: parsed, repairedBy: 'escaped' };
      }
    }
  }

  // 5. Smart quotes, from a value that travelled through a chat app or a word
  //    processor. Safe to rewrite: a service-account blob contains none of
  //    these characters legitimately.
  if (SMART_QUOTE.test(unquoted)) {
    const straightened = unquoted.replace(SMART_QUOTE_G, '"');
    const parsed = tryParse(straightened);
    if (isObject(parsed)) return { fields: parsed, repairedBy: 'smart-quotes' };
  }

  // 6. Base64 - the form this code now recommends, because it contains no
  //    quote, backslash, newline or smart quote for a field to damage.
  const compact = unquoted.replace(/\s+/g, '');
  if (compact.length > 100 && /^[A-Za-z0-9+/_=-]+$/.test(compact)) {
    const decoded = Buffer.from(compact.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const inner = climb(decoded, depth + 1);
    if (inner) return { fields: inner.fields, repairedBy: 'base64' };
  }

  return undefined;
}

/**
 * Renders the STRUCTURE of a blob for an error message, never its key.
 *
 * Every run of 20+ base64 characters becomes an ellipsis, which is exactly what
 * a PEM body is. What survives is the punctuation and the field names - enough
 * to see that the quotes are wrong or that the value stops halfway, and not
 * enough to be a credential. `project_id` and `client_email` are not secret.
 */
export function describeBlob(raw: string): string {
  const sketch = raw
    .replace(/[A-Za-z0-9+/=]{20,}/g, '…')
    .replace(/\s+/g, ' ')
    .trim();
  return sketch.length > 200 ? `${sketch.slice(0, 200)}…` : sketch;
}

/** Names the most likely cause when every rung of the ladder has failed. */
function diagnose(raw: string): string {
  const trimmed = raw.trim();

  // First, because it is the one check that distinguishes "you pasted the wrong
  // thing" from "the right thing arrived damaged", and a path or a stray prefix
  // would otherwise be reported as a truncation.
  if (!trimmed.startsWith('{')) {
    const first = trimmed[0];
    const code = first.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
    return (
      `it starts with ${JSON.stringify(first)} (U+${code}), not "{". Paste the ` +
      'contents of the .json file, not a path to it, and check for a stray ' +
      'character at the front.'
    );
  }

  if (trimmed.length < PLAUSIBLE_MIN_LENGTH) {
    return (
      `it is only ${trimmed.length} characters long, so it was truncated. A ` +
      'service-account blob is around 1750 - check whether the panel caps the ' +
      'length of a variable.'
    );
  }

  // Length alone does not catch a field that caps at 255 or 1024: the value is
  // long enough to look plausible and still stops mid-string. An opening brace
  // with no closing one is the signature, whatever the cap happens to be.
  if (!trimmed.endsWith('}')) {
    return (
      `it opens with "{" but does not close, stopping after ${trimmed.length} ` +
      'characters - the value was truncated by the field it was pasted into.'
    );
  }

  if (SMART_QUOTE.test(trimmed)) {
    return (
      'it contains typographic quote characters (“ ”). The value has been ' +
      'through something that autocorrects quotes - copy it from a plain-text ' +
      'editor instead.'
    );
  }

  if (trimmed.includes("'") && !trimmed.includes('"')) {
    return (
      'its quotes are single quotes. JSON requires double quotes - this looks ' +
      'like a value that was retyped rather than copied.'
    );
  }

  if (!trimmed.includes('private_key') && !trimmed.includes('privateKey')) {
    return (
      'it has no private_key field anywhere in it. That is the shape of an ' +
      'API-key file or a config snippet, not a service account - download the ' +
      'service-account key from the Firebase console instead.'
    );
  }

  return 'it is JSON-shaped but could not be parsed or repaired.';
}

/**
 * Decodes the blob, or throws with a message that says what is wrong with it.
 *
 * Returns the raw parsed fields rather than a typed credential: naming and
 * validating project_id / client_email / private_key belongs to env.ts, which
 * already has the message for a blob that parses but is the wrong kind of file.
 */
export function decodeServiceAccount(raw: string): DecodedServiceAccount {
  const climbed = climb(raw, 0);
  if (climbed) return { fields: climbed.fields, repairedBy: climbed.repairedBy };

  throw new ServiceAccountFormatError(
    `The service-account credentials could not be read: ${diagnose(raw)}\n` +
    `  what arrived (key redacted): ${describeBlob(raw)}\n` +
    '  The form that cannot be damaged by a panel field is base64: run\n' +
    '  `npx tsx scripts/makeServiceAccountBlob.ts` and paste the contents of\n' +
    '  serviceAccountKey.b64.txt into FIREBASE_SERVICE_ACCOUNT_B64.',
  );
}
