# parkagent-guard (a Claude Code mod)

The enforcement layer. The scoped `Bash(...)` patterns in `.claude/agents/*.md`
only *steer* the model — they don't block anything (PR #221, comment
6305900070). This mod actually blocks, by parsing every Bash command the
session (and its subagents) tries to run and denying the ones a Claude session
must never do:

- **`gh pr merge`** — a human merges, never a Claude session (CLAUDE.md).
- **`gh pr review --approve`** — no self-approval.
- **`gh secret set`** — never writes repository/Actions secrets.
- **`gh workflow run`** against main (no `--ref`, or `--ref main`/`master`).
- **`gh api`** with a write method (`-X`/`--method` other than GET, or a
  `-f`/`-F`/`--input` field that implies POST), and **`gh repo delete|edit|
  archive`**, **`gh release create|delete|edit`**, **`gh ruleset …`**,
  **`gh variable set|delete`**.
- **`git push` to `main`/`master`** in any form: bare push while on main,
  `origin main`, `HEAD:main`, `--force`, `--delete main`, `--all`/`--mirror`.
  A push to a feature branch is allowed.
- **`fly`** — only read-only verbs are allowed (`status`, `logs`, `releases`,
  `version`, `auth whoami`, `apps list`, `machine list|status`, `secrets
  list`, `postgres list`, `ips list`, `checks list`). Everything else
  (`deploy`, `ssh`, `secrets set`, `machine exec`, …) is denied.
- **Any command that names a secret path** (`.env`, `.env.*`, or
  `ios/Config.xcconfig`) — the file tools (`Read`, `Edit`, `Write`,
  `NotebookEdit`, and `Grep`/`Glob` by their path/glob) and any Bash argv,
  **a bare redirect target included** (`cat < .env`). The only exception is a
  command that checks for a path without reading it: `ls`, `stat`, `test`,
  `[`, `git check-ignore`, `git ls-files`. `.env.example`/`.env.sample`/
  `.env.template`/`.env.dist`/`.env.defaults` (committed templates) are not
  secrets.

It parses the command the way a shell would: it splits on `;  &&  ||  |`,
subshells and `< >` redirections, descends into `$(...)`, backticks and
`bash -c` / `sh -c "..."`, sees through wrapper prefixes (`env VAR=1 …`,
`sudo`, `timeout 60 …`, `nohup`, `xargs`), and matches `gh`/`git`/`fly` by
**basename** so an absolute path (`/opt/homebrew/bin/gh`) still counts.
**It fails closed** when it can't parse a command that names a guarded tool,
and when the command's own name is hidden behind a variable or substitution
(`G=gh; $G pr merge`) and the line names a guarded tool. The deny reason the
model reads starts with `guard:`.

A denial is a `tool.check` hook returning `{ decision: "deny" }`; the guard
only ever *tightens*, never loosening Claude Code's own rules. If a hook ever
throws, its catch **never answers "allow"** — it denies anything naming a
guarded tool, otherwise defers to the engine, otherwise asks the person.

## Two layers

The mod is the **strong** layer, but only in sessions that load it. As an
**always-on weak** backstop, `.claude/settings.json` carries native
`permissions.deny` rules — `Read(./.env)`, `Read(./.env.*)`,
`Read(./ios/Config.xcconfig)`, `Bash(gh pr merge:*)`, `Bash(gh secret set:*)`,
`Bash(fly deploy:*)`, `Bash(fly secrets set:*)`, `Bash(fly ssh:*)`,
`Bash(git push origin main:*)` — that apply in every session with no mod
loaded. Those rules are coarse (they don't understand compound commands,
wrappers or substitutions); the mod is what does.

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
