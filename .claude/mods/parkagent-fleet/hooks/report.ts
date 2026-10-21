import { atom, read, update } from "claude-code";
import type { On } from "claude-code";

import { type Engine } from "./shared";

// report.ts — /report [note] sends {from, branch, pr, ci, note} to the session
// named by the coordSession setting (default "coord") via $.session.send. In
// that session, session.receive stores the reports and the band shows
// "N reports" until /fleet is opened.

export type ReportRow = {
  from: string;
  branch: string;
  pr: number | null;
  ci: string;
  note: string;
  at: number;
};

/** Reports this (coordinator) session has received, newest first. */
export const reports = atom(
  { plugin: "parkagent-fleet", key: "reports" } as const,
  [] as ReportRow[],
);
/** How many of them are unread — the band shows this until /fleet is opened. */
export const unreadReports = atom({ plugin: "parkagent-fleet", key: "unreadReports" } as const, 0);

/** Marks a fleet report on the wire, so the coordinator only stores ours. */
const MARKER = "\u0001parkagent-fleet-report\u0001";

/** One line from `statusCheckRollup` as gh reports it. */
type CheckRun = { status?: string; conclusion?: string };

/** Roll a PR's checks up to one word. */
export function ciSummary(rollup: readonly CheckRun[] | null | undefined): string {
  if (!rollup || rollup.length === 0) return "no checks";
  if (rollup.some((c) => (c.conclusion ?? "").toUpperCase() === "FAILURE")) return "failing";
  if (rollup.some((c) => (c.status ?? "").toUpperCase() !== "COMPLETED")) return "running";

  return "green";
}

/** The current branch's PR number and CI word, read with gh (null when none). */
async function prStatus($: Engine, cwd: string): Promise<{ pr: number | null; ci: string }> {
  try {
    const ran = await $.process.run(["gh", "pr", "view", "--json", "number,statusCheckRollup"], {
      cwd,
      timeoutMs: 15_000,
    });
    if (ran.exitCode !== 0) return { pr: null, ci: "no PR" };
    const parsed = JSON.parse(ran.stdout) as { number?: number; statusCheckRollup?: CheckRun[] };

    return { pr: parsed.number ?? null, ci: ciSummary(parsed.statusCheckRollup) };
  } catch {
    return { pr: null, ci: "unknown" };
  }
}

function parseReport(text: string): ReportRow | null {
  const i = text.indexOf(MARKER);
  if (i === -1) return null;
  try {
    const o = JSON.parse(text.slice(i + MARKER.length)) as Partial<ReportRow>;
    if (typeof o.from !== "string" || typeof o.branch !== "string") return null;

    return {
      from: o.from,
      branch: o.branch,
      pr: typeof o.pr === "number" ? o.pr : null,
      ci: typeof o.ci === "string" ? o.ci : "?",
      note: typeof o.note === "string" ? o.note : "",
      at: typeof o.at === "number" ? o.at : 0,
    };
  } catch {
    return null;
  }
}

/** Unread report count (the band reads this). */
export async function unreadCount($: Engine): Promise<number> {
  return read($, unreadReports);
}

/** The stored reports, newest first (the pane reads this). */
export async function recentReports($: Engine): Promise<ReportRow[]> {
  return read($, reports);
}

/** Mark reports read — the band's count clears when /fleet opens. */
export async function markReportsRead($: Engine): Promise<void> {
  await update($, unreadReports, () => 0);
}

export function registerReport(on: On, coordName: string): void {
  on("command.run", { command: "report" }, async ($, e) => {
    const note = e.args.trim();
    const [id, cwd, now] = await Promise.all([$.session.id(), $.session.cwd(), $.clock.now()]);
    let branch = "?";
    try {
      const ran = await $.process.run(["git", "-C", cwd, "branch", "--show-current"], {
        timeoutMs: 3_000,
      });
      if (ran.exitCode === 0) branch = ran.stdout.trim() || "detached";
    } catch {
      // '?' is fine
    }
    const { pr, ci } = await prStatus($, cwd);
    const row: ReportRow = { from: id, branch, pr, ci, note, at: now };
    const { isDelivered, reason } = await $.session.send({
      to: coordName,
      text: MARKER + JSON.stringify(row),
    });
    if (!isDelivered) {
      return {
        text: `Couldn't reach a "${coordName}" session (${reason}). /report goes to the session named "${coordName}" — set a different one in pluginConfigs."parkagent-fleet".options.coordSession.`,
      };
    }

    return {
      text: `Reported to ${coordName}: ${branch}${pr !== null ? ` · PR #${pr} (${ci})` : ` · ${ci}`}${note !== "" ? ` · ${note}` : ""}.`,
    };
  });

  // On the coordinator: store an incoming report and bump the unread count,
  // and consume it so the raw line never reaches that session's model.
  on("session.receive", async ($, e, next) => {
    const row = parseReport(e.text);
    if (row === null) return next(e);
    await update($, reports, (rs) => [row, ...rs].slice(0, 50));
    await update($, unreadReports, (n) => n + 1);

    return { consumed: "stored as a parkagent-fleet report" };
  });
}
