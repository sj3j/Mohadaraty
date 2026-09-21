/**
 * Verifies the network-failure classifier.
 *
 * Run with:  npm --prefix bot run test
 *
 * The shapes below are what undici actually throws, and the reason they are
 * pinned is the boot crash they caused: `TypeError: fetch failed` reached the
 * log with its `.cause` dropped, so a container that could not resolve DNS
 * looked exactly like one whose host blocks Telegram, and neither looked like
 * something a retry would fix. The bot exited two seconds after start, which
 * is inside the window where the host refuses to restart it.
 *
 * The negative cases matter just as much: if a Telegram 401 were classified as
 * a network failure, boot would retry an invalid token forever and the
 * container would look healthy while doing nothing.
 */
import {
  causeChain, networkCause, isNetworkError, describeNetworkFailure,
} from '../src/net.ts';
import { TelegramApiError } from '../src/telegram/types.ts';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { console.log(`  PASS  ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); failed++; }
};

/** Builds the exact shape undici produces: a bare wrapper over a system error. */
function fetchFailed(code: string, extra: Record<string, unknown> = {}): TypeError {
  const cause = Object.assign(new Error(`${extra.syscall ?? 'connect'} ${code} api.telegram.org`), { code, ...extra });
  return new TypeError('fetch failed', { cause });
}

const DNS = fetchFailed('ENOTFOUND', { syscall: 'getaddrinfo', hostname: 'api.telegram.org' });
const REFUSED = fetchFailed('ECONNREFUSED', { syscall: 'connect' });
const TIMEOUT = new TypeError('fetch failed', {
  cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
});

console.log('\nThe cause is found however deeply it is wrapped');

check('the wrapper itself is first in the chain', causeChain(DNS)[0] === DNS);
check('the system error is reached', networkCause(DNS)?.code === 'ENOTFOUND');
check('its syscall survives', networkCause(DNS)?.syscall === 'getaddrinfo');
check('its hostname survives', networkCause(DNS)?.hostname === 'api.telegram.org');
check('an undici code is reached', networkCause(TIMEOUT)?.code === 'UND_ERR_CONNECT_TIMEOUT');

// Two addresses, both failing, is what a dual-stack host produces.
const aggregate = new TypeError('fetch failed', {
  cause: new AggregateError(
    [Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
    'all attempts failed',
  ),
});
check('an AggregateError is descended into', networkCause(aggregate)?.code === 'ECONNREFUSED');

const deep = new Error('outer', { cause: new Error('middle', { cause: DNS }) });
check('a chain three deep still resolves', networkCause(deep)?.code === 'ENOTFOUND');
check('a cycle cannot hang the walk', (() => {
  const a = new Error('a');
  (a as Error & { cause?: unknown }).cause = a;
  return causeChain(a).length <= 7;
})());

console.log('\nNetwork failures are retryable; request failures are not');

check('DNS failure', isNetworkError(DNS));
check('connection refused', isNetworkError(REFUSED));
check('connect timeout', isNetworkError(TIMEOUT));
check('a bare wrapper with no code at all', isNetworkError(new TypeError('fetch failed')));
check('an aborted request (our own timeout)', isNetworkError(fetchFailed('ABORT_ERR')));

check('a Telegram 401 is NOT a network error',
  !isNetworkError(new TelegramApiError(401, 'Unauthorized: invalid token specified')));
check('a Telegram 429 is NOT a network error',
  !isNetworkError(new TelegramApiError(429, 'Too Many Requests', 30)));
check('a Telegram 500 is NOT a network error',
  !isNetworkError(new TelegramApiError(500, 'Internal Server Error')));
check('an ordinary bug is NOT a network error',
  !isNetworkError(new TypeError("Cannot read properties of undefined (reading 'id')")));
check('a plain string is NOT a network error', !isNetworkError('something went wrong'));

console.log('\nThe description names the remedy, not just the code');

const dns = describeNetworkFailure(DNS, 'api.telegram.org');
check('DNS failure points at DNS', dns.includes('resolve') && dns.includes('ENOTFOUND'), dns);
check('DNS failure says it will retry', dns.includes('Retrying'), dns);

const refused = describeNetworkFailure(REFUSED, 'api.telegram.org');
check('a refused connection points at the host blocking it',
  refused.includes('blocking') && refused.includes('ECONNREFUSED'), refused);

const timedOut = describeNetworkFailure(TIMEOUT, 'api.telegram.org');
check('a timeout says so', timedOut.includes('timed out'), timedOut);

const unknown = describeNetworkFailure(new TypeError('fetch failed'), 'api.telegram.org');
check('an unclassifiable failure still names the host',
  unknown.includes('api.telegram.org'), unknown);
check('every description names the host',
  [dns, refused, timedOut, unknown].every(d => d.includes('api.telegram.org')));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
