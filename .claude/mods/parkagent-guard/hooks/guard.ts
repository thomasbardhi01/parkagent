// The guard's pure logic: parse a Bash command line into the simple commands
// it would actually run, then decide whether any of them is one we refuse.
// No engine, no `$`, no I/O — so it unit-tests directly and the hook in
// register.tsx only wires it to `tool.check` and supplies the git branch.

/** Commands that may NAME a secret path without reading its contents: a
 * metadata/existence check, not a read. `git check-ignore` / `git ls-files`
 * are handled in `secretInArgv`. Everything else naming a secret is denied. */
const SAFE_WITH_SECRET = new Set(["ls", "stat", "test", "["]);

/** The basename of a command, so an absolute path (/opt/homebrew/bin/gh) counts. */
const base = (cmd: string): string => cmd.split("/").pop() ?? cmd;

/** Wrappers that run another command; we unwrap them to reach the real one. */
const WRAPPERS = new Set([
  "sudo",
  "nohup",
  "command",
  "time",
  "builtin",
  "exec",
  "env",
  "nice",
  "stdbuf",
  "ionice",
  "timeout",
  "xargs",
]);
/** Shells whose `-c <script>` argument is itself a command line to parse. */
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

export type ParseResult = {
  ok: boolean;
  argvs: string[][];
  /** A command whose command position was a variable/substitution we could not
   * resolve (`$G pr merge`, `` `echo gh` ``) — the real command is hidden. */
  opaque: boolean;
};

/**
 * Lex one script into its simple commands (argv arrays), splitting on
 * `; & | < >` and newlines and subshell parens, and descending into
 * `$(...)`, backticks and double-quoted substitutions. `ok` is false when
 * quoting or a substitution is unbalanced — the caller then fails closed.
 */
