/**
 * No bare `fetch` in the server: every outbound call has a deadline
 * (services/http.ts). A use of the global is allowed only where the call
 * itself passes an AbortSignal — listed here with where.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

const ALLOWED: { file: string; why: string }[] = [
  { file: "services/http.ts", why: "the deadline wrapper itself" },
  { file: "services/idToken.ts", why: "JWKS fetch passes AbortSignal.timeout(5000)" },
  { file: "services/appleTokens.ts", why: "token and revoke calls pass AbortSignal.timeout(8000)" },
  { file: "services/assistant/appleMaps.ts", why: "every call passes AbortSignal.timeout(6000)" },
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "generated" ? [] : sources(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

test("the global fetch is only used where the call carries its own deadline", () => {
  const bare: string[] = [];
  for (const path of sources(SRC)) {
    const file = relative(SRC, path);
    if (ALLOWED.some((a) => a.file === file)) continue;
    readFileSync(path, "utf8")
      .split("\n")
      .forEach((line, index) => {
        const code = line.replace(/\/\*.*?\*\//g, "").replace(/\/\/.*$/, "");
        if (/^\s*\*/.test(code)) return; // doc comments
        // The global as a value: `fetch(`, `?? fetch`, `= fetch` — not
        // `typeof fetch`, not fetchWithTimeout/fetchImpl/refetch/x.fetch.
        if (/(?<![\w.$])fetch(?![\w$])/.test(code.replace(/typeof fetch/g, ""))) {
          bare.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
  }
  expect(bare, "use fetchWithTimeout (services/http.ts) or pass a signal").toEqual([]);
});
