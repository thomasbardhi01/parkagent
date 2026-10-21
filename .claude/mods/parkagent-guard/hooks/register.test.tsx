import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";
import type { Engine, MockClock } from "claude-code/testing";

const START = { cwd: "/repo", surface: "terminal", isInteractive: true } as const;
const GUARD = (args: string) =>
  ({
    command: "guard",
    args,
    origin: { kind: "composer" },
    presentation: { isFullscreen: true, columns: 120 },
  }) as const;

/** The engine beneath the guard: a held clock, a git branch, and the ask answer. */
function world(on: On) {
  const w = {
    clock: mock.clock(on, { now: 1_000_000 }),
    branch: "feat/x",
    askAnswer: "Lift for 10 minutes",
    asks: 0,
    logs: [] as string[],
  };
  // Nothing sits beneath the guard, so these stand for the engine's own work.
  on("tool.check", () => ({ decision: "allow" }));
  on("command.register", (_, e) => ({ value: { command: e.name } }));
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("session.cwd", () => ({ value: "/repo" }));
  on("process.run", (_, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv.includes("branch") ? `${w.branch}\n` : "",
      stderr: "",
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }));
  on("ui.log", (_, e) => (w.logs.push(e.text), { value: undefined }));
  // $.ui.ask runs as a tool.call of AskUserQuestion; answers are keyed by the
  // question text. This stands for the person picking an option.
  on("tool.call", { tool: "AskUserQuestion" }, (_, e) => {
    w.asks += 1;
    const question = e.questions[0]?.question ?? "";
    return { result: { answers: { [question]: w.askAnswer } } };
  });

  return w;
}

const check = ($: Engine, command: string, agentId?: string) =>
  $.tool.check({ tool: "Bash", input: { command }, ...(agentId ? { agentId } : {}) });

test("the guard denies a guarded command and allows an innocent one through tool.check", async ($, on) => {
  world(on);
  await $.session.start(START);

  expect((await check($, "gh pr merge 1")).decision).toBe("deny");
  expect((await check($, "gh pr merge 1")).reason).toMatch(/^guard:/);
  expect((await check($, "cat .env")).decision).toBe("deny");
  expect((await check($, "pnpm -r test")).decision).toBe("allow");
});

test("a bare git push is decided by the current branch, read once from git", async ($, on) => {
  const w = world(on);
  await $.session.start(START);

  w.branch = "main";
  expect((await check($, "git push")).decision).toBe("deny");

  w.branch = "feat/mods-guard";
  expect((await check($, "git push")).decision).toBe("allow");
});

test("/guard off lifts the guard for 10 minutes, then it re-arms on expiry", async ($, on) => {
  const w = world(on);
  await $.session.start(START);

  expect((await check($, "gh pr merge 1")).decision).toBe("deny");

  const res = await $.command.run(GUARD("off"));
  expect(w.asks).toBe(1);
  expect(res.text).toMatch(/lifted/i);
  expect(w.logs.some((l) => /LIFTED/.test(l))).toBe(true);

  // Within the window: the same command now passes to the engine's verdict.
  expect((await check($, "gh pr merge 1")).decision).toBe("allow");

  // Nine minutes in: still lifted.
  await w.clock.advance(9 * 60_000);
  expect((await check($, "gh pr merge 1")).decision).toBe("allow");

  // Past ten minutes: armed again.
  await w.clock.advance(2 * 60_000);
  expect((await check($, "gh pr merge 1")).decision).toBe("deny");
});

test("declining the confirmation leaves the guard on", async ($, on) => {
  const w = world(on);
  w.askAnswer = "Keep guard on";
  await $.session.start(START);

  const res = await $.command.run(GUARD("off"));
  expect(res.text).toMatch(/left on/i);
  expect((await check($, "gh pr merge 1")).decision).toBe("deny");
});

test("/guard on re-arms the guard before the window ends", async ($, on) => {
  const w = world(on);
  await $.session.start(START);
  await $.command.run(GUARD("off"));
  expect((await check($, "gh pr merge 1")).decision).toBe("allow");

  const res = await $.command.run(GUARD("on"));
  expect(res.text).toMatch(/re-armed/i);
  expect((await check($, "gh pr merge 1")).decision).toBe("deny");
  void w;
});

test("the off window never applies to a subagent: its Bash stays guarded", async ($, on) => {
  world(on);
  await $.session.start(START);
  await $.command.run(GUARD("off"));

  // The main loop is lifted...
  expect((await check($, "gh pr merge 1")).decision).toBe("allow");
  // ...but a subagent's call carries an agentId and stays denied.
  expect((await check($, "gh pr merge 1", "sub-1")).decision).toBe("deny");
  expect((await check($, "cat .env", "sub-1")).decision).toBe("deny");
  // a subagent's innocent command still runs
  expect((await check($, "pnpm test", "sub-1")).decision).toBe("allow");
});

test("/guard status reports whether the guard is on or lifted", async ($, on) => {
  const w = world(on);
  await $.session.start(START);
  expect((await $.command.run(GUARD("status"))).text).toMatch(/guard is on/i);
  await $.command.run(GUARD("off"));
  expect((await $.command.run(GUARD(""))).text).toMatch(/lifted/i);
  void w;
});
