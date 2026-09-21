/**
 * PERSONAL-USE PROTOTYPE — this package drives ParkNYC's own web app with
 * the owner's account, for the owner's own parking only. It is not a
 * shipping integration: automating a consumer app sits outside its intended
 * use and likely its Terms of Service, acceptable only as a personal
 * experiment. Issue #37 tracks moving this package to a private repo; it
 * must move before any customer uses it.
 *
 * Unexpected-screen evidence: a screenshot and the page's visible text,
 * returned so the server can attach both to the decisions row, and
 * optionally written to a local capture directory for eyeballing.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "playwright";

import type { ExecutorDiagnostics } from "../types.js";

const MAX_TEXT_CHARS = 20_000;
// decisions is a JSONB column; keep a runaway full-page shot out of it.
const MAX_SCREENSHOT_BASE64_CHARS = 500_000;

/**
 * Best-effort: a derailed flow may hold a crashed page, so every step here
 * swallows its own errors — evidence gathering must never mask the failure
 * it is documenting.
 */
export async function captureUnexpectedScreen(
  page: Page,
  captureDir?: string,
): Promise<ExecutorDiagnostics> {
  const diagnostics: ExecutorDiagnostics = {};

  try {
    const text = await page.innerText("body", { timeout: 3_000 });
    diagnostics.pageText = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
  } catch {
    // page gone or never loaded; the thrown error already tells that story
  }

  let screenshot: Buffer | null = null;
  try {
    screenshot = await page.screenshot({ type: "jpeg", quality: 50, timeout: 5_000 });
    const base64 = screenshot.toString("base64");
    if (base64.length <= MAX_SCREENSHOT_BASE64_CHARS) {
      diagnostics.screenshotBase64 = base64;
    }
  } catch {
    // ditto
  }

  if (captureDir) {
    try {
      mkdirSync(captureDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      // Owner-only (0600): a capture can show a signed-in account page —
      // and in the card-setup flow, a filled payment form.
      if (screenshot) {
        const screenshotPath = join(captureDir, `${stamp}.jpg`);
        writeFileSync(screenshotPath, screenshot, { mode: 0o600 });
        diagnostics.screenshotPath = screenshotPath;
      }
      if (diagnostics.pageText !== undefined) {
        const textPath = join(captureDir, `${stamp}.txt`);
        writeFileSync(textPath, diagnostics.pageText, { mode: 0o600 });
        diagnostics.textPath = textPath;
      }
    } catch {
      // a read-only disk must not turn a ui_changed into a crash
    }
  }

  return diagnostics;
}
