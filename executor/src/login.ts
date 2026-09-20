/**
 * PERSONAL-USE PROTOTYPE — this package drives a parking provider's own web
 * app with the owner's account, for the owner's own parking only. It is not
 * a shipping integration: automating a consumer app sits outside its
 * intended use and likely its Terms of Service, acceptable only as a
 * personal experiment. Issue #37 tracks moving this package to a private
 * repo; it must move before any customer uses it.
 *
 * `pnpm -C executor run login [-- --provider parknyc|passport]`
 *
 * Opens a HEADED browser on the provider's sign-in page. You sign in by
 * hand (credentials never touch this repo, code, or env — note ParkBoston
 * is passwordless: e-mail/phone code, then a 4-digit PIN), then press Enter
 * here, and the session's cookies/localStorage are saved as Playwright
 * storageState (gitignored):
 *   parknyc:  PARKNYC_STATE_PATH  (default executor/storageState.json)
 *   passport: PASSPORT_STATE_PATH (default executor/storageState.passport.json)
 */

import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { chromium } from "playwright";

import { URLS } from "./parknyc/selectors.js";
import { passportUrls } from "./passport/selectors.js";

const { values: flags } = parseArgs({
  options: {
    provider: { type: "string", default: "parknyc" },
  },
});
const provider = flags.provider;
if (provider !== "parknyc" && provider !== "passport") {
  console.error(`Unknown provider "${provider}" — use parknyc or passport.`);
  process.exit(1);
}

const defaults = {
  parknyc: { envVar: "PARKNYC_STATE_PATH", file: "../storageState.json", url: URLS.signIn },
  passport: {
    envVar: "PASSPORT_STATE_PATH",
    file: "../storageState.passport.json",
    url: passportUrls().signIn,
  },
} as const;
const chosen = defaults[provider];

const statePath = resolve(
  process.env[chosen.envVar] ?? fileURLToPath(new URL(chosen.file, import.meta.url)),
);

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(chosen.url);

console.log(
  [
    "",
    `A browser window is open on the ${provider} sign-in page.`,
    "1. Sign in there by hand (handle any 2FA/captcha/PIN yourself).",
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
