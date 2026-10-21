import { atom, read, update } from "claude-code";
import type { Register } from "claude-code";

import type { CiRun, ContextBand, FleetRow, NightlyRun, ProdHealth, PrRow } from "../types";
import { type Engine } from "./shared";
import { isRouting, registerRoute, routeOnComplete, routeOnSubmit } from "./route";
import { isLean, registerLean } from "./lean";
import { ciSummary, markReportsRead, recentReports, registerReport, unreadCount } from "./report";

const PANE = "parkagent-fleet";
const STORE_PREFIX = "fleet:";
const STALE_MS = 6 * 60 * 60 * 1000; // a session not heard from in 6 h drops off the pane
const REFRESH_MS = 60_000; // while the /fleet pane is open
const IDLE_REFRESH_MS = 5 * 60_000; // otherwise: a heartbeat and the sweep, no gh
const HEALTH_MS = 5 * 60_000; // prod /health, at most this often, only while the pane is open
const WARN_PERCENT = 75;
const CI_LIMIT = 6;
const HEALTH_URL = "https://parkagent-api.fly.dev/health";

const me = atom({ plugin: "parkagent-fleet", key: "me" } as const, null);
const fleetRows = atom({ plugin: "parkagent-fleet", key: "fleet" } as const, []);
const ci = atom({ plugin: "parkagent-fleet", key: "ci" } as const, null);
const isHidden = atom({ plugin: "parkagent-fleet", key: "isHidden" } as const, false);
const band = atom({ plugin: "parkagent-fleet", key: "band" } as const, "ok");
const prs = atom({ plugin: "parkagent-fleet", key: "prs" } as const, null);
const nightly = atom({ plugin: "parkagent-fleet", key: "nightly" } as const, null);
const health = atom({ plugin: "parkagent-fleet", key: "health" } as const, null);

