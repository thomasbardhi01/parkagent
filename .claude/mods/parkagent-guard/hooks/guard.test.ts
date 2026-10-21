import { expect, test } from "claude-code/testing";

import { decide, expand, gitDirOf, needsBranch } from "./guard";

// The pure decision function: a non-null reason means deny, null means allow.
// `branch` stands for the current git branch a bare `git push` would push.

const deny = (cmd: string, branch: string | null = "feat/x") => {
  const r = decide(cmd, branch);
  expect(r, `expected DENY for: ${cmd}`).not.toBeNull();
  expect(r).toMatch(/^guard:/);
};
const allow = (cmd: string, branch: string | null = "feat/x") => {
  expect(decide(cmd, branch), `expected ALLOW for: ${cmd}`).toBeNull();
};

test("gh: merge, self-approve, secret set, and workflow run on main are denied", () => {
  deny("gh pr merge 1");
  deny("gh pr merge 1 --squash --delete-branch");
  deny("gh pr review 1 --approve");
  deny("gh secret set FOO --body bar");
  deny("gh workflow run nightly-fr.yml"); // no --ref => default (main)
  deny("gh workflow run nightly-fr.yml --ref main");
});

test("gh: read-only and feature-branch dispatches are allowed", () => {
  allow("gh pr checks 1");
  allow("gh pr view 1 --json statusCheckRollup");
  allow("gh run list --limit 6");
  allow('gh pr review 1 --comment --body "looks good"');
  allow("gh secret list");
  allow("gh workflow run ci.yml --ref feat/x");
});

test("git push to main/master is denied in every form", () => {
  deny("git push", "main");
  deny("git push", "master");
  deny("git push origin main");
  deny("git push origin master");
  deny("git push origin HEAD:main");
  deny("git push origin feat/x:main");
  deny("git push -f origin main");
  deny("git push --force origin refs/heads/main");
  deny("git push origin HEAD", "main");
  deny("git push origin --delete main");
  deny("git push --all origin");
  deny("git -C /repo push origin main");
});

test("git push to a feature branch, and other git commands, are allowed", () => {
  allow("git push", "feat/mods-guard");
  allow("git push origin feat/mods-guard");
  allow("git push -u origin feat/mods-guard");
  allow("git push origin HEAD", "feat/x");
  allow("git push origin HEAD:feat/x");
  allow("git status");
  allow("git log --oneline -5");
  allow('git commit -m "no pushes to main here"');
});

test("fly deploy / secrets / ssh / postgres connect are denied; read-only fly is allowed", () => {
  deny("fly deploy");
  deny("fly deploy -a parkagent-api");
  deny("flyctl deploy --image registry.fly.io/parkagent-api:deployment-x");
  deny("fly secrets set FOO=bar -a parkagent-api");
  deny("fly secrets unset FOO");
  deny("fly ssh console -a parkagent-api");
  deny("fly postgres connect -a parkagent-db");
  allow("fly status -a parkagent-api");
  allow("fly logs");
  allow("fly releases -a parkagent-api --image");
  allow("fly scale show -a parkagent-api");
});

test("reading .env, .env.*, and ios/Config.xcconfig is denied; other reads are allowed", () => {
  deny("cat .env");
  deny("cat ./.env");
  deny("less .env.production");
  deny("head -n 5 .env.local");
  deny("grep DATABASE_URL .env");
  deny("source .env");
  deny(". .env");
  deny("cp .env /tmp/leak");
  deny("cat ios/Config.xcconfig");
  deny("cat server/../ios/Config.xcconfig");
  allow("cat server/src/index.ts");
  allow("grep -rn TODO server/src");
  allow('grep "\\.env" docs/setup.md'); // ".env" is the PATTERN, not a file
  allow("cat .env.example"); // committed template, not a secret
  allow("cat .env.sample");
});

test("compound commands: a guarded verb anywhere in the line is denied", () => {
  deny("cd server && gh pr merge 1");
  deny("pnpm test; git push origin main");
  deny("pnpm lint || cat .env");
  deny("echo hi | gh pr merge 1");
  deny("true && (cd / ; fly deploy)");
  allow("pnpm lint && pnpm test");
  allow("cd server && git status && git push origin feat/x");
});

test("substitutions and bash -c descend into the inner command", () => {
  deny('bash -c "gh pr merge 1"');
  deny("sh -c 'git push origin main'");
  deny('bash -lc "cat .env"');
  deny("echo $(cat .env)");
  deny("X=$(gh pr merge 1) echo done");
  deny("echo `fly deploy`");
  allow('bash -c "pnpm -r test"');
  allow("sh -c 'git status'");
});

test("wrappers (env, sudo, timeout, nohup) do not hide a guarded verb", () => {
  deny("env FOO=bar gh pr merge 1");
  deny("sudo fly deploy");
  deny("timeout 60 git push origin main");
  deny("nohup fly ssh console &");
  deny("env -u HOME cat .env");
  allow("env FOO=bar pnpm test");
});

test("quoting keeps a secret path recognizable", () => {
  deny('cat ".env"');
  deny("cat '.env'");
  deny('cat .en"v"'); // reassembles to .env
});

test("an unparseable command naming a guarded tool is denied; an innocent one is allowed", () => {
  // Unbalanced quote: the lexer fails, so we fall back to a keyword scan.
  expect(decide('cat .env "')).not.toBeNull();
  expect(decide("gh pr merge 1 '")).not.toBeNull();
  expect(decide('echo "unterminated')).toBeNull();
});

test("needsBranch and gitDirOf drive the one git lookup", () => {
  expect(needsBranch(expand("git push").argvs)).toBe(true);
  expect(needsBranch(expand("git push origin").argvs)).toBe(true);
  expect(needsBranch(expand("git push origin main").argvs)).toBe(false);
  expect(needsBranch(expand("pnpm test").argvs)).toBe(false);
  expect(gitDirOf(expand("git -C /work push").argvs)).toBe("/work");
  expect(gitDirOf(expand("git push").argvs)).toBeNull();
});
