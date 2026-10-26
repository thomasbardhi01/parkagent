import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs without types
import { checkFeatureMap } from "../../scripts/check-feature-map.mjs";

const REPO = resolve(__dirname, "../..");
const SCRIPT = join(REPO, "scripts/check-feature-map.mjs");

const SRC = [
  "// header",
  "/** doc */",
  "export function foo() {",
  "  return 1;",
  "}",
  "",
  " * star",
  "const bar = 2;",
].join("\n");

function fixture(map: string, src = SRC, file = "a/x.ts"): string {
  const root = mkdtempSync(join(tmpdir(), "fm-"));
  chmodSync(root, 0o755);
  const files: Record<string, string> = { [file]: src, "docs/feature-map.md": map };
  for (const [p, body] of Object.entries(files)) {
    const abs = join(root, p);
    mkdirSync(dirname(abs), { recursive: true, mode: 0o755 });
    for (let d = dirname(abs); d.length > root.length; d = dirname(d)) chmodSync(d, 0o755);
    writeFileSync(abs, body, { mode: 0o644 });
    chmodSync(abs, 0o644);
  }
  return root;
}

const run = (...args: string[]) => spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });

describe("comment rule (AC1)", () => {
  it("flags comment and blank lines", () => {
    const root = fixture("`a/x.ts:2` `a/x.ts:7` `a/x.ts:6`\n");
    expect(checkFeatureMap(root)).toEqual([
      "`a/x.ts:2`: line 2 is a comment or blank",
      "`a/x.ts:7`: line 7 is a comment or blank",
      "`a/x.ts:6`: line 6 is a comment or blank",
    ]);
  });
  it("passes :1, code lines and ranges", () => {
    expect(checkFeatureMap(fixture("`a/x.ts:1` `a/x.ts:4` `a/x.ts:8-9`\n"))).toEqual([]);
  });
});

describe("name rule (AC2)", () => {
  it("flags a declared name on another line", () => {
    const root = fixture("`foo` (`a/x.ts:8`) and `Mod.bar` `a/x.ts:4`\n");
    expect(checkFeatureMap(root)).toEqual([
      "`a/x.ts:8`: line 8 doesn't mention foo",
      "`a/x.ts:4`: line 4 doesn't mention bar",
    ]);
  });
  it("passes the declaring line and undeclared names", () => {
    expect(checkFeatureMap(fixture("`foo()` `a/x.ts:3` `nope` `a/x.ts:4`\n"))).toEqual([]);
  });
});

describe("past the end (AC5)", () => {
  it("yields only the lines problem", () => {
    expect(checkFeatureMap(fixture("`foo` `a/x.ts:99`\n"))).toEqual([
      "`a/x.ts:99`: a/x.ts has 8 lines",
    ]);
  });
});

describe("CLI (AC3, AC6)", () => {
  it("exits 1 naming a stale reference", () => {
    const r = run("--root", fixture("`a/x.ts:2`\n"));
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain("`a/x.ts:2`");
  });
  it("exits 0 on a clean fixture", () => {
    expect(run("--root", fixture("`a/x.ts:4`\n")).status).toBe(0);
  });
  it("exits 2 with usage on bad arguments", () => {
    for (const args of [["--bogus"], ["--root"]]) {
      const r = run(...args);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("usage: node scripts/check-feature-map.mjs [--root <dir>]");
    }
  });
  it("checks its own repo with no arguments", () => {
    expect(run().status).toBe(0);
  });
});

describe("the real map (AC4)", () => {
  it("is clean", () => {
    expect(checkFeatureMap(REPO)).toEqual([]);
  });
});