const pct = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n)}%`);
const usd = (n: number | null | undefined) => (n == null ? "—" : `$${n.toFixed(2)}`);

/** Aborted by /fleet, so a loop asleep for the idle period takes up the
 * pane's pace at once. */
let wake = new AbortController();
/** The session that ended; a publish still in flight must not re-add it. */
let endedSessionId: string | null = null;
/** When prod /health was last fetched, so the pane polls it at most every 5 min. */
let lastHealthAt = 0;

/** A background step that failed goes to the debug log, not a toast. */
const logFailure = ($: Engine, what: string) => (err: unknown) =>
  $.ui.log(`parkagent-fleet: ${what} failed: ${err instanceof Error ? err.message : String(err)}`, {
    to: "debug",
  });

/** Read this session's figures and publish them for the other sessions. */
async function publish($: Engine, lastPrompt: string | undefined): Promise<FleetRow> {
  const [id, cwd, model, turns, usage, now] = await Promise.all([
    $.session.id(),
    $.session.cwd(),
    $.session.model(),
    $.session.turns(),
    $.session.usage(),
    $.clock.now(),
  ]);
  const limit = (kind: string) =>
    usage.rateLimits.find((l) => l.kind === kind)?.percentUsed ?? null;

  let branch = "?";
  try {
    const ran = await $.process.run(["git", "-C", cwd, "branch", "--show-current"], {
      timeoutMs: 3_000,
    });
    if (ran.exitCode === 0) branch = ran.stdout.trim() || "detached";
  } catch {
    // no git here; '?' is fine
  }

  const prior = await read($, me);
  const row: FleetRow = {
    sessionId: id,
    cwd,
    branch,
    model,
    contextPercent: usage.context.percent ?? null,
    fiveHourPercent: limit("five_hour"),
    sevenDayPercent: limit("seven_day"),
    costUsd: usage.cost?.usd ?? null,
    turns,
    lastPrompt: (lastPrompt ?? prior?.lastPrompt ?? "").slice(0, 80),
    updatedAt: now,
  };
  await update($, me, () => row);
  if (id !== endedSessionId) await $.store.set(`${STORE_PREFIX}${id}`, row);

  return row;
}

/** The status line, and a toast when context crosses WARN_PERCENT: once per
 * crossing, not every turn. The band lives in `$.state` so it outlasts a reload. */
async function report($: Engine, row: FleetRow): Promise<void> {
  $.ui.status(
    `ctx ${pct(row.contextPercent)} · 5h ${pct(row.fiveHourPercent)} · ${usd(row.costUsd)}`,
  );
  const now: ContextBand = (row.contextPercent ?? 0) >= WARN_PERCENT ? "hot" : "ok";
  let crossed = false;
  // update retries on a concurrent write, so of two reports racing only one sees the crossing.
  await update($, band, (was) => {
    crossed = was !== "hot" && now === "hot";
    return now;
  });
  if (crossed) {
    $.ui.toast(
      `Context at ${pct(row.contextPercent)} — /compact soon, or hand off to a fresh session.`,
    );
  }
}

/** Every other session's last reading, newest first; rows older than STALE_MS
 * are deleted from the store. The loop runs it, never the pane's drawing. */
async function sweep($: Engine): Promise<FleetRow[]> {
  const [keys, now] = await Promise.all([$.store.keys(), $.clock.now()]);
  const rows: FleetRow[] = [];
  for (const key of keys) {
    if (!key.startsWith(STORE_PREFIX)) continue;
    const row = (await $.store.get(key)) as FleetRow | undefined;
    if (!row || typeof row.updatedAt !== "number") continue;
    if (now - row.updatedAt > STALE_MS) {
      await $.store.delete(key);
      continue;
    }
    rows.push(row);
  }

  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The repo's latest CI runs through gh; null when gh is absent or signed out. */
async function ciRuns($: Engine): Promise<CiRun[] | null> {
  try {
    const cwd = await $.session.cwd();
    const ran = await $.process.run(
      [
        "gh",
        "run",
        "list",
        "--limit",
        String(CI_LIMIT),
        "--json",
        "status,conclusion,name,headBranch,createdAt",
      ],
      { cwd, timeoutMs: 15_000 },
    );
    if (ran.exitCode !== 0) return null;
    const now = await $.clock.now();
    const parsed = JSON.parse(ran.stdout) as Array<{
      status: string;
      conclusion: string;
      name: string;
      headBranch: string;
      createdAt: string;
    }>;

    return parsed.map((r) => {
      const mins = Math.max(0, Math.round((now - Date.parse(r.createdAt)) / 60_000));
      const age =
        mins < 60
          ? `${mins}m`
          : mins < 60 * 48
            ? `${Math.round(mins / 60)}h`
            : `${Math.round(mins / 1440)}d`;

      return {
        status: r.status,
        conclusion: r.conclusion || r.status,
        name: r.name,
        branch: r.headBranch,
        age,
      };
    });
  } catch {
    return null;
  }
}

/** Open PRs with their rolled-up CI word; null when gh is absent or signed out. */
async function prList($: Engine): Promise<PrRow[] | null> {
  try {
    const cwd = await $.session.cwd();
    const ran = await $.process.run(
      ["gh", "pr", "list", "--json", "number,title,headRefName,statusCheckRollup"],
      { cwd, timeoutMs: 15_000 },
    );
    if (ran.exitCode !== 0) return null;
    const parsed = JSON.parse(ran.stdout) as Array<{
      number: number;
      title: string;
      headRefName: string;
      statusCheckRollup?: Array<{ status?: string; conclusion?: string }>;
    }>;

    return parsed
      .filter((p) => typeof p.number === "number" && typeof p.headRefName === "string")
      .map((p) => ({
        number: p.number,
        title: p.title ?? "",
        branch: p.headRefName,
        ci: ciSummary(p.statusCheckRollup),
      }));
  } catch {
    return null;
  }
}

/** The last nightly-fr run and its age; null when gh can't say. */
async function nightlyRun($: Engine): Promise<NightlyRun | null> {
  try {
    const cwd = await $.session.cwd();
    const ran = await $.process.run(
      [
        "gh",
        "run",
        "list",
        "--workflow=nightly-fr.yml",
        "--limit",
        "1",
        "--json",
        "status,conclusion,createdAt",
      ],
      { cwd, timeoutMs: 15_000 },
    );
    if (ran.exitCode !== 0) return null;
    const parsed = JSON.parse(ran.stdout) as Array<{
      status: string;
      conclusion: string;
      createdAt: string;
    }>;
    const r = parsed[0];
    if (r === undefined) return { status: "none", conclusion: "none", age: "—" };
    const mins = Math.max(
      0,
      Math.round(((await $.clock.now()) - Date.parse(r.createdAt)) / 60_000),
    );
    const age =
      mins < 60
        ? `${mins}m`
        : mins < 60 * 48
          ? `${Math.round(mins / 60)}h`
          : `${Math.round(mins / 1440)}d`;

    return { status: r.status, conclusion: r.conclusion || r.status, age };
  } catch {
    return null;
  }
}

/** Prod /health through the host; null when it can't be read. */
async function prodHealth($: Engine): Promise<ProdHealth | null> {
  try {
    const res = await $.http.fetch(HEALTH_URL, { method: "GET" });
    if (!res.ok) return { ok: false, degraded: [], commit: null, error: `HTTP ${res.status}` };
    const body = JSON.parse(res.text) as { degraded?: string[]; commit?: string };

    return {
      ok: true,
      degraded: Array.isArray(body.degraded) ? body.degraded : [],
      commit: body.commit ?? null,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      degraded: [],
      commit: null,
      error: err instanceof Error ? err.message : "unreachable",
    };
  }
}

/** The pane's data: fleet + CI, and — throttled — PRs, nightly and prod health. */
async function refreshPane($: Engine): Promise<void> {
  const rows = await sweep($);
  await update($, fleetRows, () => rows);
  const runs = await ciRuns($);
  await update($, ci, () => runs);
  const [openPrs, lastNightly] = await Promise.all([prList($), nightlyRun($)]);
  await update($, prs, () => openPrs);
  await update($, nightly, () => lastNightly);
  const now = await $.clock.now();
  if (now - lastHealthAt >= HEALTH_MS) {
    lastHealthAt = now;
    const h = await prodHealth($);
    await update($, health, () => h);
  }
}

const isPaneOpen = async ($: Engine) => (await $.ui.panes()).some((pane) => pane.id === PANE);

/** Every 60 s while the /fleet pane is open: republish, sweep, refetch CI.
 * Otherwise every 5 min, and no gh: usage arrives through session.measure. */
async function refreshLoop($: Engine): Promise<void> {
  for (;;) {
    const signal = wake.signal;
    try {
      await $.clock.sleep((await isPaneOpen($)) ? REFRESH_MS : IDLE_REFRESH_MS, { signal });
    } catch {
      if (signal.aborted) continue; // /fleet just refreshed; sleep again at the pane's pace
      return; // the mod was unloaded or reloaded; the new instance starts its own loop
    }
    try {
      await publish($, undefined);
      if (await isPaneOpen($)) {
        await refreshPane($);
      } else {
        const rows = await sweep($);
        await update($, fleetRows, () => rows);
      }
    } catch (err) {
      logFailure($, "refresh")(err); // keep looping; not worth a toast every minute
    }
  }
}

export const register: Register = (on, options) => {
  const coordName =
    typeof options.coordSession === "string" && options.coordSession !== ""
      ? options.coordSession
      : "coord";

  registerRoute(on);
  registerLean(on);
  registerReport(on, coordName);

  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "fleet",
      description:
        "Open the ParkAgent fleet pane: sessions, CI, open PRs, nightly, prod health, reports",
    });
    await $.command.register({
      name: "fleet-band",
      description: "Show or hide the context/limits/cost band above the prompt",
    });
    await $.command.register({
      name: "route",
      description:
        "Route simple read-only turns to haiku: /route off · /route on · /route (status)",
      argumentHint: "off | on | status",
    });
    await $.command.register({
      name: "lean",
      description: "Lean mode: ask new turns for the smallest change that meets the requirement",
      argumentHint: "on | off | status",
    });
    await $.command.register({
      name: "report",
      description: `Send a status report (branch, PR, CI, note) to the "${coordName}" session`,
      argumentHint: "[note]",
    });
    void publish($, undefined).catch(logFailure($, "publish"));
    void refreshLoop($);

    return next(e);
  });

  on("session.end", async ($, e, next) => {
    endedSessionId = e.sessionId;
    try {
      await $.store.delete(`${STORE_PREFIX}${e.sessionId}`);
    } catch {
      // the other sessions' 6 h sweep removes it
    }

    return next(e);
  });

  on("command.run", { command: "fleet" }, async ($) => {
    const { isPlaced } = await $.ui.open({ id: PANE, title: "ParkAgent fleet" });
    await markReportsRead($); // opening the pane marks reports read
    await refreshPane($);
    wake.abort();
    wake = new AbortController();

    return {
      text: isPlaced
        ? "Fleet pane opened."
        : "This surface has no room for a pane; the band above the prompt still shows this session.",
    };
  });

  on("command.run", { command: "fleet-band" }, async ($) => {
    const hidden = await read($, isHidden);
    await update($, isHidden, () => !hidden);

    return { text: hidden ? "Band shown." : "Band hidden. /fleet-band shows it again." };
  });

  on("prompt.submit", async ($, e, next) => {
    // route.ts decides whether this turn runs on haiku and may strip a leading ~.
    const text = await routeOnSubmit($, e);
    void publish($, text).catch(logFailure($, "publish"));

    return next(text !== e.text ? { ...e, text } : e);
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    await routeOnComplete($, e);
    void publish($, undefined)
      .then((row) => report($, row))
      .catch(logFailure($, "publish"));

    return result;
  });

  // Usage is pushed after each turn and when a rate-limit window moves: no polling.
  on("session.measure", async ($, e, next) => {
    const result = await next(e);
    const mine = await read($, me);
    if (mine !== null) {
      const limit = (kind: string) =>
        e.rateLimits.find((l) => l.kind === kind)?.percentUsed ?? null;
      const row: FleetRow = {
        ...mine,
        contextPercent: e.context.percent ?? null,
        fiveHourPercent: limit("five_hour"),
        sevenDayPercent: limit("seven_day"),
        costUsd: e.cost?.usd ?? null,
        updatedAt: await $.clock.now(),
      };
      await update($, me, () => row);
      if (row.sessionId !== endedSessionId) {
        void $.store.set(`${STORE_PREFIX}${row.sessionId}`, row).catch(logFailure($, "publish"));
      }
      await report($, row);
    }

    return result;
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const row = await read($, me);
    if (e.props.hasSurvey || row === null || (await read($, isHidden))) return next(e);

    const { Box, Text } = $.ui.resolve(e);
    const hot = (row.contextPercent ?? 0) >= WARN_PERCENT;
    const [routed, lean, unread] = await Promise.all([isRouting($), isLean($), unreadCount($)]);
    // Suffixes for the route/lean/report features, appended to the one line so
    // the figures above stay where they were.
    const tags =
      (routed ? " · → haiku" : "") +
      (lean ? " · lean" : "") +
      (unread > 0 ? ` · ${unread} report${unread === 1 ? "" : "s"}` : "");

    return (
      <Box>
        <Text color={hot ? "yellow" : undefined} dimColor={!hot}>
          {row.branch} · ctx {pct(row.contextPercent)} · 5h {pct(row.fiveHourPercent)} · 7d{" "}
          {pct(row.sevenDayPercent)} · {usd(row.costUsd)} · {row.turns} turns
          {hot ? " · /compact or hand off" : ""}
          {tags}
        </Text>
      </Box>
    );
  });

  // Draws from $.state only: the loop and /fleet do the store, gh and http work.
  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e);
    const [stored, runs, mine, openPrs, lastNightly, prod, reportRows] = await Promise.all([
      read($, fleetRows),
      read($, ci),
      read($, me),
      read($, prs),
      read($, nightly),
      read($, health),
      recentReports($),
    ]);
    // This session from its live reading, first; the others as the last sweep found them.
    const rows =
      mine === null ? stored : [mine, ...stored.filter((r) => r.sessionId !== mine.sessionId)];
    const branchesHere = new Set(rows.map((r) => r.branch));
    const ciColor = (c: string) => (c === "failing" ? "red" : c === "green" ? "green" : undefined);

    return (
      <Box flexDirection="column">
        <Text bold>Sessions on this machine ({rows.length})</Text>
        {rows.length === 0 && (
          <Text dimColor>None yet. Each session publishes after its first turn.</Text>
        )}
        {rows.map((r) => {
          const isMe = r.sessionId === mine?.sessionId;
          const hot = (r.contextPercent ?? 0) >= WARN_PERCENT;

          return (
            <Box flexDirection="column">
              <Text bold={isMe} color={hot ? "yellow" : undefined}>
                {isMe ? "▶ " : "  "}
                {r.branch} · ctx {pct(r.contextPercent)} · {usd(r.costUsd)} · {r.turns} turns ·{" "}
                {r.model.replace(/^claude-/, "")}
              </Text>
              {r.lastPrompt !== "" && (
                <Text dimColor>
                  {"    "}
                  {r.lastPrompt}
                </Text>
              )}
            </Box>
          );
        })}
        <Text> </Text>
        <Text bold>CI (gh run list)</Text>
        {runs === null && <Text dimColor>gh unavailable or still fetching.</Text>}
        {runs?.length === 0 && <Text dimColor>No runs.</Text>}
        {runs?.map((r) => (
          <Text
            color={
              r.conclusion === "failure" ? "red" : r.conclusion === "success" ? "green" : undefined
            }
            dimColor={r.conclusion !== "failure" && r.conclusion !== "success"}
          >
            {r.conclusion.padEnd(9)} {r.name.padEnd(14).slice(0, 14)} {r.branch.slice(0, 28)} ·{" "}
            {r.age}
          </Text>
        ))}

        <Text> </Text>
        <Text bold>Open PRs ({openPrs?.length ?? 0})</Text>
        {openPrs === null && <Text dimColor>gh unavailable or still fetching.</Text>}
        {openPrs?.length === 0 && <Text dimColor>None open.</Text>}
        {openPrs?.map((p) => (
          <Text color={ciColor(p.ci)} dimColor={ciColor(p.ci) === undefined}>
            {`#${p.number}`.padEnd(5)} {p.ci.padEnd(9)} {p.branch.slice(0, 26).padEnd(26)}
            {branchesHere.has(p.branch) ? " ◂ here" : ""}
          </Text>
        ))}

        <Text> </Text>
        <Text bold>Nightly FR</Text>
        {lastNightly === null && <Text dimColor>gh unavailable or still fetching.</Text>}
        {lastNightly !== null && (
          <Text
            color={
              lastNightly.conclusion === "failure"
                ? "red"
                : lastNightly.conclusion === "success"
                  ? "green"
                  : undefined
            }
            dimColor={lastNightly.conclusion !== "failure" && lastNightly.conclusion !== "success"}
          >
            {lastNightly.conclusion} · {lastNightly.age} ago
          </Text>
        )}

        <Text> </Text>
        <Text bold>Prod /health</Text>
        {prod === null && (
          <Text dimColor>Not fetched yet (polled every 5 min while this pane is open).</Text>
        )}
        {prod !== null && !prod.ok && <Text color="red">unreachable: {prod.error}</Text>}
        {prod !== null && prod.ok && prod.degraded.length === 0 && (
          <Text color="green">ok{prod.commit !== null ? ` · ${prod.commit.slice(0, 7)}` : ""}</Text>
        )}
        {prod !== null && prod.ok && prod.degraded.length > 0 && (
          <Text color="red">degraded: {prod.degraded.join(", ")}</Text>
        )}

        <Text> </Text>
        <Text bold>Reports ({reportRows.length})</Text>
        {reportRows.length === 0 && (
          <Text dimColor>None. Workers run /report when a PR is green or they're blocked.</Text>
        )}
        {reportRows.slice(0, 12).map((r) => (
          <Text>
            {r.branch.slice(0, 22).padEnd(22)} {(r.pr !== null ? `#${r.pr}` : "—").padEnd(5)}{" "}
            <Text color={r.ci === "failing" ? "red" : r.ci === "green" ? "green" : undefined}>
              {r.ci}
            </Text>
            {r.note !== "" ? ` · ${r.note}` : ""}
          </Text>
        ))}
      </Box>
    );
  });
};