function lex(src: string): ParseResult {
  const argvs: string[][] = [];
  let ok = true;
  let opaque = false;
  let cur: string[] = [];
  let word = "";
  let hasWord = false;
  let i = 0;
  const n = src.length;
  // A $-expansion while the command word is still being formed (cur is empty)
  // means the command itself came from a variable/substitution we can't read.
  const atCommandPosition = () => cur.length === 0;

  const endWord = () => {
    if (hasWord) {
      cur.push(word);
      word = "";
      hasWord = false;
    }
  };
  const endCmd = () => {
    endWord();
    if (cur.length) argvs.push(cur);
    cur = [];
  };

  while (i < n) {
    const c = src.charAt(i);
    if (c === "\\") {
      if (i + 1 < n) {
        word += src.charAt(i + 1);
        hasWord = true;
        i += 2;
        continue;
      }
      ok = false;
      break;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) {
        ok = false;
        break;
      }
      word += src.slice(i + 1, end);
      hasWord = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      const r = readDouble(src, i + 1);
      if (!r.ok) {
        ok = false;
        break;
      }
      word += r.text;
      hasWord = true;
      for (const sub of r.subs) {
        const p = lex(sub);
        if (!p.ok) ok = false;
        argvs.push(...p.argvs);
      }
      i = r.next;
      continue;
    }
    if (c === "$" && src.charAt(i + 1) === "(") {
      if (atCommandPosition()) opaque = true;
      const close = matchParen(src, i + 2);
      if (close === -1) {
        ok = false;
        break;
      }
      const p = lex(src.slice(i + 2, close));
      if (!p.ok) ok = false;
      if (p.opaque) opaque = true;
      argvs.push(...p.argvs);
      i = close + 1;
      continue;
    }
    if (c === "$" && src.charAt(i + 1) === "{") {
      if (atCommandPosition()) opaque = true;
      const close = src.indexOf("}", i + 2);
      if (close === -1) {
        ok = false;
        break;
      }
      i = close + 1;
      continue;
    }
    if (c === "$") {
      // $VAR: skip the name; contributes nothing we can resolve.
      if (atCommandPosition()) opaque = true;
      i += 1;
      while (i < n && /[A-Za-z0-9_]/.test(src.charAt(i))) i += 1;
      continue;
    }
    if (c === "`") {
      if (atCommandPosition()) opaque = true;
      const end = findBacktick(src, i + 1);
      if (end === -1) {
        ok = false;
        break;
      }
      const p = lex(src.slice(i + 1, end).replace(/\\`/g, "`"));
      if (!p.ok) ok = false;
      if (p.opaque) opaque = true;
      argvs.push(...p.argvs);
      i = end + 1;
      continue;
    }
    // Command separators and redirections: all end the current simple command.
    // A redirection target after > or < begins a throwaway "command" we then
    // ignore, and the reader+secret pair always sits before the redirect.
    if (
      c === ";" ||
      c === "&" ||
      c === "|" ||
      c === "<" ||
      c === ">" ||
      c === "(" ||
      c === ")" ||
      c === "\n"
    ) {
      endCmd();
      i += 1;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i += 1;
      continue;
    }
    word += c;
    hasWord = true;
    i += 1;
  }
  endCmd();

  return { ok, argvs, opaque };
}

/** Read a double-quoted span starting after the opening quote. */
function readDouble(
  src: string,
  start: number,
): { ok: boolean; text: string; subs: string[]; next: number } {
  let text = "";
  const subs: string[] = [];
  let i = start;
  const n = src.length;
  while (i < n) {
    const c = src.charAt(i);
    if (c === '"') return { ok: true, text, subs, next: i + 1 };
    if (c === "\\") {
      if (i + 1 < n) {
        // In double quotes a backslash is literal except before " $ ` or \.
        const next = src.charAt(i + 1);
        if (next === '"' || next === "$" || next === "`" || next === "\\") {
          text += next;
          i += 2;
          continue;
        }
        text += c;
        i += 1;
        continue;
      }
      return { ok: false, text, subs, next: i };
    }
    if (c === "$" && src.charAt(i + 1) === "(") {
      const close = matchParen(src, i + 2);
      if (close === -1) return { ok: false, text, subs, next: i };
      subs.push(src.slice(i + 2, close));
      i = close + 1;
      continue;
    }
    if (c === "$" && src.charAt(i + 1) === "{") {
      const close = src.indexOf("}", i + 2);
      if (close === -1) return { ok: false, text, subs, next: i };
      i = close + 1;
      continue;
    }
    if (c === "`") {
      const end = findBacktick(src, i + 1);
      if (end === -1) return { ok: false, text, subs, next: i };
      subs.push(src.slice(i + 1, end).replace(/\\`/g, "`"));
      i = end + 1;
      continue;
    }
    text += c;
    i += 1;
  }

  return { ok: false, text, subs, next: i };
}

/** Index of the `)` that closes a `$(` whose body starts at `start`. */
function matchParen(src: string, start: number): number {
  let depth = 1;
  let i = start;
  const n = src.length;
  while (i < n) {
    const c = src.charAt(i);
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      const r = readDouble(src, i + 1);
      if (!r.ok) return -1;
      i = r.next;
      continue;
    }
    if (c === "$" && src.charAt(i + 1) === "(") {
      depth += 1;
      i += 2;
      continue;
    }
    if (c === "(") {
      depth += 1;
      i += 1;
      continue;
    }
    if (c === ")") {
      depth -= 1;
      if (depth === 0) return i;
      i += 1;
      continue;
    }
    i += 1;
  }

  return -1;
}

/** Index of the next unescaped backtick from `start`. */
function findBacktick(src: string, start: number): number {
  let i = start;
  const n = src.length;
  while (i < n) {
    const c = src.charAt(i);
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") return i;
    i += 1;
  }

  return -1;
}

/** Strip leading assignments and wrapper commands (env/sudo/timeout/…). */
function unwrap(argv: string[]): string[] {
  let a = argv.slice();
  while (a.length && ASSIGN.test(a[0] as string)) a = a.slice(1);
  for (;;) {
    const c = a[0];
    if (c === undefined || !WRAPPERS.has(c)) break;
    a = a.slice(1);
    if (c === "env") {
      while (a.length) {
        const t = a[0] as string;
        if (ASSIGN.test(t)) {
          a = a.slice(1);
          continue;
        }
        if (t === "-u") {
          a = a.slice(2);
          continue;
        }
        if (t === "--") {
          a = a.slice(1);
          break;
        }
        if (t.startsWith("-")) {
          a = a.slice(1);
          continue;
        }
        break;
      }
      continue;
    }
    // Skip the wrapper's own flags; a few take a following value.
    while (a.length && (a[0] as string).startsWith("-")) {
      const f = a[0] as string;
      a = a.slice(1);
      if (f === "-u" || f === "--user" || f === "-g" || f === "--group") a = a.slice(1);
    }
    // timeout takes a duration before its command.
    if (c === "timeout" && a.length) a = a.slice(1);
  }

  return a;
}

/** Expand a command line into every effective argv it runs, bash -c included. */
export function expand(command: string): ParseResult {
  const first = lex(command);
  let ok = first.ok;
  let opaque = first.opaque;
  const out: string[][] = [];
  const work = first.argvs.slice();
  let guard = 0;
  while (work.length && guard < 2000) {
    guard += 1;
    const eff = unwrap(work.shift() as string[]);
    if (!eff.length) continue;
    if (SHELLS.has(base(eff[0] as string))) {
      const ci = eff.findIndex((a, idx) => idx > 0 && /^-[A-Za-z]*c$/.test(a));
      const script = ci !== -1 ? eff[ci + 1] : undefined;
      if (script !== undefined) {
        const inner = lex(script);
        if (!inner.ok) ok = false;
        if (inner.opaque) opaque = true;
        work.push(...inner.argvs);
        continue;
      }
    }
    out.push(eff);
  }

  return { ok, argvs: out, opaque };
}

const PREFIX = "guard:";

function ghDeny(rest: string[]): string | null {
  const pos = rest.filter((t) => !t.startsWith("-"));
  const group = pos[0];
  const sub = pos[1];
  if (group === "pr" && sub === "merge") {
    return `${PREFIX} a human merges, never a Claude session (CLAUDE.md). Blocked gh pr merge.`;
  }
  if (group === "pr" && sub === "review" && rest.some((t) => t === "--approve" || t === "-a")) {
    return `${PREFIX} a Claude session never approves a PR. Blocked gh pr review --approve.`;
  }
  if (group === "secret" && sub === "set") {
    return `${PREFIX} writing repository/Actions secrets is blocked. Use the shared vault.`;
  }
  if (group === "workflow" && sub === "run") {
    const ref = refOf(rest);
    if (ref === null || ref === "main" || ref === "master") {
      return `${PREFIX} dispatching a workflow against main is blocked. A human runs deploys/nightly.`;
    }
  }
  // `gh api` with a write method (or a field flag that implies POST).
  if (group === "api" && ghApiWrites(rest)) {
    return `${PREFIX} gh api with a write method (-X/--method, -f/-F/--input) is blocked.`;
  }
  if (group === "repo" && (sub === "delete" || sub === "edit" || sub === "archive")) {
    return `${PREFIX} gh repo ${sub} changes the repository. Blocked.`;
  }
  if (group === "release" && (sub === "create" || sub === "delete" || sub === "edit")) {
    return `${PREFIX} gh release ${sub} changes releases. Blocked.`;
  }
  if (group === "ruleset") {
    return `${PREFIX} gh ruleset changes branch protection. Blocked.`;
  }
  if (group === "variable" && (sub === "set" || sub === "delete")) {
    return `${PREFIX} gh variable ${sub} changes Actions variables. Blocked.`;
  }

  return null;
}

/** Whether a `gh api` call writes: a method other than GET, or a field flag. */
function ghApiWrites(rest: string[]): boolean {
  let method = "GET";
  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i] as string;
    if (t === "-X" || t === "--method") {
      method = (rest[i + 1] ?? "").toUpperCase();
      i += 1;
      continue;
    }
    if (t.startsWith("--method=")) {
      method = t.slice("--method=".length).toUpperCase();
      continue;
    }
    if (t === "-f" || t === "-F" || t === "--field" || t === "--raw-field" || t === "--input") {
      return true; // sending a body implies POST
    }
  }

  return method !== "GET";
}

