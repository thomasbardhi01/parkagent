# parkagent-guard (a Claude Code mod)

The enforcement layer. The scoped `Bash(...)` patterns in `.claude/agents/*.md`
only *steer* the model — they don't block anything (PR #221, comment
6305900070). This mod actually blocks, by parsing every Bash command the
session (and its subagents) tries to run and denying the ones a Claude session
must never do:

- **`gh pr merge`** — a human merges, never a Claude session (CLAUDE.md).
- **`gh pr review --approve`** — no self-approval.
- **`gh secret set`** — never writes repository/Actions secrets.
- **`gh workflow run`** against main (no `--ref`, or `--ref main`/`master`) —
  a human runs deploys and the nightly.
- **`git push` to `main`/`master`** in any form: bare push while on main,
  `origin main`, `HEAD:main`, `--force`, `--delete main`, `--all`/`--mirror`.
  A push to a feature branch is allowed.
- **`fly deploy`**, **`fly secrets set|unset|import`**, **`fly ssh`**,
  **`fly postgres connect`** — production machine and secrets.
- **Reading `.env`, `.env.*`, or `ios/Config.xcconfig`** with
  `cat · less · head · tail · more · grep · rg · source · . · cp · bat ·
  strings · xxd · od · nl · view`. `.env.example`/`.env.sample` (committed,
  non-secret templates) are allowed.

It parses the command the way a shell would: it splits on `;  &&  ||  |`,
subshells and `< >` redirections, descends into `$(...)`, backticks and
`bash -c` / `sh -c "..."`, and sees through wrapper prefixes
(`env VAR=1 …`, `sudo`, `timeout 60 …`, `nohup`, `xargs`). **If it can't parse
a command and the command names a guarded tool, it denies it** rather than
guess. The deny reason the model reads starts with `guard:`.

A denial is the guard's `tool.check` hook returning `{ decision: "deny" }`;
it only ever *tightens*, so nothing it allows loosens Claude Code's own
permission rules.

## Turning it off

```
/guard status   # is the guard on, or lifted (and until when)?
/guard off      # lift it for 10 minutes in THIS session (asks you to confirm)
/guard on       # re-arm it now
```

`/guard off` asks for confirmation, writes a transcript line recording who
lifted it and until when, and lifts the guard **for this session's main loop
only, for ten minutes**. It never lifts for subagents — a subagent's Bash is
always guarded — and never for any other session. The window is held in the
session's own plugin state, so it does not persist across restarts.

The guard is **not** a substitute for the working agreement: a human still
merges every PR (CLAUDE.md, "Working style"). It's a backstop for the cases
where a session would otherwise run the command by mistake.

## Load it

Add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, the
same way as `parkagent-fleet` (separate several paths with `:`):

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "~/Documents/parkagent/.claude/mods/parkagent-guard:~/Documents/parkagent/.claude/mods/parkagent-fleet"
  }
}
```

For one terminal session only: `claude --plugin-dir .claude/mods/parkagent-guard`.

## Check it

```
claude plugin validate .claude/mods/parkagent-guard
claude plugin test     .claude/mods/parkagent-guard
```

Both pass on Claude Code 2.1.305+. The hooks API is early-access; if a session
prints a dim `parkagent-guard: … refused` line after an update, re-run
`validate` and fix what it names.

## How it's split

- `hooks/guard.ts` — the pure parser and deny rules (`decide`, `expand`,
  `needsBranch`, `gitDirOf`); no engine, unit-tested directly in
  `hooks/guard.test.ts`.
- `hooks/register.tsx` — the hook wiring: the `tool.check` guard (with a
  fail-closed `.catch`), the one git-branch lookup for a bare push, and the
  `/guard` command. Tested through the engine in `hooks/register.test.tsx`.
