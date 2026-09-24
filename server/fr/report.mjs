/**
 * Turn the FR suite's vitest JSON output into the nightly report:
 *
 *   node fr/report.mjs fr-report.json fr-summary.md
 *
 * Groups results by FR id (the FR-\d+ tags in test names), writes a
 * markdown summary (uploaded as the run artifact and appended to the
 * GitHub step summary), and prints the failed-FR list on stdout for the
 * issue body. Exits 0 always — reporting must not mask or replace the
 * test step's own exit code.
 */

import { readFileSync, writeFileSync } from "node:fs";

const [, , inputPath = "fr-report.json", outputPath = "fr-summary.md"] = process.argv;

let raw;
try {
  raw = JSON.parse(readFileSync(inputPath, "utf8"));
} catch (err) {
  writeFileSync(outputPath, `# Nightly FR report\n\nCould not read ${inputPath}: ${err}\n`);
  console.log("(no report — the FR suite likely failed before writing results)");
  process.exit(0);
}

const rows = [];
for (const file of raw.testResults ?? []) {
  for (const test of file.assertionResults ?? []) {
    const name = test.fullName ?? test.title ?? "";
    const frIds = [...new Set(name.match(/FR-\d+/g) ?? ["untagged"])];
    rows.push({
      frIds,
      name,
      status: test.status,
      failure: (test.failureMessages ?? []).join("\n").slice(0, 1500),
    });
  }
}

const byFr = new Map();
for (const row of rows) {
  for (const fr of row.frIds) {
    if (!byFr.has(fr)) byFr.set(fr, []);
    byFr.get(fr).push(row);
  }
}

const frOrder = [...byFr.keys()].sort((a, b) => {
  const na = Number(a.replace("FR-", "")) || 1e9;
  const nb = Number(b.replace("FR-", "")) || 1e9;
  return na - nb;
});

const icon = (s) => (s === "passed" ? "✅" : s === "failed" ? "❌" : "⏭️");
const failed = rows.filter((r) => r.status === "failed");
const skipped = rows.filter((r) => r.status !== "passed" && r.status !== "failed");

let md = `# Nightly FR report\n\n`;
md += `**${rows.length}** tests — **${rows.length - failed.length - skipped.length}** passed, `;
md += `**${failed.length}** failed, **${skipped.length}** skipped.\n\n`;
md += `| FR | Result | Tests |\n|---|---|---|\n`;
for (const fr of frOrder) {
  const tests = byFr.get(fr);
  const worst = tests.some((t) => t.status === "failed")
    ? "failed"
    : tests.every((t) => t.status !== "passed")
      ? "skipped"
      : "passed";
  md += `| ${fr} | ${icon(worst)} ${worst} | ${tests.map((t) => icon(t.status)).join(" ")} |\n`;
}
if (failed.length > 0) {
  md += `\n## Failures\n`;
  for (const row of failed) {
    md += `\n### ${row.frIds.join(", ")} — ${row.name}\n\n\`\`\`\n${row.failure}\n\`\`\`\n`;
  }
}
if (skipped.length > 0) {
  md += `\n## Skipped\n\n${skipped.map((r) => `- ${r.name}`).join("\n")}\n`;
}
writeFileSync(outputPath, md);

// stdout: the failed-FR digest the workflow drops into the issue body.
if (failed.length === 0) {
  console.log("All FR tests passed.");
} else {
  const frs = [...new Set(failed.flatMap((r) => r.frIds))].join(", ");
  console.log(`Failing: ${frs}`);
  for (const row of failed) console.log(`- ${row.name}`);
}