/** The value of --ref/-r on a `gh workflow run`, or null when none is given. */
function refOf(rest: string[]): string | null {
  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i] as string;
    if (t === "--ref" || t === "-r") return rest[i + 1] ?? "";
    if (t.startsWith("--ref=")) return t.slice("--ref=".length);
  }

  return null;
}

const GIT_VALUE_OPTS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
  "--exec-path",
]);
const PUSH_VALUE_OPTS = new Set(["--repo", "-o", "--push-option", "--receive-pack", "--exec"]);

/** Index of the `push` subcommand in git's args, past git's own global opts. */
function pushIndex(rest: string[]): number {
  let i = 0;
  while (i < rest.length) {
    const t = rest[i] as string;
    if (GIT_VALUE_OPTS.has(t)) {
      i += 2;
      continue;
    }
    if (t.startsWith("-")) {
      i += 1;
      continue;
    }
    break;
  }

  return rest[i] === "push" ? i : -1;
}

function gitDeny(rest: string[], branch: string | null): string | null {
  const pi = pushIndex(rest);
  if (pi === -1) return null;
  const pushArgs = rest.slice(pi + 1);

  const flags = new Set<string>();
  const positionals: string[] = [];
  for (let j = 0; j < pushArgs.length; j += 1) {
    const t = pushArgs[j] as string;
    if (PUSH_VALUE_OPTS.has(t)) {
      j += 1;
      continue;
    }
    if (t.startsWith("-")) {
      flags.add(t.replace(/=.*/, ""));
      continue;
    }
    positionals.push(t);
  }
  if (flags.has("--all") || flags.has("--mirror")) {
    return `${PREFIX} git push --all/--mirror would push main. Push one feature branch instead.`;
  }
  // The first positional is the remote; the rest are refspecs.
  const refspecs = positionals.slice(1);
  if (refspecs.length === 0) {
    // Bare push (or remote only): pushes the current branch.
    if (branch === "main" || branch === "master") {
      return `${PREFIX} no direct pushes to ${branch} — every change lands through a PR.`;
    }

    return null;
  }
  for (const spec of refspecs) {
    if (destIsMain(spec, branch)) {
      return `${PREFIX} no direct pushes to main/master — every change lands through a PR.`;
    }
  }

  return null;
}

