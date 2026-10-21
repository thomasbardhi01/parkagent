import { atom, read, update } from "claude-code";
import type { Register } from "claude-code";

import { decide, expand, gitDirOf, needsBranch } from "./guard";

type Engine = Parameters<Parameters<Register>[0]>[2] extends (
  $: infer E,
  ...rest: never[]
) => unknown
  ? E
  : never;

const OFF_MS = 10 * 60 * 1000;

/** When the /guard off window ends, in epoch ms; 0 means the guard is armed. */
const offUntil = atom({ plugin: "parkagent-guard", key: "offUntil" } as const, 0);

/** Guarded verbs scanned in the fail-closed catch, when the hook itself threw. */
const GUARDED = /(?:^|[\s;&|()`$<>])(?:gh|git|fly|flyctl)(?:\s|$)|\.env(?:\.|\b)|Config\.xcconfig/;

const commandOf = (input: unknown): string =>
  typeof input === "object" &&
  input !== null &&
  typeof (input as { command?: unknown }).command === "string"
    ? (input as { command: string }).command
    : "";

/** The current git branch, for a bare `git push`; null when it can't be read. */
async function currentBranch($: Engine, dir: string | null): Promise<string | null> {
  try {
    const cwd = dir ?? (await $.session.cwd());
    const ran = await $.process.run(["git", "-C", cwd, "branch", "--show-current"], {
      timeoutMs: 3_000,
    });
    if (ran.exitCode === 0) return ran.stdout.trim() || null;
  } catch {
    // not a repo, or git missing: a bare push can't reach main here.
  }

  return null;
}

const clockTime = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "guard",
      description: "ParkAgent guard: /guard status · /guard off (lift 10 min) · /guard on",
      argumentHint: "off | on | status",
    });

    return next(e);
  });

  // The enforcement layer. Only ever tightens: a guarded command is denied,
  // everything else defers to the engine's own verdict via next(e).
  on("tool.check", { tool: "Bash" }, async ($, e, next) => {
    const command = commandOf(e.input);
    if (command === "") return next(e);

    // The /guard off window lifts the guard for THIS session's main loop only.
    // A subagent (e.agentId set) is always guarded, window or not.
    if (e.agentId === undefined) {
      const until = await read($, offUntil);
      if (until > (await $.clock.now())) return next(e);
    }

    let branch: string | null = null;
    const parsed = expand(command);
    if (parsed.ok && needsBranch(parsed.argvs)) {
      branch = await currentBranch($, gitDirOf(parsed.argvs));
    }

    const reason = decide(command, branch);
    if (reason !== null) return { decision: "deny", reason };

    return next(e);
  }).catch(($, e, next) => {
    // The hook threw or timed out. Fail closed on anything naming a guarded
    // tool; otherwise let the engine's verdict stand.
    if (GUARDED.test(commandOf(e.input))) {
      return {
        decision: "deny",
        reason:
          "guard: the guard failed to evaluate a command naming a guarded tool; blocked. Retry, or /guard off.",
      };
    }

    return next.called ? next(e) : { decision: "allow" };
  });

  on("command.run", { command: "guard" }, async ($, e) => {
    const arg = e.args.trim().toLowerCase();
    const now = await $.clock.now();

    if (arg === "on") {
      await update($, offUntil, () => 0);
      $.ui.log("guard: re-armed by /guard on.");

      return { text: "Guard re-armed. Guarded commands are blocked again." };
    }

    if (arg === "off") {
      const choice = await $.ui.ask(
        "Lift the ParkAgent guard for 10 minutes in this session? It still applies to subagents.",
        { options: ["Keep guard on", "Lift for 10 minutes"], header: "Guard" },
      );
      if (choice !== "Lift for 10 minutes") {
        return { text: "Guard left on." };
      }
      const until = now + OFF_MS;
      await update($, offUntil, () => until);
      // A durable record in the transcript of who lifted it and until when.
      $.ui.log(
        `guard: LIFTED by /guard off until ${clockTime(until)} (this session's main loop only; subagents stay guarded).`,
      );

      return {
        text: `Guard lifted until ${clockTime(until)}. Subagents stay guarded. /guard on re-arms it now.`,
      };
    }

    // status (and bare /guard)
    const until = await read($, offUntil);
    const lifted = until > now;
    return {
      text: lifted
        ? `Guard is LIFTED until ${clockTime(until)} (main loop only; subagents stay guarded). /guard on re-arms it.`
        : "Guard is ON. It blocks merges, pushes to main, fly deploy/secrets/ssh/postgres, and reads of .env or Config.xcconfig. /guard off lifts it for 10 minutes.",
    };
  });
};
