/** One session's last reading, written to `$.store` under `fleet:<sessionId>`. */
export type FleetRow = {
  sessionId: string;
  cwd: string;
  branch: string;
  model: string;
  contextPercent: number | null;
  fiveHourPercent: number | null;
  sevenDayPercent: number | null;
  costUsd: number | null;
  turns: number;
  lastPrompt: string;
  updatedAt: number;
};

/** One CI run as `gh run list` reports it. */
export type CiRun = {
  status: string;
  conclusion: string;
  name: string;
  branch: string;
  age: string;
};

/** Where context stands against the 75 % warning; the toast fires on the move to `hot`. */
export type ContextBand = "ok" | "hot";

/** One open PR as `gh pr list` reports it, with its CI rolled up to one word. */
export type PrRow = {
  number: number;
  title: string;
  branch: string;
  /** "green" | "failing" | "running" | "no checks". */
  ci: string;
};

/** The last nightly-fr run and its age. */
export type NightlyRun = {
  status: string;
  conclusion: string;
  age: string;
};

/** Prod /health as the pane last read it. */
export type ProdHealth = {
  ok: boolean;
  degraded: string[];
  commit: string | null;
  error: string | null;
};

/** One status report another session sent with /report (report.ts). */
export type ReportRow = {
  from: string;
  branch: string;
  pr: number | null;
  ci: string;
  note: string;
  at: number;
};

declare module "claude-code" {
  interface PluginState {
    "parkagent-fleet": {
      /** This session's own reading, redrawn on every turn. */
      me: FleetRow | null;
      /** The other sessions' rows as the refresh loop's last sweep found them. */
      fleet: FleetRow[];
      /** Latest CI runs on the repo, or null before the first fetch / without gh. */
      ci: CiRun[] | null;
      /** The band is hidden for this session. */
      isHidden: boolean;
      /** The context band at the last report, so the 75 % toast fires once per crossing. */
      band: ContextBand;
      /** Open PRs for the pane, or null before the first fetch / without gh. */
      prs: PrRow[] | null;
      /** The last nightly-fr run for the pane, or null before the first fetch. */
      nightly: NightlyRun | null;
      /** Prod /health for the pane, or null before the first poll. */
      health: ProdHealth | null;
      /** Routing to haiku is off for this session (/route off). */
      routeOff: boolean;
      /** How many turns have been routed to haiku this session. */
      routedTurns: number;
      /** Tokens that ran on haiku instead of opus (the saved estimate). */
      routedTokens: number;
      /** The turn being routed right now; the band shows "→ haiku" while set. */
      routedTurnId: string | null;
      /** Lean mode is on for this session (/lean on). */
      leanOn: boolean;
      /** Status reports this (coordinator) session has received, newest first. */
      reports: ReportRow[];
      /** Unread reports — the band shows "N reports" until /fleet is opened. */
      unreadReports: number;
    };
  }
}
