/**
 * Postgres refusing input it can't store: a NUL byte in text (22021,
 * invalid UTF-8) or in JSON (22P05, an unsupported \u0000). The request
 * was malformed, not the server, so the error handler and MCP answer 400
 * (#281). It is the backstop: a route parses its ids first (routes/ids.ts),
 * and this catches a field that reaches a query some other way.
 */

const BAD_INPUT_SQLSTATES = new Set(["22021", "22P05"]);

/** The SQLSTATE behind a Prisma error: the pg adapter's `originalCode`,
 * which Prisma 7 keeps on `meta.driverAdapterError` (P2039 / P2010). */
export function sqlStateOf(err: unknown): string | null {
  const e = err as {
    meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
    cause?: { originalCode?: unknown };
  } | null;
  const code = e?.meta?.driverAdapterError?.cause?.originalCode ?? e?.cause?.originalCode;
  return typeof code === "string" ? code : null;
}

export function isBadInputSqlState(err: unknown): boolean {
  const code = sqlStateOf(err);
  return code !== null && BAD_INPUT_SQLSTATES.has(code);
}

/** Postgres refusing the request's own input, and nothing paid on the way:
 * a start that reached the provider and then failed (whatever made it
 * fail) is a server error, since what it charged is unknown, and keeps its
 * 500 and its error log. */
export function isBadRequestInput(err: unknown): boolean {
  return isBadInputSqlState(err) && (err as { reachedProvider?: unknown }).reachedProvider !== true;
}
