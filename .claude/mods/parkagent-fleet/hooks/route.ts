import { atom, read, update } from "claude-code";
import type { On } from "claude-code";

import { HAIKU, type Engine } from "./shared";

// route.ts — send simple, read-only turns to a cheaper model (haiku).
//
// Mechanism: a `turn.step` hook rewrites the model of every request in a
// routed turn (see register.tsx's PR note). We decide at prompt.submit, mark
// the turn at turn.start, switch the model at each turn.step, and tally at
// turn.complete. `~` forces routing (the user's explicit choice); the
// never-route list vetoes only the automatic, intent-based path, so a prompt
// about money or a sensitive file is never silently sent to a weaker model.

/** Routing is off for this session (`/route off`). */
export const routeOff = atom({ plugin: "parkagent-fleet", key: "routeOff" } as const, false);
/** How many turns have been routed to haiku this session. */
export const routedTurns = atom({ plugin: "parkagent-fleet", key: "routedTurns" } as const, 0);
/** Tokens that ran on haiku instead of opus (the estimate of what was saved). */
export const routedTokens = atom({ plugin: "parkagent-fleet", key: "routedTokens" } as const, 0);
/** The turn being routed right now, so turn.step switches it and the band shows it. */
export const routedTurnId = atom(
  { plugin: "parkagent-fleet", key: "routedTurnId" } as const,
  null as string | null,
);

