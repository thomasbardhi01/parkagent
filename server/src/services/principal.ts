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

const store = new AsyncLocalStorage<Principal>();

/** Run `fn` with `principal` as the current one for everything it awaits. */
export function runAs<T>(principal: Principal, fn: () => T): T {
  return store.run(principal, fn);
}

/** The principal the current request or job pass runs as, or null outside
 * one (a script, a test calling a service directly). */
export function currentPrincipal(): Principal | null {
  return store.getStore() ?? null;
}

/** The principal acting for `userId` here: the request's or job pass's
 * own when it is theirs, else a plain user (a service called outside one,
 * as tests do). Services that take a user id and not a request read this. */
export function principalFor(userId: string): Principal {
  const current = currentPrincipal();
  return current && current.userId === userId
    ? current
    : userPrincipal({ id: userId, isAdmin: false });
}
