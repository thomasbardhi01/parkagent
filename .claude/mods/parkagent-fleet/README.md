# parkagent-fleet (a Claude Code mod)

What it adds to every Claude Code session opened in this repo:

- **A band above the prompt**: `<branch> · ctx 42% · 5h 18% · 7d 6% · $1.20 · 7 turns`.
  Turns yellow at 75 % context and says `/compact or hand off`. `/fleet-band` hides or shows it.
- **A status-line entry** with the same figures after every turn.
- **`/fleet` pane**: every Claude Code session on this machine that has this mod loaded
  (branch, context fill, spend, model, last prompt), this session first, plus the repo's
  last six GitHub Actions runs via `gh`. Sessions publish through the mod's shared store
  after each turn; a session silent for 6 hours drops off.

Nothing leaves the machine: the store is Claude Code's own plugin store, `gh` is the one
you already use, and the mod reads nothing from the repo but `git branch --show-current`.

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