/** Prompts we never auto-route: money, migrations, and the sensitive modules. */
const NEVER_ROUTE: readonly RegExp[] = [
  /server\/src\/services\/(sessions|wallet|limits)/i,
  /server\/src\/routes\/(session|parked|assistant)/i,
  /(^|[\s"'`([/])prisma\//i,
  /\b(merge|deploy|migrate|migration|migrations|money|pay|payment|payments|cap|caps)\b/i,
];

/** Read-only intents that auto-route when nothing vetoes them. */
const INTENT: readonly RegExp[] = [
  /^what does\b/,
  /^where is\b/,
  /^explain\b/,
  /^summariz(e|es|ing)\b/,
];

export type RouteDecision = {
  route: boolean;
  /** The prompt with a leading `~` stripped, when that is why it routes. */
  cleaned: string | null;
  reason: "off" | "tilde" | "intent" | "vetoed" | "none";
};

/** Decide whether a prompt should run on haiku. Pure; unit-tested directly. */
export function decideRoute(text: string, isOff: boolean): RouteDecision {
  if (isOff) return { route: false, cleaned: null, reason: "off" };
  const t = text.replace(/^\s+/, "");
  if (t.startsWith("~")) {
    // Explicit: the user asked for haiku, so the never-route veto does not apply.
    return { route: true, cleaned: t.slice(1).replace(/^\s+/, ""), reason: "tilde" };
  }
  if (NEVER_ROUTE.some((re) => re.test(text)))
    return { route: false, cleaned: null, reason: "vetoed" };
  const lower = t.toLowerCase();
  const intent =
    INTENT.some((re) => re.test(lower)) ||
    (/^why is this failing\b/.test(lower) && /\n/.test(text)); // "with a pasted log"
  if (intent) return { route: true, cleaned: null, reason: "intent" };

  return { route: false, cleaned: null, reason: "none" };
}

const tokensOf = (
  usage:
    | {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens: number;
        cache_creation_input_tokens?: number;
      }
    | undefined,
): number =>
  usage
    ? usage.input_tokens +
      usage.output_tokens +
      usage.cache_read_input_tokens +
      (usage.cache_creation_input_tokens ?? 0)
    : 0;

// Set at prompt.submit, read at turn.start; a within-turn handoff, so a module
// variable is enough (a reload between the two only misses one route).
let pendingRoute = false;

/**
 * The prompt.submit half of routing, called from the fleet mod's one
 * prompt.submit hook (two unmatched hooks on one event in a plugin collide).
 * Decides whether to route this turn and returns the text to pass on — the
 * `~` stripped when that is why it routes, else the text unchanged.
 */
export async function routeOnSubmit(
  $: Engine,
  e: {
    text: string;
    command?: unknown;
    isMeta?: true;
    turnId?: string;
    origin?: { kind?: string };
  },
): Promise<string> {
  // Only a freshly typed prompt the person entered themselves: not a slash
  // command, not a hidden/meta prompt, not one delivered into a running turn,
  // and not a message that arrived from elsewhere (a peer, a task, the SDK) —
  // a message via session.receive becomes a prompt with one of those origins
  // and must never route.
  const kind = e.origin?.kind;
  const fromPerson = kind === undefined || kind === "composer" || kind === "bridge";
  if (e.command !== undefined || e.isMeta === true || e.turnId !== undefined || !fromPerson) {
    pendingRoute = false;

    return e.text;
  }
  const d = decideRoute(e.text, await read($, routeOff));
  pendingRoute = d.route;

  return d.route && d.cleaned !== null ? d.cleaned : e.text;
}

/**
 * The turn.complete half of routing, called from the fleet mod's one
 * turn.complete hook. Tallies a routed turn and clears the marker.
 */
export async function routeOnComplete(
  $: Engine,
  e: { agentId?: string; turnId: string; usage?: Parameters<typeof tokensOf>[0] },
): Promise<void> {
  if (e.agentId === undefined && (await read($, routedTurnId)) === e.turnId) {
    await update($, routedTurns, (n) => n + 1);
    await update($, routedTokens, (n) => n + tokensOf(e.usage));
    await update($, routedTurnId, () => null);
  }
}

/** Whether a turn is being routed to haiku right now (the band reads this). */
export async function isRouting($: Engine): Promise<boolean> {
  return (await read($, routedTurnId)) !== null;
}

/** The routed-turn tally for /route and the /fleet pane. */
export async function routedTally($: Engine): Promise<{ turns: number; tokens: number }> {
  const [turns, tokens] = await Promise.all([read($, routedTurns), read($, routedTokens)]);

  return { turns, tokens };
}

const READONLY_WRITE_TOOLS = ["Write", "Edit", "NotebookEdit"] as const;
const READONLY_DENY = "routed to haiku (read-only); resend without ~ to make changes";

const commandOf = (input: unknown): string =>
  typeof input === "object" &&
  input !== null &&
  typeof (input as { command?: unknown }).command === "string"
    ? (input as { command: string }).command
    : "";

/** A deliberately small set of commands a routed (haiku) turn may run without a
 * prompt. Anything else asks the person. Checked per `&&`/`;`/`|` segment. */
function isReadOnlyCommand(command: string): boolean {
  const segs = command
    .split(/\|\||&&|[;|&\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segs.length === 0) return false;

  return segs.every((seg) => {
    const t = seg.split(/\s+/);
    const c = (t[0] ?? "").split("/").pop();
    if (c === "rg" || c === "grep" || c === "cat" || c === "ls" || c === "vitest") return true;
    if (c === "pnpm") return t.some((x) => x === "test" || x === "vitest");
    if (c === "git") return ["log", "show", "diff", "status"].includes(t[1] ?? "");
    if (c === "gh") {
      if (t[1] === "pr") return t[2] === "view" || t[2] === "checks";
      if (t[1] === "run") return t[2] === "view" || t[2] === "list";
    }

    return false;
  });
}

/** The routing hooks on events the fleet mod doesn't already own. */
export function registerRoute(on: On): void {
  // A routed turn runs on haiku and is read-only: no writes, and Bash it can't
  // obviously tell is read-only is put to the person. Keyed on a routed turn
  // being in progress (routedTurnId set), since tool.check carries no turnId.
  for (const tool of READONLY_WRITE_TOOLS) {
    on("tool.check", { tool }, async ($, e, next) => {
      if (e.agentId === undefined && (await isRouting($))) {
        return { decision: "deny", reason: READONLY_DENY };
      }

      return next(e);
    });
  }
  on("tool.check", { tool: "Bash" }, async ($, e, next) => {
    if (e.agentId === undefined && (await isRouting($)) && !isReadOnlyCommand(commandOf(e.input))) {
      return {
        decision: "ask",
        reason: "routed to haiku; this command may change things — confirm, or resend without ~",
      };
    }

    return next(e);
  });

  on("turn.start", async ($, e, next) => {
    if (e.agentId !== undefined) return next(e); // subagents are never routed
    if (pendingRoute) {
      await update($, routedTurnId, () => e.turnId);
      pendingRoute = false;
    }

    return next(e);
  });

  // Streaming event: the hook is an async generator; yield* forwards the stream.
  on("turn.step", async function* ($, e, next) {
    if (e.agentId === undefined && (await read($, routedTurnId)) === e.turnId) {
      return yield* next({ ...e, model: HAIKU });
    }

    return yield* next(e);
  });

  on("command.run", { command: "route" }, async ($, e) => {
    const arg = e.args.trim().toLowerCase();
    if (arg === "off") {
      await update($, routeOff, () => true);
      await update($, routedTurnId, () => null);

      return { text: "Routing to haiku is OFF for this session." };
    }
    if (arg === "on") {
      await update($, routeOff, () => false);

      return {
        text: "Routing to haiku is ON. Prefix a prompt with ~ to force it; simple read-only asks route on their own.",
      };
    }
    const [off, turns, tokens] = await Promise.all([
      read($, routeOff),
      read($, routedTurns),
      read($, routedTokens),
    ]);

    return {
      text: `${off ? "Routing is OFF." : "Routing is ON."} ${turns} turn${turns === 1 ? "" : "s"} · ${tokens.toLocaleString()} tokens on haiku. /route off disables it.`,
    };
  });
}
