// The "Nightly audit" issue's body, from GET /admin/audit's answer:
// `node fr/audit-issue.mjs audit.json [run-url] > audit.md`. Used by the
// nightly-fr workflow, which posts it with the workflow's own token.

import { readFileSync } from "node:fs";

const [file, runUrl] = process.argv.slice(2);
const audit = JSON.parse(readFileSync(file, "utf8"));
const day = audit.window.from.slice(0, 10);
const fired = audit.findings.filter((f) => f.count > 0);

const out = [];
out.push(`### Nightly audit, ${audit.window.from} to ${audit.window.to}`);
out.push("");
for (const line of audit.summary.lines) out.push(`> ${line}`);
out.push("");
out.push(
  `Summary: ${audit.summary.source}${audit.summary.reason ? ` (${audit.summary.reason})` : ""}. ` +
    `${fired.length} of ${audit.findings.length} invariants fired.`,
);
out.push("");
out.push("| Invariant | Severity | Count | Examples |");
out.push("|---|---|---|---|");
for (const f of audit.findings) {
  const examples = f.examples.map((id) => `\`${id}\``).join(" ");
  out.push(`| \`${f.invariant}\` | ${f.severity} | ${f.count} | ${examples} |`);
}
out.push("");
out.push(
  `Look at one with \`GET /admin/parks/<id>/trace\` (a park id) or the session's decisions. ` +
    `Report-only: the audit changes nothing.${runUrl ? ` Run: ${runUrl}` : ""} (${day})`,
);
process.stdout.write(`${out.join("\n")}\n`);
