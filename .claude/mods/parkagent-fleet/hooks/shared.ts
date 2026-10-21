import type { Register } from "claude-code";

/** The engine interface a hook receives as `$`, inferred from `Register`. */
export type Engine = Parameters<Parameters<Register>[0]>[2] extends (
  $: infer E,
  ...rest: never[]
) => unknown
  ? E
  : never;

/** The model simple turns are routed to (route.ts); an alias the engine resolves. */
export const HAIKU = "haiku";

/** A background step that failed goes to the debug log, not a toast. */
export const logFail =
  ($: Engine, what: string) =>
  (err: unknown): void =>
    $.ui.log(
      `parkagent-fleet: ${what} failed: ${err instanceof Error ? err.message : String(err)}`,
      { to: "debug" },
    );

/** The current git branch, or null when the directory is not a repo. */
export async function gitBranch($: Engine): Promise<string | null> {
  try {
    const cwd = await $.session.cwd();
    const ran = await $.process.run(["git", "-C", cwd, "branch", "--show-current"], {
      timeoutMs: 3_000,
    });
    if (ran.exitCode === 0) return ran.stdout.trim() || null;
  } catch {
    // not a repo, or git missing
  }

  return null;
}