/** Does a refspec's destination resolve to main or master? */
function destIsMain(spec: string, branch: string | null): boolean {
  const r = spec.replace(/^\+/, "");
  let dst: string;
  if (r.includes(":")) dst = r.slice(r.indexOf(":") + 1);
  else if (r === "HEAD") dst = branch ?? "";
  else dst = r;
  dst = dst.replace(/^refs\/heads\//, "");

  return dst === "main" || dst === "master";
}

const FLY_VALUE_OPTS = new Set([
  "-a",
  "--app",
  "-c",
  "--config",
  "-t",
  "--access-token",
  "-o",
  "--org",
  "-r",
  "--region",
  "-i",
  "--image",
  "-e",
  "--env",
  "--vm-size",
  "--dockerfile",
]);

/** The only fly subcommands we allow: read-only ones. `[v]` matches any
 * second word; `[v, w]` needs that exact pair. Everything else is denied. */
const FLY_READONLY: ReadonlyArray<readonly [string, string?]> = [
  ["status"],
  ["logs"],
  ["releases"],
  ["version"],
  ["auth", "whoami"],
  ["apps", "list"],
  ["machine", "list"],
  ["machine", "status"],
  ["secrets", "list"],
  ["postgres", "list"],
  ["ips", "list"],
  ["checks", "list"],
];

function flyDeny(rest: string[]): string | null {
  const pos: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i] as string;
    if (FLY_VALUE_OPTS.has(t)) {
      i += 1;
      continue;
    }
    if (t.startsWith("-")) continue;
    pos.push(t);
  }
  const p0 = pos[0];
  const p1 = pos[1];
  if (p0 === undefined) return null; // bare `fly` prints help
  const allowed = FLY_READONLY.some(([a, b]) => a === p0 && (b === undefined || b === p1));
  if (allowed) return null;

  return `${PREFIX} fly ${p0} changes prod; only read-only fly is allowed.`;
}

/** Committed, non-secret templates that look like .env.* but hold no secrets. */
const ENV_TEMPLATES = new Set(["example", "sample", "template", "dist", "defaults"]);

