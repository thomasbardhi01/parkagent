/**
 * PERSONAL-USE PROTOTYPE — this package drives ParkNYC's own web app with
 * the owner's account, for the owner's own parking only. It is not a
 * shipping integration: automating a consumer app sits outside its intended
 * use and likely its Terms of Service, acceptable only as a personal
 * experiment. Issue #37 tracks moving this package to a private repo; it
 * must move before any customer uses it.
 *
 * `pnpm -C executor run login` — opens a HEADED browser on the ParkNYC sign-in
 * page. You sign in by hand (credentials never touch this repo, code, or
 * env), then press Enter here, and the session's cookies/localStorage are
 * saved as Playwright storageState at PARKNYC_STATE_PATH (default:
 * executor/storageState.json, which is gitignored).
 */

import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { URLS } from "./parknyc/selectors.js";

const statePath = resolve(
  process.env["PARKNYC_STATE_PATH"] ??
    fileURLToPath(new URL("../storageState.json", import.meta.url)),
);

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(URLS.signIn);

console.log(
  [
    "",
    "A browser window is open on the ParkNYC sign-in page.",
    "1. Sign in there by hand (handle any 2FA/captcha yourself).",
    "2. Wait until you can see your signed-in account/dashboard.",
    `3. Come back here and press Enter to save the session to:`,
    `   ${statePath}`,
    "",
  ].join("\n"),
);

const rl = createInterface({ input: process.stdin, output: process.stdout });
await rl.question("Press Enter when you are signed in… ");
rl.close();

mkdirSync(dirname(statePath), { recursive: true });
await context.storageState({ path: statePath });
chmodSync(statePath, 0o600); // auth material: owner-only
await browser.close();

console.log(
  `Saved. That file is auth material — it stays out of git (.gitignore) and out of Stripe/DB rows.`,
);
