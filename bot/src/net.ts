/**
 * Classifies a failed fetch into something a log line can act on.
 *
 * `TypeError: fetch failed` is undici's wrapper and says nothing - it is the
 * network-layer equivalent of JSON.parse's "position 1". The real failure is
 * always in `.cause`, and sometimes one level further inside an AggregateError
 * when a host resolves to both an A and an AAAA record and both attempts fail.
 * A boot that dies with only the wrapper in the log cannot be told apart from
 * a blocked host, a missing DNS server or a transient blip - which are three
 * completely different things to do next.
 */

/** Walks `.cause` and `AggregateError.errors`, nearest first. */
export function causeChain(error: unknown, depth = 0): Error[] {
  if (depth > 5 || !(error instanceof Error)) return [];
  const nested: unknown[] = [];
  if (error.cause !== undefined) nested.push(error.cause);
  if (error instanceof AggregateError && Array.isArray(error.errors)) nested.push(...error.errors);
  return [error, ...nested.flatMap(e => causeChain(e, depth + 1))];
}

interface NodeSystemError extends Error {
  code?: string;
  syscall?: string;
  hostname?: string;
}

/**
 * Codes that mean "the request never got an answer", so trying again can work.
 *
 * A 4xx from Telegram is NOT here and must never be: an invalid token fails
 * identically every time, and retrying it forever would turn a typo into a
 * container that looks busy and is doing nothing.
 */
const RETRYABLE_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL',          // DNS
  'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED',  // refused or dropped
  'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'ABORT_ERR',                                    // our own timeout fired
]);

/** The innermost error carrying a recognisable network code, if any. */
export function networkCause(error: unknown): NodeSystemError | undefined {
  for (const link of causeChain(error)) {
    const code = (link as NodeSystemError).code;
    if (code && RETRYABLE_CODES.has(code)) return link as NodeSystemError;
  }
  return undefined;
}

/**
 * True when the failure is the network rather than the request.
 *
 * The bare-wrapper arm matters: undici can produce `TypeError: fetch failed`
 * with a cause that carries no `code` at all (a TLS failure, a proxy closing
 * the connection). Treating that as "not a network problem" would exit the
 * process on exactly the failure that retrying fixes.
 */
export function isNetworkError(error: unknown): boolean {
  if (networkCause(error)) return true;
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  return error instanceof TypeError && /fetch failed|network|terminated/i.test(error.message);
}

/**
 * A sentence naming what to do about it.
 *
 * The distinction that matters on a shared host: DNS that cannot resolve is a
 * container problem, a refused or unreachable connection is usually the host
 * blocking outbound traffic, and a timeout is either. Saying which one saves
 * an afternoon of changing the wrong setting.
 */
export function describeNetworkFailure(error: unknown, host: string): string {
  const cause = networkCause(error);
  const code = cause?.code;

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_FAIL') {
    return `cannot resolve ${host} (${code}) - the container has no working DNS, ` +
      'or the name is blocked upstream. Retrying; it will connect by itself if ' +
      'this is the host still coming up.';
  }
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ENETDOWN') {
    return `cannot reach ${host} (${code}) - outbound HTTPS to Telegram is ` +
      'refused or unroutable from this container. If this persists past a few ' +
      'minutes, the host is blocking it and no setting in the bot will help.';
  }
  if (code === 'ETIMEDOUT' || code?.startsWith('UND_ERR_') || code === 'ABORT_ERR') {
    return `timed out talking to ${host} (${code}) - the connection was accepted ` +
      'or attempted but nothing came back in time.';
  }
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ECONNABORTED') {
    return `the connection to ${host} was dropped (${code}) - usually transient, ` +
      'sometimes a middlebox interfering with TLS.';
  }
  const inner = causeChain(error).slice(1).map(e => e.message).find(Boolean);
  return `could not reach ${host}${inner ? ` - ${inner}` : ''}.`;
}
