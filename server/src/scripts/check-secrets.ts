/**
 * Check secrets BEFORE `fly secrets set`: the same evaluation the server
 * runs at boot (src/env.ts), on the values you're about to set, on top of
 * the names already set on the app. Prints each proposed setting's verdict,
 * which features it would switch on, off, or leave degraded, and the
 * command to run.
 *
 *   pnpm -C server check-secrets APPLE_MAPS_KEY=@~/Downloads/AuthKey_ABCDE12345.p8 \
 *     APPLE_MAPS_KEY_ID=ABCDE12345 APPLE_MAPS_TEAM_ID=TEAM123456
 *   pnpm -C server check-secrets ~/Downloads/AuthKey_ABCDE12345.p8   # just the file
 *   pnpm -C server check-secrets --unset APPLE_SIGNIN_KEY             # preview a removal
 *
 *   NAME=value     a proposed setting; NAME=@path (or a value that is the
 *                  path of a .p8 file) reads the value from the file
 *   path.p8        inspect a key file on its own
 *   --unset NAME   preview `fly secrets unset NAME` (repeatable)
 *   --app NAME     the Fly app whose secret NAMES are read (values never
 *                  leave Fly); default parkagent-api
 *   --no-app       judge the proposal alone
 *   --env-file P   start from a local env file instead (values known, so
 *                  they're checked too)
 *   --live         ask Apple whether a proposed Maps or Sign in with Apple
 *                  key works: a token request, nothing created or charged
 *
 * Exits 0 only when every proposed setting is accepted, nothing would
 * refuse boot, no feature it touches ends up degraded, and (with --live)
 * Apple accepted the keys. On 2026-09-26 `APPLE_MAPS_PRIVATE_KEY` (a name
 * the server doesn't read) took prod down for four hours; this says
 * "did you mean APPLE_MAPS_KEY?" before anything is set.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";

import { parse as parseDotenv } from "dotenv";

import {
  DEFAULT_APPLE_AUDIENCE,
  FEATURES,
  KNOWN_NAMES,
  checkEnv,
  inspectP8,
  suggestName,
} from "../env.js";
import type { FeatureId, FeatureStatus } from "../env.js";
import { makeMapsAuthToken } from "../services/assistant/appleMaps.js";
import { APPLE_TOKEN_URL, makeAppleClientSecret } from "../services/appleTokens.js";
import { fetchWithTimeout } from "../services/http.js";

const CORE = ["DATABASE_URL", "AUTH_JWT_SECRET", "API_KEY_PEPPER"];
/** Shown shortened in the printed command. */
const SECRET = new Set([
  "DATABASE_URL",
  "AUTH_JWT_SECRET",
  "API_KEY_PEPPER",
  "PROVIDER_STATE_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "RESEND_API_KEY",
  "ANTHROPIC_API_KEY",
  "LINK_CLIENT_SECRET",
  "APNS_KEY",
  "APPLE_SIGNIN_KEY",
  "APPLE_MAPS_KEY",
  "SOCRATA_APP_TOKEN",
]);
/** Each .p8 slot and the key id that must name it. */
const KEY_ID_OF: Record<string, string> = {
  APNS_KEY: "APNS_KEY_ID",
  APPLE_SIGNIN_KEY: "APPLE_SIGNIN_KEY_ID",
  APPLE_MAPS_KEY: "APPLE_MAPS_KEY_ID",
};
const PLACEHOLDER = "(already set; value not read)";

interface Proposed {
  name: string;
  value: string;
  /** The file it was read from, if any. */
  file?: string;
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(path);
}

/** Apple names downloaded keys AuthKey_<KEY ID>.p8. */
function keyIdFromFile(file: string | undefined): string | undefined {
  return file ? /^AuthKey_([A-Z0-9]{10})\.p8$/.exec(basename(file))?.[1] : undefined;
}

function parseProposal(arg: string): Proposed | { error: string } {
  const eq = arg.indexOf("=");
  const name = arg.slice(0, eq);
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return { error: `"${arg}" isn't NAME=value` };
  let value = arg.slice(eq + 1);
  if (value.startsWith("@")) {
    const file = expandHome(value.slice(1));
    if (!existsSync(file)) return { error: `${name}: no file at ${file}` };
    return { name, value: readFileSync(file, "utf8"), file };
  }
  if (value.endsWith(".p8") && existsSync(expandHome(value))) {
    const file = expandHome(value);
    value = readFileSync(file, "utf8");
    return { name, value, file };
  }
  return { name, value };
}

