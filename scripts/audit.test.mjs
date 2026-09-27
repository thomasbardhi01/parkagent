// Tests for the audit gate's rules (scripts/audit.mjs):
//   node --test scripts/audit.test.mjs
// The reports below have the shape `pnpm audit --json` prints (pnpm 12),
// trimmed from a real run against prisma's lodash / deepmerge-ts / mysql2.

import assert from "node:assert/strict";
import { test } from "node:test";

import { checkAllowlist, evaluate } from "./audit.mjs";

const TODAY = "2026-09-27";

function advisory(ghsa, pkg, severity, path) {
  return {
    id: Number.parseInt(ghsa.replace(/\D/g, "").slice(0, 7), 10),
    github_advisory_id: ghsa,
    module_name: pkg,
    severity,
    title: `${pkg} is vulnerable`,
    url: `https://github.com/advisories/${ghsa}`,
    patched_versions: ">=9.9.9",
    vulnerable_versions: "<9.9.9",
    findings: [{ version: "1.0.0", paths: [path] }],
  };
}

function report(...advisories) {
  return { advisories: Object.fromEntries(advisories.map((a) => [String(a.id), a])), metadata: {} };
}

const LODASH_HIGH = advisory(
  "GHSA-r5fr-rjxr-66jc",
  "lodash",
  "high",
  "server>prisma>@prisma/studio-core>@visx/shape>lodash",
);
const LODASH_MODERATE = advisory(
  "GHSA-f23m-r3pf-42rh",
  "lodash",
  "moderate",
  "server>prisma>@prisma/studio-core>@visx/shape>lodash",
);
const DEV_CRITICAL = advisory(
  "GHSA-w3rx-r6r6-pgpr",
  "image-size",
  "critical",
  "server>vitest>vite>image-size",
);
const PROD_CRITICAL = advisory("GHSA-3f6p-5ww8-9rcr", "mysql2", "critical", "server>prisma>mysql2");

const accept = (over = {}) => ({
  id: "GHSA-r5fr-rjxr-66jc",
  package: "lodash",
  reason: "Only Prisma Studio's charts load it; the server never starts Studio.",
  expires: "2026-11-26",
  ...over,
});

test("a high or critical advisory in a production dependency blocks", () => {
  const full = report(LODASH_HIGH, PROD_CRITICAL);
  const v = evaluate(full, full, { accepted: [] }, TODAY);
  assert.deepEqual(v.blocking.map((r) => r.pkg).sort(), ["lodash", "mysql2"]);
  assert.deepEqual(v.problems, []);
});

test("moderate and low production advisories are reported, not blocking", () => {
  const full = report(LODASH_MODERATE);
  const v = evaluate(full, full, { accepted: [] }, TODAY);
  assert.equal(v.blocking.length, 0);
  assert.equal(v.all[0].scope, "prod");
});

test("a dev-only advisory never blocks, whatever its severity", () => {
  // In the full report, absent from --prod: it arrives through devDependencies alone.
  const v = evaluate(report(DEV_CRITICAL), report(), { accepted: [] }, TODAY);
  assert.equal(v.blocking.length, 0);
  assert.equal(v.all[0].scope, "dev");
});

test("an allowlisted production advisory is accepted until its expiry", () => {
  const full = report(LODASH_HIGH);
  const v = evaluate(full, full, { accepted: [accept()] }, TODAY);
  assert.equal(v.blocking.length, 0);
  assert.equal(v.all[0].acceptedBy.expires, "2026-11-26");
});

test("an expired allowlist entry fails the audit and stops accepting", () => {
  const full = report(LODASH_HIGH);
  const v = evaluate(full, full, { accepted: [accept({ expires: "2026-09-26" })] }, TODAY);
  assert.equal(v.blocking.length, 1);
  assert.match(v.problems[0], /expired on 2026-09-26/);
});

test("an entry accepts only its own advisory and package", () => {
  const full = report(LODASH_HIGH, PROD_CRITICAL);
  const v = evaluate(full, full, { accepted: [accept()] }, TODAY);
  assert.deepEqual(
    v.blocking.map((r) => r.pkg),
    ["mysql2"],
  );
  const wrongPackage = evaluate(full, full, { accepted: [accept({ package: "mysql2" })] }, TODAY);
  assert.equal(wrongPackage.blocking.length, 2);
});

test("an entry that matches nothing any more is flagged stale, not failed", () => {
  const v = evaluate(report(), report(), { accepted: [accept()] }, TODAY);
  assert.equal(v.blocking.length, 0);
  assert.deepEqual(v.problems, []);
  assert.deepEqual(
    v.stale.map((e) => e.id),
    ["GHSA-r5fr-rjxr-66jc"],
  );
});

test("every entry needs a GHSA id, the package, a real reason, and a date", () => {
  const { problems } = checkAllowlist(
    {
      accepted: [
        accept({ id: "CVE-2026-1234" }),
        accept({ package: "" }),
        accept({ reason: "fine" }),
        accept({ expires: "next month" }),
        "not an object",
      ],
    },
    TODAY,
  );
  assert.equal(problems.length, 5);
  assert.match(problems[0], /GHSA id/);
  assert.match(problems[1], /package is required/);
  assert.match(problems[2], /reason must say why/);
  assert.match(problems[3], /YYYY-MM-DD/);
  assert.match(problems[4], /not an object/);
  assert.deepEqual(checkAllowlist({}, TODAY).problems, [
    "audit-allowlist.json needs an `accepted` array",
  ]);
});
