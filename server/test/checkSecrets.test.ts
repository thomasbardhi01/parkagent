/**
 * `pnpm -C server check-secrets`, run as the operator runs it (--no-app, so
 * nothing reaches Fly): the 2026-09-26 misspelling is rejected with the
 * right name, a .p8 from the wrong file is caught by its name, and a good
 * proposal prints the command to run.
 */

import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, test } from "vitest";

const SERVER = fileURLToPath(new URL("..", import.meta.url));
const run = promisify(execFile);

async function checkSecrets(...args: string[]): Promise<{ code: number; out: string }> {
  try {
    const tsx = join(SERVER, "node_modules", ".bin", "tsx");
    const { stdout } = await run(tsx, ["src/scripts/check-secrets.ts", ...args], {
      cwd: SERVER,
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
    });
    return { code: 0, out: stdout };
  } catch (err) {
    const failed = err as { code: number; stdout: string };
    return { code: failed.code, out: failed.stdout };
  }
}

function keyFile(keyId: string): string {
  const dir = mkdtempSync(join(tmpdir(), "check-secrets-"));
  const path = join(dir, `AuthKey_${keyId}.p8`);
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }) as string);
  return path;
}

test("the 2026-09-26 misspelling is rejected, with the name it meant", async () => {
  const { code, out } = await checkSecrets(
    "--no-app",
    `APPLE_MAPS_PRIVATE_KEY=@${keyFile("ABCDE12345")}`,
    "APPLE_MAPS_KEY_ID=ABCDE12345",
    "APPLE_MAPS_TEAM_ID=TEAM123456",
  );
  expect(code).toBe(1);
  expect(out).toContain(
    "APPLE_MAPS_PRIVATE_KEY  REJECTED: the server doesn't read it — did you mean APPLE_MAPS_KEY?",
  );
  expect(out).toMatch(/apple_maps\s+off → degraded/);
  expect(out).toContain("Result: NOT OK.");
}, 30_000);

test("a .p8 whose file name says another key id is caught", async () => {
  const { code, out } = await checkSecrets(
    "--no-app",
    `APPLE_MAPS_KEY=@${keyFile("ZZZZZ99999")}`,
    "APPLE_MAPS_KEY_ID=ABCDE12345",
    "APPLE_MAPS_TEAM_ID=TEAM123456",
  );
  expect(code).toBe(1);
  expect(out).toContain("the key with id ZZZZZ99999, but APPLE_MAPS_KEY_ID is ABCDE12345");
}, 30_000);

test("a good proposal is OK and prints the command, secrets read from their file", async () => {
  const path = keyFile("ABCDE12345");
  const { code, out } = await checkSecrets(
    "--no-app",
    `APPLE_MAPS_KEY=${path}`,
    "APPLE_MAPS_KEY_ID=ABCDE12345",
    "APPLE_MAPS_TEAM_ID=TEAM123456",
    "STRIPE_SECRET_KEY=sk_test_abcdef123456",
    "STRIPE_WEBHOOK_SECRET=whsec_abcdef123456",
  );
  expect(code).toBe(0);
  expect(out).toMatch(/apple_maps\s+off → on/);
  expect(out).toContain("Result: OK to set.");
  expect(out).toContain(
    `fly secrets set -a parkagent-api APPLE_MAPS_KEY="$(cat '${path}')" ` +
      "APPLE_MAPS_KEY_ID=ABCDE12345 APPLE_MAPS_TEAM_ID=TEAM123456 " +
      "STRIPE_SECRET_KEY=sk_test_… STRIPE_WEBHOOK_SECRET=whsec_…",
  );
  // The secret values themselves are never echoed.
  expect(out).not.toContain("abcdef123456");
}, 30_000);
