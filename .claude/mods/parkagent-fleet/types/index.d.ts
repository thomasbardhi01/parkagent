/** One session's last reading, written to `$.store` under `fleet:<sessionId>`. */
export type FleetRow = {
  sessionId: string
  cwd: string
  branch: string
  model: string
  contextPercent: number | null
  fiveHourPercent: number | null
  sevenDayPercent: number | null
  costUsd: number | null
  turns: number
  lastPrompt: string
  updatedAt: number
}

/** One CI run as `gh run list` reports it. */
export type CiRun = {
  status: string
  conclusion: string
  name: string
  branch: string
  age: string
}

declare module 'claude-code' {
  interface PluginState {
    'parkagent-fleet': {
      /** This session's own reading, redrawn on every turn. */
      me: FleetRow | null
      /** Bumped by the refresh loop so the pane redraws. */
      tick: number
      /** Latest CI runs on the repo, or null before the first fetch / without gh. */
      ci: CiRun[] | null
      /** The band is hidden for this session. */
      isHidden: boolean
    }
  }
}