/** Whether a path refers to .env, .env.* (not a template), or ios/Config.xcconfig. */
export function isSecretPath(arg: string): boolean {
  const name = arg.split("/").pop() ?? arg;
  if (name === "Config.xcconfig") return true;
  if (name === ".env") return true;
  if (name.startsWith(".env.")) return !ENV_TEMPLATES.has(name.slice(".env.".length));

  return false;
}

/** Deny any command whose arguments name a secret path — a redirect target
 * included (`>`/`<` split those into their own argv) — unless the command only
 * tests for a path's existence or ignore status, never its contents. */
function secretInArgv(argv: string[]): string | null {
  const cmd = base(argv[0] as string);
  const safe =
    SAFE_WITH_SECRET.has(cmd) ||
    (cmd === "git" && (argv[1] === "check-ignore" || argv[1] === "ls-files"));
  if (safe) return null;
  if (argv.some(isSecretPath)) {
    return `${PREFIX} reading a secret path (.env / .env.* / ios/Config.xcconfig) is blocked. Secrets live in the vault.`;
  }

  return null;
}

function denyArgv(argv: string[], branch: string | null): string | null {
  const cmd = argv[0];
  if (cmd === undefined) return null;
  const b = base(cmd);
  const rest = argv.slice(1);
  if (b === "gh") {
    const r = ghDeny(rest);
    if (r !== null) return r;
  } else if (b === "git") {
    const r = gitDeny(rest, branch);
    if (r !== null) return r;
  } else if (b === "fly" || b === "flyctl") {
    const r = flyDeny(rest);
    if (r !== null) return r;
  }

  // Any command (other than the safe existence/ignore checks) naming a secret.
  return secretInArgv(argv);
}

/** True when any effective argv is a bare `git push` whose branch we must know. */
export function needsBranch(argvs: string[][]): boolean {
  return argvs.some((argv) => {
    const a = unwrap(argv);
    if (a[0] === undefined || base(a[0]) !== "git") return false;
    const pi = pushIndex(a.slice(1));
    if (pi === -1) return false;
    const pushArgs = a.slice(1).slice(pi + 1);
    const positionals: string[] = [];
    for (let j = 0; j < pushArgs.length; j += 1) {
      const t = pushArgs[j] as string;
      if (PUSH_VALUE_OPTS.has(t)) {
        j += 1;
        continue;
      }
      if (t.startsWith("-")) continue;
      positionals.push(t);
    }

    return positionals.slice(1).length === 0;
  });
}

/** The `-C <dir>` of the first git command, so we read the right repo's branch. */
export function gitDirOf(argvs: string[][]): string | null {
  for (const argv of argvs) {
    const a = unwrap(argv);
    if (a[0] === undefined || base(a[0]) !== "git") continue;
    const ci = a.indexOf("-C");
    const dir = ci !== -1 ? a[ci + 1] : undefined;
    if (dir !== undefined) return dir;
  }

  return null;
}

/** A guarded tool named anywhere on the line (even after `=`), or a secret
 * path. Used to fail closed when the line can't be parsed, or when a command's
 * own name was hidden behind a variable/substitution. */
export const NAMES_GUARDED = /\b(?:gh|git|fly|flyctl)\b|\.env(?:\.|\b)|Config\.xcconfig/;

/**
 * Decide a Bash command. Returns a one-line deny reason, or null to allow
 * (the hook then defers to the engine's own verdict). `branch` is the current
 * git branch when known; the hook fetches it only when `needsBranch` is true.
 */
export function decide(command: string, branch: string | null = null): string | null {
  const { ok, argvs, opaque } = expand(command);
  if (!ok) {
    if (NAMES_GUARDED.test(command)) {
      return `${PREFIX} command could not be parsed and names a guarded tool. Blocked; simplify it or use /guard off.`;
    }

    return null;
  }
  // The command's own name came from a variable/substitution and the line names
  // a guarded tool: we can't tell what it runs, so fail closed.
  if (opaque && NAMES_GUARDED.test(command)) {
    return `${PREFIX} a variable or substitution hides the command, and the line names a guarded tool. Blocked; write it out or use /guard off.`;
  }
  for (const argv of argvs) {
    const reason = denyArgv(argv, branch);
    if (reason !== null) return reason;
  }

  return null;
}
