/**
 * Normalises a service-account private key out of an environment variable.
 *
 * This exists because `FIREBASE_PRIVATE_KEY` is the single most reliably
 * mangled value in the whole deployment, and every mangling produces the same
 * opaque failure: `error:1E08010C:DECODER routines::unsupported`. That message
 * says nothing about which of the following happened.
 *
 *   1. Literal `\n` escapes (the documented form)          -> the normal case
 *   2. DOUBLE-escaped `\\n`, which is what a panel that stores JSON, or a shell
 *      that already expanded once, hands over. The naive `.replace(/\\n/g,'\n')`
 *      eats the SECOND backslash and leaves the first, so every line begins
 *      with a stray `\` - structurally PEM-shaped, and undecodable.
 *   3. Surrounding quotes, because most panel fields store them verbatim rather
 *      than treating them as shell syntax.
 *   4. Real newlines already, from a multi-line paste.
 *   5. NO separators at all - spaces, or nothing - because something collapsed
 *      the whitespace in transit.
 *
 * Case 5 is recoverable and worth recovering: PEM is fully determined by its
 * structure, so given the header, the footer and the base64 between them, the
 * line breaks can simply be rebuilt. Refusing to would be pedantry.
 */

const PEM_LINE_LENGTH = 64;

export class PrivateKeyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrivateKeyFormatError';
  }
}

/**
 * Strips quote characters a panel stored as part of the value.
 *
 * Exported because FIREBASE_SERVICE_ACCOUNT reaches the process through the
 * same fields and picks up the same wrapping - a quoted JSON blob fails
 * JSON.parse for a reason that has nothing to do with the JSON.
 */
export function unquote(value: string): string {
  let out = value.trim();
  // Looped: a value can arrive wrapped twice, e.g. "'...'".
  while (out.length >= 2) {
    const first = out[0];
    const last = out[out.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      out = out.slice(1, -1).trim();
    } else break;
  }
  return out;
}

/**
 * Turns every escape spelling of a newline into a real one.
 *
 * `\\+n` rather than `\\n` is the whole point: it consumes a RUN of
 * backslashes, so `\n`, `\\n` and `\\\\n` all collapse to one newline instead
 * of leaving the leftovers that break the decoder.
 */
function unescape(value: string): string {
  return value
    .replace(/\\+r\\+n/g, '\n')
    .replace(/\\+n/g, '\n')
    .replace(/\\+r/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

/**
 * Rebuilds a canonical PEM from whatever survived.
 *
 * Throws with a specific, actionable message rather than letting OpenSSL
 * produce its famously unhelpful one.
 */
export function normalizePrivateKey(raw: string): string {
  const cleaned = unescape(unquote(raw));

  const match = cleaned.match(
    /-----BEGIN ([A-Z][A-Z ]*)-----([\s\S]*?)-----END ([A-Z][A-Z ]*)-----/,
  );

  if (!match) {
    throw new PrivateKeyFormatError(
      'FIREBASE_PRIVATE_KEY does not contain a "-----BEGIN ... PRIVATE KEY-----" header ' +
      'and matching footer. Copy the private_key field out of the service-account JSON ' +
      'exactly, including both marker lines.',
    );
  }

  const [, beginLabel, body, endLabel] = match;

  if (beginLabel.trim() !== endLabel.trim()) {
    throw new PrivateKeyFormatError(
      `FIREBASE_PRIVATE_KEY opens with "${beginLabel.trim()}" but closes with ` +
      `"${endLabel.trim()}". The value is truncated or two keys were pasted together.`,
    );
  }

  // Everything that is not base64 goes: spaces, newlines, tabs, and any
  // backslash debris an earlier unescape could not attribute.
  const base64 = body.replace(/[^A-Za-z0-9+/=]/g, '');

  if (base64.length < 100) {
    throw new PrivateKeyFormatError(
      `FIREBASE_PRIVATE_KEY has only ${base64.length} base64 characters between its ` +
      'markers, which is far too short for a real key. It was probably truncated by ' +
      'the field it was pasted into.',
    );
  }

  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += PEM_LINE_LENGTH) {
    lines.push(base64.slice(i, i + PEM_LINE_LENGTH));
  }

  const label = beginLabel.trim();
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/** A fingerprint safe to log: proves which key is loaded without revealing it. */
export function describePrivateKey(pem: string): string {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  return `${body.length} base64 chars, ending ...${body.slice(-6)}`;
}
