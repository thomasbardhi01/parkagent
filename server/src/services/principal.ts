/**
 * Who is acting. One shape for a signed-in user, the owner's admin key, a
 * background job, and (WS-4) an external agent holding a scoped key. The
 * auth hook resolves a request into one (app.ts makeAuthenticate); a job
 * constructs its own per row it works on. The money gate reads `actor`
 * for consent, and the decision writer stamps it on every row.
 *
 * The current principal rides on Node's AsyncLocalStorage so the one
 * decision writer (services/decisionLog.ts) can stamp `actor` without a
 * request in hand: `runAs` scopes it to a request or a job pass.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type Actor = "user" | "admin" | "job" | "external_agent";
export type Scope = "read" | "confirm";

export interface Principal {
  userId: string;
  actor: Actor;
  /** Set only for an external agent: the key it holds (WS-4 PR 2). */
  agentKeyId?: string;
  scopes: ReadonlySet<Scope>;
}

const ALL_SCOPES: ReadonlySet<Scope> = new Set<Scope>(["read", "confirm"]);

/** A signed-in person, or the owner's key: everything their account can do. */
export function userPrincipal(user: { id: string; isAdmin: boolean }): Principal {
  return { userId: user.id, actor: user.isAdmin ? "admin" : "user", scopes: ALL_SCOPES };
}

/** A background job acting for the row's owner (the extension worker, the
 * janitors): what the user's own policy allows, with no one tapping. */
export function jobPrincipal(userId: string): Principal {
  return { userId, actor: "job", scopes: ALL_SCOPES };
}

/** An external agent holding one of the person's keys (WS-4): only the
 * key's scopes, and only for a person who said agents may act. */
export function agentPrincipal(key: {
  userId: string;
  id: string;
  scopes: readonly string[];
}): Principal {
  const scopes = new Set<Scope>();
  for (const s of key.scopes) if (s === "read" || s === "confirm") scopes.add(s);
  return { userId: key.userId, actor: "external_agent", agentKeyId: key.id, scopes };
}

/** Where an agent key may go, and the only place one may go: each
 * surface is one principal kind. A user's session or the admin key is
 * refused here, and an agent key is refused everywhere else: the REST
 * surface and the MCP endpoint (routes/mcp.ts). */
export const AGENT_SURFACES: readonly string[] = ["/agent/", "/mcp/"];

export function isAgentSurface(path: string): boolean {
  return AGENT_SURFACES.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix));
}

/** What a request or job pass runs as: who, and the W3C trace it carried
 * (`traceparent`'s trace-id, 32 hex digits), so a decisions row can be
 * joined to the caller's own trace. */
interface RunContext {
  principal: Principal;
  traceId: string | null;
}

const store = new AsyncLocalStorage<RunContext>();

/** Run `fn` as `principal` for everything it awaits, under `traceId`
 * when the request carried one. */
export function runAs<T>(principal: Principal, fn: () => T, traceId: string | null = null): T {
  return store.run({ principal, traceId }, fn);
}

/** The principal the current request or job pass runs as, or null outside
 * one (a script, a test calling a service directly). */
export function currentPrincipal(): Principal | null {
  return store.getStore()?.principal ?? null;
}

/** The current request's trace id, or null (a job, a request without one). */
export function currentTraceId(): string | null {
  return store.getStore()?.traceId ?? null;
}

const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i;

/** The trace id in a `traceparent` header (W3C Trace Context), or null
 * for a missing or malformed one — never a string of the caller's choosing. */
export function traceIdFrom(traceparent: unknown): string | null {
  if (typeof traceparent !== "string") return null;
  const match = TRACEPARENT.exec(traceparent.trim());
  const id = match?.[1]?.toLowerCase();
  return id && id !== "0".repeat(32) ? id : null;
}

/** The principal acting for `userId` here: the request's or job pass's
 * own, or a plain user outside one (a service called directly, as tests
 * do). Services that take a user id and not a request read this. A
 * current principal for ANOTHER user is a bug, never a downgrade: an
 * agent or an admin reaching a user's money path is judged as itself or
 * not at all, so this throws rather than answer as that user. */
export function principalFor(userId: string): Principal {
  const current = currentPrincipal();
  if (!current) return userPrincipal({ id: userId, isAdmin: false });
  if (current.userId !== userId) {
    throw new Error(
      `principal mismatch: ${current.actor} for ${current.userId} acting for ${userId}`,
    );
  }
  return current;
}
