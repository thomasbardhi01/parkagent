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
    };
  }
}