/** The secret names already on a Fly app (names only; Fly never returns values). */
function flySecretNames(app: string): string[] {
  const out = execFileSync("fly", ["secrets", "list", "-a", app, "--json"], {
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return (JSON.parse(out) as { name: string }[]).map((s) => s.name);
}

function shown(p: Proposed): string {
  if (p.file) return `${p.name}="$(cat '${p.file}')"`;
  if (!SECRET.has(p.name))
    return `${p.name}=${/^[\w.:/@<> -]*$/.test(p.value) ? p.value : `'${p.value}'`}`;
  const prefix = /^([a-z]{2,4}_(live_|test_)?|sk-ant-|re_|whsec_|postgres(ql)?:\/\/)/.exec(
    p.value,
  )?.[0];
  return `${p.name}=${prefix ?? ""}…`;
}

async function probeMaps(key: string, keyId: string, teamId: string): Promise<string | null> {
  const token = makeMapsAuthToken({ privateKey: key, keyId, teamId }, Date.now());
  const res = await fetchWithTimeout(
    "https://maps-api.apple.com/v1/token",
    { headers: { Authorization: `Bearer ${token}` } },
    8_000,
  );
  if (res.ok) return null;
  return (
    `Apple answered ${res.status}: the .p8, APPLE_MAPS_KEY_ID, and APPLE_MAPS_TEAM_ID ` +
    "don't belong together, or the key doesn't have Maps enabled"
  );
}

async function probeSignIn(
  key: string,
  keyId: string,
  teamId: string,
  clientId: string,
): Promise<string | null> {
  // A made-up authorization code: Apple checks the client secret first, so
  // invalid_grant means the key was accepted and invalid_client that it wasn't.
  const res = await fetchWithTimeout(
    APPLE_TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: makeAppleClientSecret({ key, keyId, teamId, clientId }, Date.now()),
        code: "check-secrets-probe",
        grant_type: "authorization_code",
      }).toString(),
    },
    8_000,
  );
  const error = ((await res.json().catch(() => ({}))) as { error?: string }).error;
  if (error === "invalid_grant") return null;
  return (
    `Apple answered ${error ?? res.status}: the .p8, APPLE_SIGNIN_KEY_ID, APPLE_SIGNIN_TEAM_ID, ` +
    `and the app id (${clientId}) don't belong together, or the key doesn't have Sign in with Apple enabled`
  );
}

function stateLine(status: FeatureStatus | undefined): string {
  if (!status) return "?";
  return status.state === "degraded" ? `degraded (${status.detail})` : status.state;
}

