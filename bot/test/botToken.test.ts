/**
 * Verifies the bot-token shape check and the 401 explainer.
 *
 * Run with:  npm --prefix bot run test
 *
 * Telegram answers a MALFORMED token with 404 Not Found and a well-formed but
 * REVOKED one with 401 Unauthorized. Those are opposite problems - one is the
 * panel field damaging the value, the other is a token that needs regenerating
 * in BotFather - and neither status says which. The shape check below means the
 * 404 case never leaves the container, and the explainer turns the 401 into the
 * three clicks that fix it.
 */
import { parseBotToken, BotTokenFormatError, explainUnauthorized } from '../src/botToken.ts';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); failed++; }
};

// Shaped like a real token; not one.
const ID = '7412398765';
const SECRET = 'AAHk3Lq9vZ2xWn4pT8sRdF6gYbNmQjXcVuE';
const TOKEN = `${ID}:${SECRET}`;

console.log('\nA well-formed token is accepted and fingerprinted');

const parsed = parseBotToken(TOKEN);
check('the token survives verbatim', parsed.token === TOKEN);
check('the bot id is split out', parsed.botId === ID);
check('the fingerprint names the bot', parsed.fingerprint.startsWith(ID));
check('the fingerprint ends in the last four characters',
  parsed.fingerprint.endsWith(SECRET.slice(-4)), parsed.fingerprint);
check('the fingerprint does NOT contain the secret',
  !parsed.fingerprint.includes(SECRET.slice(0, 20)), parsed.fingerprint);

console.log('\nWhat a panel field does to it is repaired or named');

check('surrounding double quotes are stripped', parseBotToken(`"${TOKEN}"`).token === TOKEN);
check('surrounding single quotes are stripped', parseBotToken(`'${TOKEN}'`).token === TOKEN);
check('surrounding whitespace is stripped', parseBotToken(`  ${TOKEN}\n`).token === TOKEN);

const failsWith = (name: string, raw: string, needle: string) => {
  try {
    parseBotToken(raw);
    check(name, false, 'accepted when it should have been rejected');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, error instanceof BotTokenFormatError && message.includes(needle), message);
  }
};

failsWith('empty', '', 'is empty');
failsWith('an internal space', `${ID}: ${SECRET}`, 'space or line break');
failsWith('the bot link instead of the token', `https://t.me/mylecturebot`, 'link to the bot');
failsWith('a "bot" prefix left on', `bot${TOKEN}`, 'starts with "bot"');
failsWith('the username instead', 'mylecture_mirror_bot', 'no colon');
failsWith('the numeric id alone', ID, 'no colon');
failsWith('a non-numeric id', `mybot:${SECRET}`, 'not a bot id');
failsWith('truncated after the colon', `${ID}:AAHk3Lq9`, 'truncated');
failsWith('an illegal character in the secret', `${ID}:${SECRET.slice(0, -1)}!`, 'cannot contain');

console.log('\nThe 401 explainer distinguishes revoked from malformed');

const revoked = explainUnauthorized('Unauthorized', parsed.fingerprint);
check('a bare Unauthorized reads as REVOKED', revoked.includes('REVOKED'), revoked);
check('and points at BotFather', revoked.includes('@BotFather'), revoked);
check('and says the bot cannot fix it itself',
  revoked.includes('Nothing else in the bot can fix this'), revoked);

const malformed = explainUnauthorized('Unauthorized: invalid token specified', parsed.fingerprint);
check('an invalid-token description does NOT claim revocation',
  !malformed.includes('REVOKED'), malformed);
check('and says to re-copy it', malformed.includes('Re-copy'), malformed);
check('both name the token that was tried',
  [revoked, malformed].every(m => m.includes(parsed.fingerprint)));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
