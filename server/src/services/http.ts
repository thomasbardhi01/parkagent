/**
 * Every outbound HTTP call has a deadline. A third party that stops
 * answering (a stalled TLS handshake, a half-open connection) otherwise
 * holds whatever awaits it forever — a sign-in, a garage search, an
 * extension's lock. test/outboundScan.test.ts fails a bare `fetch` in
 * src/: use this, or pass your own `signal`.
 */

export const OUTBOUND_TIMEOUT_MS = 10_000;

/** `fetch`, aborted after `timeoutMs` (and still by the caller's signal). */
export function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs: number = OUTBOUND_TIMEOUT_MS,
): Promise<Response> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  return fetch(input, { ...init, signal });
}

/** A fetch-shaped function with a fixed deadline, for clients that take
 * `typeof fetch` (their tests pass their own). */
export function fetchWithin(timeoutMs: number): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    fetchWithTimeout(input, init ?? {}, timeoutMs)) as typeof fetch;
}
