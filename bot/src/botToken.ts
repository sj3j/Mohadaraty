import { unquote } from './privateKey.ts';

/**
 * Validates the Bot API token, and names what is wrong when it is not one.
 *
 * Telegram answers a malformed token with 404 Not Found and a well-formed but
 * unaccepted one with 401 Unauthorized, and those mean opposite things: 404 is
 * "the panel field damaged the value", 401 is "this token was revoked". Neither
 * status says that, so both used to arrive as a bare number in the log.
 *
 * Checking the shape locally means the 404 case never reaches Telegram at all
 * - it fails at boot, by name, against the variable that is actually wrong.
 */

export class BotTokenFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BotTokenFormatError';
  }
}

/** `<bot id>:<secret>` - the id is 5+ digits, the secret 30+ URL-safe chars. */
const TOKEN_RE = /^(\d{5,}):([A-Za-z0-9_-]{30,})$/;

export interface BotToken {
  token: string;
  /** The digits before the colon. This is the bot's public user id, not a secret. */
  botId: string;
  /** Safe to log: proves WHICH token is loaded without revealing it. */
  fingerprint: string;
}

export function parseBotToken(raw: string): BotToken {
  // Panels store a wrapping quote as part of the value, the same way they do
  // for the service account - and a quote inside the URL path is what turns a
  // perfectly good token into a 404.
  const token = unquote(raw).trim();

  if (!token) {
    throw new BotTokenFormatError('TELEGRAM_BOT_TOKEN is empty.');
  }

  const match = TOKEN_RE.exec(token);
  if (match) {
    const [, botId, secret] = match;
    return { token, botId, fingerprint: `${botId}:...${secret.slice(-4)}` };
  }

  throw new BotTokenFormatError(`TELEGRAM_BOT_TOKEN ${diagnose(token)}`);
}

function diagnose(token: string): string {
  if (/\s/.test(token)) {
    return 'contains a space or line break. It was pasted together with ' +
      'something else, or the field wrapped it.';
  }
  if (/^https?:|t\.me/i.test(token)) {
    return 'looks like a link to the bot, not its token. The token comes from ' +
      '@BotFather -> /mybots -> your bot -> API Token.';
  }
  if (/^bot\d/i.test(token)) {
    return 'starts with "bot". That prefix belongs in the API URL, not in the ' +
      'token - drop it.';
  }
  if (!token.includes(':')) {
    return 'has no colon in it. A token looks like 1234567890:AAE... - this ' +
      "may be the bot's username or its numeric id instead.";
  }

  const [id, ...rest] = token.split(':');
  const secret = rest.join(':');

  if (!/^\d+$/.test(id)) {
    return `has "${id.slice(0, 12)}" before the colon, which is not a bot id. ` +
      'The part before the colon is all digits.';
  }
  if (secret.length < 30) {
    return `has only ${secret.length} characters after the colon, so it was ` +
      'truncated - the panel field may cap the length.';
  }
  return 'has characters after the colon that a token cannot contain (a token ' +
    'is letters, digits, - and _ only). Check for a stray quote or a copied ' +
    'trailing character.';
}

/**
 * What to do about a 401, which is the one Telegram error the log cannot
 * explain by itself.
 *
 * The two descriptions mean different things and Telegram does not say so:
 * "invalid token specified" is a shape it could not route, while a BARE
 * "Unauthorized" is a real token that has been revoked - almost always because
 * someone pressed "Revoke current token" in BotFather, or regenerated it.
 */
export function explainUnauthorized(description: string, fingerprint: string): string {
  const bare = !/invalid token/i.test(description);
  if (bare) {
    return `Telegram accepted the shape of this token (${fingerprint}) and ` +
      'refused it, which means it has been REVOKED or regenerated. Open ' +
      '@BotFather -> /mybots -> your bot -> API Token -> and copy the current ' +
      'one into TELEGRAM_BOT_TOKEN. Nothing else in the bot can fix this.';
  }
  return `Telegram could not read this token (${fingerprint}) as a token at ` +
    'all. Re-copy it from @BotFather, whole, with nothing around it.';
}