async function main(): Promise<number> {
  // pnpm forwards a literal "--"; parseArgs would read it as a positional.
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const { values: flags, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      app: { type: "string", default: "parkagent-api" },
      "no-app": { type: "boolean", default: false },
      "env-file": { type: "string" },
      unset: { type: "string", multiple: true, default: [] },
      live: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (flags.help || (positionals.length === 0 && flags.unset.length === 0)) {
    console.log(
      "Usage: pnpm -C server check-secrets [--app NAME | --no-app | --env-file PATH] [--live]\n" +
        "         NAME=value | NAME=@file | AuthKey_XXXXXXXXXX.p8 | --unset NAME …",
    );
    return flags.help ? 0 : 2;
  }

  const proposed: Proposed[] = [];
  const keyFiles: string[] = [];
  for (const arg of positionals) {
    if (!arg.includes("=")) {
      if (arg.endsWith(".p8")) {
        keyFiles.push(expandHome(arg));
        continue;
      }
      console.error(`"${arg}" isn't NAME=value or a .p8 file`);
      return 2;
    }
    const parsed = parseProposal(arg);
    if ("error" in parsed) {
      console.error(parsed.error);
      return 2;
    }
    proposed.push(parsed);
  }
  const unset = new Set(flags.unset);

  // ---- the starting point: what's already set
  const base: Record<string, string> = {};
  const unchecked = new Set<string>();
  let baseLabel: string;
  if (flags["env-file"]) {
    const path = expandHome(flags["env-file"]);
    Object.assign(base, parseDotenv(readFileSync(path, "utf8")));
    baseLabel = `${Object.keys(base).length} settings in ${path} (checked too)`;
  } else if (!flags["no-app"]) {
    let names: string[];
    try {
      names = flySecretNames(flags.app);
    } catch (err) {
      console.error(
        `Couldn't list the secrets on ${flags.app} (${String(err).split("\n")[0]}).\n` +
          "Log in with `fly auth login`, or pass --no-app to judge the proposal alone.",
      );
      return 2;
    }
    for (const name of names) {
      base[name] = PLACEHOLDER;
      unchecked.add(name);
    }
    baseLabel =
      `the ${names.length} secrets already on ${flags.app} ` +
      "(names only: their values aren't read, and are assumed valid)";
  } else {
    baseLabel = "nothing (--no-app)";
  }
  // The core is already running on any server this is set on; judge it
  // only when the proposal touches it.
  for (const name of CORE) {
    if (base[name] === undefined) {
      base[name] = PLACEHOLDER;
      unchecked.add(name);
    }
  }
  if (base["DRY_RUN"] === undefined && !flags["env-file"]) {
    base["DRY_RUN"] = PLACEHOLDER;
    unchecked.add("DRY_RUN");
  }

  const after: Record<string, string> = { ...base };
  const afterUnchecked = new Set(unchecked);
  for (const name of unset) {
    delete after[name];
    afterUnchecked.delete(name);
  }
  for (const p of proposed) {
    after[p.name] = p.value;
    afterUnchecked.delete(p.name);
  }

  const before = checkEnv(base, { unchecked });
  const report = checkEnv(after, { unchecked: afterUnchecked });

  // ---- verdict per proposed setting
  const known = new Set<string>(KNOWN_NAMES);
  const featureOf = (name: string): FeatureId | undefined =>
    (Object.keys(FEATURES) as FeatureId[]).find((id) =>
      (FEATURES[id].vars as readonly string[]).includes(name),
    );
  const mentions = (line: string, name: string) => new RegExp(`\\b${name}\\b`).test(line);
  let rejected = 0;
  const verdicts: [string, string][] = [];
  for (const p of proposed) {
    let verdict: string;
    const feature = featureOf(p.name);
    const status = feature ? report.features.find((f) => f.id === feature) : undefined;
    const fatal = report.fatal.find((line) => line.startsWith(`${p.name}:`));
    const fileKeyId = keyIdFromFile(p.file);
    const idName = KEY_ID_OF[p.name];
    const proposedId = idName ? proposed.find((q) => q.name === idName)?.value.trim() : undefined;
    if (!known.has(p.name)) {
      const suggestion = suggestName(p.name);
      verdict =
        "REJECTED: the server doesn't read it" +
        (suggestion ? ` — did you mean ${suggestion}?` : "");
    } else if (p.value.trim() === "") {
      verdict = `REJECTED: empty. To remove it, preview with --unset ${p.name}`;
    } else if (fatal) {
      verdict = `REJECTED, would refuse boot: ${fatal.slice(p.name.length + 2)}`;
    } else if (status?.state === "degraded" && mentions(status.detail, p.name)) {
      verdict = `REJECTED: ${status.detail}`;
    } else if (fileKeyId && proposedId && fileKeyId !== proposedId) {
      verdict =
        `REJECTED: the file is ${basename(p.file!)}, the key with id ${fileKeyId}, ` +
        `but ${idName} is ${proposedId}. The wrong .p8, or the wrong id?`;
    } else {
      const warning = report.warnings.find((w) => w.startsWith(`${p.name} `));
      const inspected = p.name in KEY_ID_OF ? inspectP8(p.value) : undefined;
      verdict =
        "ok" +
        (inspected?.ok ? " (EC P-256 private key)" : "") +
        (fileKeyId && idName && !proposedId && unchecked.has(idName)
          ? `; its file says key id ${fileKeyId}: make sure ${idName} on ${flags.app} is that`
          : "") +
        (warning ? `; but ${warning}` : "");
    }
    if (verdict.startsWith("REJECTED")) rejected += 1;
    verdicts.push([p.name, verdict]);
  }
  for (const name of unset) {
    const fatal = report.fatal.find((line) => line.startsWith(`${name}:`));
    if (fatal) rejected += 1;
    verdicts.push([
      `${name} (unset)`,
      fatal
        ? `REJECTED, would refuse boot: ${fatal.slice(name.length + 2)}`
        : "removed (see Features for what that switches off)",
    ]);
  }

  // ---- features that change, or that the proposal touches
  const touched = new Set([...proposed.map((p) => p.name), ...unset]);
  const changes: [FeatureId, string][] = [];
  let degradedTouched = 0;
  for (const status of report.features) {
    const was = before.features.find((f) => f.id === status.id);
    const vars = FEATURES[status.id].vars as readonly string[];
    const isTouched = vars.some((v) => touched.has(v));
    const changed = was?.state !== status.state || was?.detail !== status.detail;
    if (!isTouched && !changed) continue;
    if (status.state === "degraded") degradedTouched += 1;
    const arrow =
      was?.state === status.state && was.detail === status.detail
        ? `${stateLine(status)} (unchanged)`
        : `${stateLine(was)} → ${stateLine(status)}`;
    changes.push([status.id, arrow]);
  }

  // ---- key files on their own
  const fileLines: string[] = [];
  for (const file of keyFiles) {
    if (!existsSync(file)) {
      fileLines.push(`${file}: no such file`);
      rejected += 1;
      continue;
    }
    const inspected = inspectP8(readFileSync(file, "utf8"));
    const id = keyIdFromFile(file);
    if (!inspected.ok) {
      fileLines.push(`${basename(file)}: ${inspected.problem}`);
      rejected += 1;
      continue;
    }
    const same = proposed
      .filter((p) => p.name in KEY_ID_OF)
      .filter((p) => {
        const other = inspectP8(p.value);
        return other.ok && other.spki === inspected.spki;
      })
      .map((p) => p.name);
    fileLines.push(
      `${basename(file)}: EC P-256 private key` +
        (id ? `, key id ${id} (from its name)` : "") +
        (same.length ? `; the same key as proposed ${same.join(", ")}` : ""),
    );
  }

  // ---- live probes against Apple
  const liveLines: string[] = [];
  let liveFailed = 0;
  if (flags.live) {
    const value = (name: string) =>
      afterUnchecked.has(name) || after[name] === undefined ? undefined : after[name]!.trim();
    const probe = async (
      label: string,
      names: string[],
      run: (v: string[]) => Promise<string | null>,
    ) => {
      if (!names.some((n) => touched.has(n))) return;
      const values = names.map(value);
      if (values.some((v) => v === undefined)) {
        liveLines.push(`${label}: skipped — needs ${names.join(", ")} in the proposal`);
        return;
      }
      try {
        const problem = await run(values as string[]);
        if (problem) liveFailed += 1;
        liveLines.push(`${label}: ${problem ?? "Apple accepted the key"}`);
      } catch (err) {
        liveFailed += 1;
        liveLines.push(`${label}: couldn't ask Apple (${String(err).split("\n")[0]})`);
      }
    };
    await probe("apple_maps", ["APPLE_MAPS_KEY", "APPLE_MAPS_KEY_ID", "APPLE_MAPS_TEAM_ID"], (v) =>
      probeMaps(after["APPLE_MAPS_KEY"]!, v[1]!, v[2]!),
    );
    await probe(
      "apple_signin_revoke",
      ["APPLE_SIGNIN_KEY", "APPLE_SIGNIN_KEY_ID", "APPLE_SIGNIN_TEAM_ID"],
      (v) =>
        probeSignIn(
          after["APPLE_SIGNIN_KEY"]!,
          v[1]!,
          v[2]!,
          value("APPLE_AUDIENCE") ?? DEFAULT_APPLE_AUDIENCE,
        ),
    );
    if (touched.has("APNS_KEY")) {
      liveLines.push(
        "push: not checked live (APNs needs a device); after deploy, POST /admin/push-test checks it",
      );
    }
  }

  // ---- print
  const width = Math.max(0, ...verdicts.map(([n]) => n.length));
  const out: string[] = [];
  out.push(`Checked against ${baseLabel}.`, "");
  if (verdicts.length) {
    out.push("Settings:");
    for (const [name, verdict] of verdicts) out.push(`  ${name.padEnd(width)}  ${verdict}`);
    out.push("");
  }
  if (fileLines.length) {
    out.push("Key files:", ...fileLines.map((l) => `  ${l}`), "");
  }
  if (changes.length) {
    const w = Math.max(...changes.map(([id]) => id.length));
    out.push("Features:");
    for (const [id, arrow] of changes) out.push(`  ${id.padEnd(w)}  ${arrow}`);
    out.push("");
  }
  const newWarnings = report.warnings.filter((w) => !before.warnings.includes(w));
  if (newWarnings.length) {
    out.push("Warnings:", ...newWarnings.map((w) => `  - ${w}`), "");
  }
  const newFatal = report.fatal.filter((f) => !before.fatal.includes(f));
  if (newFatal.length) {
    out.push("Would refuse to boot:", ...newFatal.map((f) => `  - ${f}`), "");
  }
  if (liveLines.length) {
    out.push("Live (--live):", ...liveLines.map((l) => `  ${l}`), "");
  }

  const ok = rejected === 0 && newFatal.length === 0 && degradedTouched === 0 && liveFailed === 0;
  const app = flags["no-app"] || flags["env-file"] ? "parkagent-api" : flags.app;
  if (ok) {
    out.push("Result: OK to set.");
    if (proposed.length) {
      out.push(`  fly secrets set -a ${app} ${proposed.map(shown).join(" ")}`);
      if (proposed.some((p) => SECRET.has(p.name) && !p.file)) {
        out.push("  (secret values are shortened above; paste your own)");
      }
    }
    if (unset.size) out.push(`  fly secrets unset -a ${app} ${[...unset].join(" ")}`);
  } else {
    out.push(
      "Result: NOT OK. Fix what's marked above first" +
        (degradedTouched ? "; a degraded feature is off on the server until it's fixed" : "") +
        ".",
    );
  }
  console.log(out.join("\n"));
  return ok ? 0 : 1;
}

process.exitCode = await main();
