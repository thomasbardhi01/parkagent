#!/usr/bin/env node
// The dependency audit gate (.github/workflows/supply-chain.yml).
//
//   node scripts/audit.mjs
//
// Runs `pnpm audit` over the whole workspace lockfile twice, all
// dependencies and production-only, and:
//   - FAILS on a high or critical advisory in a production dependency,
//     unless scripts/audit-allowlist.json accepts it;
//   - reports everything else (production moderate/low, and every
//     dev-only advisory) without failing;
//   - FAILS on an allowlist entry that is malformed or past its expiry,
//     so an accepted risk is re-decided, never forgotten.
//
// A production dependency is one `pnpm audit --prod` reports; an advisory
// only the full audit reports reaches us through devDependencies alone.
// AUDIT_FULL_JSON / AUDIT_PROD_JSON read saved `pnpm audit --json` output
// instead of running pnpm (the tests in audit.test.mjs).

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BLOCKING = new Set(["high", "critical"]);
const GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;

/** `pnpm audit --json`, parsed. It exits 1 when it finds anything, so
 * the exit code says nothing; a missing `advisories` object does. */
function runAudit(prodOnly) {
  const args = ["audit", "--json", ...(prodOnly ? ["--prod"] : [])];
  for (let attempt = 1; ; attempt += 1) {
    let out = "";
    try {
      out = execFileSync("pnpm", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
    } catch (err) {
      out = String(err.stdout ?? "");
    }
    try {
      const parsed = JSON.parse(out);
      if (parsed && typeof parsed.advisories === "object") return parsed;
    } catch {
      // fall through to the retry / error below
    }
    // The registry's audit endpoint is a network call: one retry.
    if (attempt === 2) {
      throw new Error(`pnpm ${args.join(" ")} gave no report:\n${out.slice(0, 2000)}`);
    }
  }
}

function load(envName, prodOnly) {
  const path = process.env[envName];
  return path ? JSON.parse(readFileSync(path, "utf8")) : runAudit(prodOnly);
}

/** One row per advisory × package: {id, pkg, severity, title, url, paths, versions}. */
export function rows(report) {
  return Object.values(report.advisories ?? {}).map((a) => ({
    id: a.github_advisory_id ?? `npm-${a.id}`,
    pkg: a.module_name,
    severity: a.severity,
    title: a.title,
    url: a.url,
    patched: a.patched_versions,
    versions: [...new Set((a.findings ?? []).map((f) => f.version))],
    paths: [...new Set((a.findings ?? []).flatMap((f) => f.paths ?? []))],
  }));
}

/** The allowlist, checked: every entry needs an advisory id, the package,
 * a reason, and an ISO expiry date. Returns {entries, problems}. */
export function checkAllowlist(list, today) {
  const problems = [];
  const entries = [];
  if (!list || !Array.isArray(list.accepted)) {
    return { entries, problems: ["audit-allowlist.json needs an `accepted` array"] };
  }
  for (const [i, e] of list.accepted.entries()) {
    const where = `accepted[${i}]${e && e.id ? ` (${e.id})` : ""}`;
    if (!e || typeof e !== "object") {
      problems.push(`${where}: not an object`);
      continue;
    }
    if (typeof e.id !== "string" || !GHSA.test(e.id))
      problems.push(`${where}: id must be a GHSA id`);
    if (typeof e.package !== "string" || e.package === "")
      problems.push(`${where}: package is required`);
    if (typeof e.reason !== "string" || e.reason.trim().length < 20) {
      problems.push(`${where}: reason must say why it's acceptable (20+ characters)`);
    }
    if (
      typeof e.expires !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(e.expires) ||
      Number.isNaN(Date.parse(e.expires))
    ) {
      problems.push(`${where}: expires must be a YYYY-MM-DD date`);
    } else if (e.expires < today) {
      problems.push(
        `${where}: expired on ${e.expires} — re-decide it: fix, or renew with a reason`,
      );
    }
    entries.push(e);
  }
  return { entries, problems };
}

/** The verdict, from both reports and the allowlist. Pure. */
export function evaluate(full, prod, allowlist, today) {
  const prodKeys = new Set(rows(prod).map((r) => `${r.id} ${r.pkg}`));
  const { entries, problems } = checkAllowlist(allowlist, today);
  const live = entries.filter((e) => typeof e.expires === "string" && e.expires >= today);
  const accepted = (r) => live.find((e) => e.id === r.id && e.package === r.pkg);
  const all = rows(full).map((r) => ({
    ...r,
    scope: prodKeys.has(`${r.id} ${r.pkg}`) ? "prod" : "dev",
    acceptedBy: accepted(r) ?? null,
  }));
  // A --prod finding the full report lacks can't happen, but never hide one.
  for (const r of rows(prod)) {
    if (!all.some((a) => a.id === r.id && a.pkg === r.pkg)) {
      all.push({ ...r, scope: "prod", acceptedBy: accepted(r) ?? null });
    }
  }
  const blocking = all.filter(
    (r) => r.scope === "prod" && BLOCKING.has(r.severity) && !r.acceptedBy,
  );
  const stale = entries.filter((e) => !all.some((r) => r.id === e.id && r.pkg === e.package));
  return { all, blocking, problems, stale };
}

function table(rs) {
  const lines = ["| Severity | Package | Advisory | Scope | Status |", "|---|---|---|---|---|"];
  for (const r of rs) {
    const status = r.acceptedBy
      ? `accepted until ${r.acceptedBy.expires}: ${r.acceptedBy.reason}`
      : r.scope === "prod" && BLOCKING.has(r.severity)
        ? "**blocking**"
        : "reported";
    lines.push(
      `| ${r.severity} | ${r.pkg}@${r.versions.join(",")} | [${r.id}](${r.url}) ${r.title} | ${r.scope} | ${status} |`,
    );
  }
  return lines.join("\n");
}

function main() {
  const today = new Date().toISOString().slice(0, 10);
  const allowlist = JSON.parse(
    readFileSync(new URL("audit-allowlist.json", import.meta.url), "utf8"),
  );
  const verdict = evaluate(
    load("AUDIT_FULL_JSON", false),
    load("AUDIT_PROD_JSON", true),
    allowlist,
    today,
  );
  const order = { critical: 0, high: 1, moderate: 2, low: 3, info: 4 };
  const sorted = verdict.all.sort(
    (a, b) =>
      (a.scope === b.scope ? 0 : a.scope === "prod" ? -1 : 1) ||
      order[a.severity] - order[b.severity],
  );

  let md = "## Dependency audit\n\n";
  md += sorted.length === 0 ? "No known advisories in the lockfile.\n" : `${table(sorted)}\n`;
  if (verdict.stale.length > 0) {
    md += `\nAllowlist entries that match nothing any more (remove them): ${verdict.stale.map((e) => `${e.id} ${e.package}`).join(", ")}\n`;
  }
  if (verdict.problems.length > 0)
    md += `\nAllowlist problems:\n${verdict.problems.map((p) => `- ${p}`).join("\n")}\n`;
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  for (const r of sorted.filter((x) => x.scope === "dev")) {
    console.log(
      `::notice title=dev-only advisory::${r.severity} ${r.pkg} ${r.id} (${r.paths[0] ?? "?"}) — reported, not failing`,
    );
  }
  for (const r of verdict.blocking) {
    console.log(
      `::error title=${r.severity} advisory in production::${r.pkg} ${r.id}: ${r.title} — patched ${r.patched}. Fix it, or accept it in scripts/audit-allowlist.json with a reason and an expiry.`,
    );
  }
  for (const p of verdict.problems) console.log(`::error title=audit allowlist::${p}`);
  return verdict.blocking.length > 0 || verdict.problems.length > 0 ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
