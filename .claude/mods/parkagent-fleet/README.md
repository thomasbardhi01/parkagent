# parkagent-fleet (a Claude Code mod)

What it adds to every Claude Code session opened in this repo:

- **A band above the prompt**: `<branch> · ctx 42% · 5h 18% · 7d 6% · $1.20 · 7 turns`.
  Turns yellow at 75 % context and says `/compact or hand off`; a toast says so once when
  context crosses 75 %, not every turn. `/fleet-band` hides or shows it.
- **A status-line entry** with the same figures, updated as Claude Code measures the session.
- **`/fleet` pane** (the dashboard): every Claude Code session on this machine that has this
  mod loaded (branch, context fill, spend, model, last prompt), this session first; then the
  repo's last six GitHub Actions runs, **open PRs** (each mapped to the session on its
  branch, with CI rolled up to one word), the **last nightly-fr** result and age, **prod
  `/health`** (its `degraded` list in red when non-empty), and **unread `/report` lines**.
- **Routing to haiku** (`route.ts`): a simple, read-only turn runs on the cheaper model.
- **Lean mode** (`lean.ts`): `/lean on` asks turns for the smallest change that meets the
  requirement.
- **`/report`** (`report.ts`): send a one-line status to a coordinator session.

The session figures stay on this machine, in Claude Code's own plugin store. The CI list,
PRs and nightly do not: `gh` calls the GitHub API with your login, and prod `/health` is
fetched over HTTP — all **only while the `/fleet` pane is open** (CI/PRs/nightly each minute,
health at most every 5 minutes), never while it's closed. Besides that, the mod runs only
`git branch --show-current`.

## Routing simple turns to haiku (`/route`)

A turn runs on haiku (instead of opus) when the prompt starts with `~` (explicit, always),
or when it is a read-only ask (`what does…`, `where is…`, `explain…`, `summarize…`, or
`why is this failing` with a pasted log) and nothing vetoes it. The **veto** blocks the
automatic path — never a `~` prompt — when the prompt names `server/src/services/{sessions,
wallet,limits}*`, `server/src/routes/{session,parked,assistant}*` or `prisma/`, or mentions
merge/deploy/migrate/money/pay/cap. Routing switches the *actual turn's* model (see the
mechanism note in the PR), so the turn keeps its tools and transcript — it just runs on a
cheaper model. The band shows `→ haiku` while a turn is routed; `/fleet` shows how many
turns were routed and the tokens taken off opus.

- `/route off` — disable routing for this session. `/route on` re-enables. `/route` — status.

## Lean mode (`/lean`)

Off by default. `/lean on` adds a system-prompt section to every new turn: write the minimum
that meets the requirement; no new dependency without a one-line justification; no
abstraction with one caller; delete before adding; never trade away validation, error
handling, security or tests. It **refuses on an `audit/*` branch** — an audit needs rigor,
not brevity. `/lean off` turns it back; `/lean` reports.

## Status reports (`/report`)

`/report [note]` sends `{from, branch, pr, ci, note}` (PR and CI read with `gh pr view`) to
the session named by the `coordSession` setting (default `coord`, in
`pluginConfigs."parkagent-fleet".options`). In that coordinator session, each report is
stored and the band shows `N reports` until `/fleet` is opened. If there is no such session,
`/report` says so and stores nothing.

## Load it

Once, so every session (terminal or the desktop app) on this Mac loads it — add to
`~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "~/Documents/parkagent/.claude/mods/parkagent-fleet"
  }
}
```

Several mods: separate the paths with `:`. Restart the sessions; then `/fleet`.

For one terminal session only: `claude --plugin-dir .claude/mods/parkagent-fleet`.

## Check it

```
claude plugin validate .claude/mods/parkagent-fleet
claude plugin test     .claude/mods/parkagent-fleet
```

Both pass on Claude Code 2.1.305. The hooks API is early-access and may change between
releases; if a session prints a dim `parkagent-fleet: … refused` line after an update,
re-run `validate` and fix what it names.

## Where the rest of the "mods" live

- Cheaper models for routine steps: `.claude/agents/` (`ci-watch` and `code-map` on Haiku,
  `test-run` on Sonnet). The main session delegates to them with the Agent tool.
- Sessions talking to each other is built into Claude Code (`ListAgents` + `SendMessage`,
  `$.session.send` / `session.receive` in the mod API); no mod needed. The working
  agreement for it is in `docs/workstreams.md`.
