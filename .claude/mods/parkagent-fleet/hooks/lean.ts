import { atom, read, update } from "claude-code";
import type { On } from "claude-code";

import { gitBranch, type Engine } from "./shared";

// lean.ts — our own Ponytail mirror. When on, add a system-prompt section
// asking for the smallest change that fully meets the requirement. Off by
// default. It refuses on an audit branch, where the job is rigor, not brevity.

/** Lean mode is on for this session (`/lean on`). */
export const leanOn = atom({ plugin: "parkagent-fleet", key: "leanOn" } as const, false);

/** prompt.section can only edit the engine's own sections, so we append ours
 * at prompt.compose (scope "session" — it varies per session). */
const LEAN_SECTION = {
  id: "parkagent-fleet:lean",
  scope: "session" as const,
  text: [
    "Lean mode (parkagent-fleet) is on for this session. Prefer the smallest change that fully meets the requirement:",
    "- Write the minimum that meets the requirement; no speculative generality.",
    "- No new dependency without a one-line justification.",
    "- No abstraction with a single caller.",
    "- Delete before adding.",
    "- Never trade away input validation, error handling, security, or tests to be shorter.",
  ].join("\n"),
};

/** Whether lean mode is on (the band reads this). */
export async function isLean($: Engine): Promise<boolean> {
  return read($, leanOn);
}

export function registerLean(on: On): void {
  on("prompt.compose", async ($, e, next) => {
    const result = await next(e);
    if (!(await read($, leanOn))) return result;

    return { sections: [...result.sections, LEAN_SECTION] };
  });

  on("command.run", { command: "lean" }, async ($, e) => {
    const arg = e.args.trim().toLowerCase();
    if (arg === "on") {
      const branch = await gitBranch($);
      if (branch !== null && branch.startsWith("audit")) {
        return {
          text: `Lean mode refuses on an audit branch (${branch}) — an audit needs full rigor, not minimal code.`,
        };
      }
      await update($, leanOn, () => true);

      return {
        text: "Lean mode ON. New turns are asked to write the minimum that meets the requirement. /lean off turns it back.",
      };
    }
    if (arg === "off") {
      await update($, leanOn, () => false);

      return { text: "Lean mode OFF." };
    }

    return {
      text: (await read($, leanOn))
        ? "Lean mode is ON. /lean off turns it back."
        : "Lean mode is OFF. /lean on asks for the smallest change that meets the requirement.",
    };
  });
}
