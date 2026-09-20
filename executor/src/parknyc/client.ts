/**
 * PERSONAL-USE PROTOTYPE — this package drives ParkNYC's own web app with
 * the owner's account, for the owner's own parking only. It is not a
 * shipping integration: automating a consumer app sits outside its intended
 * use and likely its Terms of Service, acceptable only as a personal
 * experiment. Issue #37 tracks moving this package to a private repo; it
 * must move before any customer uses it.
 *
 * The Playwright client. One instance = one browser context restored from
 * the storage state at `statePath` (never credentials — see login.ts). The
 * happy path is hardcoded against selectors.ts; anything off-script is
 * captured (screenshot + visible text) and returned as a typed error.
 *
 * The flows were drafted from memory of the ParkNYC web app and MUST be
 * walked once with `pnpm -C executor run record` to verify selectors, the
 * duration-stepper increment, and the confirmation wording (see README).
 */

import { existsSync } from "node:fs";

import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";

import type { ExecutorError, ExecutorResult } from "../types.js";
import { captureUnexpectedScreen } from "./capture.js";
import { classifyFailure } from "./classify.js";
import { parseAmountUsd, parseConfirmation, parseExpiresAt } from "./parse.js";
import { llmRecoveryEnabled, suggestRecovery } from "./recovery.js";
import { selectors, URLS } from "./selectors.js";

/** TODO: verify against a recording — assumed stepper increment and floor. */
const DURATION_STEP_MINUTES = 15;

export interface ParkNycClientOptions {
  /** Playwright storageState JSON (from `pnpm -C executor run login`). */
  statePath: string;
  /** Headed only for local debugging; prod is headless. */
  headless?: boolean;
  /** Where unexpected-screen evidence is also written as files. */
  captureDir?: string;
  /** Per-step timeout; ParkNYC is slow but not this slow. */
  timeoutMs?: number;
  /** Recording hook: called after each named step with the live page. */
  onStep?: (name: string, page: Page) => Promise<void>;
  /** Recording: write an HAR of all traffic here (set at context creation). */
  recordHarPath?: string;
  /** Recording: write a Playwright trace zip here on close. */
  tracePath?: string;
}

export class ParkNycClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(private readonly options: ParkNycClientOptions) {}

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? 15_000;
  }

  /** Launch + restore auth. Fails typed, not thrown, when state is missing. */
  private async open(): Promise<{ page: Page } | ExecutorError> {
    if (this.page) return { page: this.page };
    if (!existsSync(this.options.statePath)) {
      return {
        ok: false,
        code: "auth_expired",
        message: `no ParkNYC storage state at ${this.options.statePath}; run \`pnpm -C executor run login\``,
      };
    }
    this.browser = await chromium.launch({ headless: this.options.headless ?? true });
    this.context = await this.browser.newContext({
      storageState: this.options.statePath,
      ...(this.options.recordHarPath ? { recordHar: { path: this.options.recordHarPath } } : {}),
    });
    if (this.options.tracePath) {
      await this.context.tracing.start({ screenshots: true, snapshots: true });
    }
    this.context.setDefaultTimeout(this.timeoutMs);
    this.page = await this.context.newPage();
    return { page: this.page };
  }

  async close(): Promise<void> {
    if (this.context && this.options.tracePath) {
      await this.context.tracing.stop({ path: this.options.tracePath }).catch(() => {});
    }
    await this.context?.close().catch(() => {}); // flushes the HAR, if any
    await this.browser?.close().catch(() => {});
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  private async step(name: string, page: Page): Promise<void> {
    await this.options.onStep?.(name, page);
  }

  /** A typed failure that carries the current screen as evidence. */
  private async fail(
    page: Page,
    code: ExecutorError["code"],
    message: string,
  ): Promise<ExecutorError> {
    const diagnostics = await captureUnexpectedScreen(page, this.options.captureDir);
    return { ok: false, code, message, diagnostics };
  }

  /**
   * Wrap a flow: anything thrown (usually a selector timeout) becomes a
   * typed error with capture attached. The recovery hook runs first when
   * enabled; until it is implemented it never rescues (recovery.ts).
   */
  private async run(
    goal: string,
    page: Page,
    flow: () => Promise<ExecutorResult>,
  ): Promise<ExecutorResult> {
    try {
      return await flow();
    } catch (err) {
      const diagnostics = await captureUnexpectedScreen(page, this.options.captureDir);
      if (llmRecoveryEnabled()) {
        // TODO: apply at most one suggested action and retry the flow once
        // (see recovery.ts); the stub always answers null today.
        await suggestRecovery({
          goal,
          pageText: diagnostics.pageText ?? "",
          ...(diagnostics.screenshotBase64
            ? { screenshotBase64: diagnostics.screenshotBase64 }
            : {}),
        });
      }
      const code = classifyFailure(err, diagnostics.pageText ?? null);
      const message = err instanceof Error ? err.message.split("\n")[0]! : String(err);
      return { ok: false, code, message: `${goal}: ${message}`, diagnostics };
    }
  }

  /** True when the current page is asking us to sign in. */
  private async atSignInScreen(page: Page): Promise<boolean> {
    return await selectors.signIn
      .emailInput(page)
      .isVisible({ timeout: 2_000 })
      .catch(() => false);
  }

  async startSession(
    zoneNumber: string,
    plate: string | undefined,
    minutes: number,
  ): Promise<ExecutorResult> {
    const opened = await this.open();
    if ("ok" in opened) return opened;
    const { page } = opened;
    const goal = `start ${minutes} min in zone ${zoneNumber}`;

    return this.run(goal, page, async () => {
      await page.goto(URLS.home);
      await this.step("home", page);
      if (await this.atSignInScreen(page)) {
        return this.fail(page, "auth_expired", "ParkNYC asked to sign in; storage state is stale");
      }

      await selectors.home.parkButton(page).click();
      await this.step("park-entry", page);

      await selectors.zone.zoneNumberInput(page).fill(zoneNumber);
      await selectors.zone.continueButton(page).click();
      await this.step("zone-submitted", page);
      if (
        await selectors.zone
          .notFoundMessage(page)
          .isVisible({ timeout: 3_000 })
          .catch(() => false)
      ) {
        return this.fail(page, "zone_not_found", `ParkNYC rejected zone ${zoneNumber}`);
      }

      const vehicle = plate
        ? selectors.vehicle.plateOption(page, plate)
        : selectors.vehicle.firstOption(page);
      await vehicle.check();
      await selectors.vehicle.continueButton(page).click();
      await this.step("vehicle-selected", page);

      // Assumes the stepper starts at one increment; verified on recording.
      const clicks = Math.max(0, Math.round(minutes / DURATION_STEP_MINUTES) - 1);
      for (let i = 0; i < clicks; i += 1) {
        await selectors.duration.addTimeButton(page).click();
      }
      await selectors.duration.continueButton(page).click();
      await this.step("duration-selected", page);

      await selectors.confirm.total(page).waitFor();
      await selectors.confirm.payButton(page).click();
      await this.step("payment-submitted", page);

      // Whichever lands first: the receipt or a decline banner.
      await selectors.confirmation
        .successMarker(page)
        .or(selectors.confirm.declinedMessage(page))
        .first()
        .waitFor();
      if (await selectors.confirm.declinedMessage(page).isVisible()) {
        return this.fail(page, "payment_declined", "ParkNYC refused the payment");
      }
      await this.step("confirmation", page);

      const text = await page.innerText("body");
      const parsed = parseConfirmation(text, new Date());
      if (!parsed) {
        return this.fail(
          page,
          "ui_changed",
          "confirmation screen did not match the expected receipt shape",
        );
      }
      return { ok: true, ...parsed };
    });
  }

  async extendSession(providerSessionId: string, minutes: number): Promise<ExecutorResult> {
    const opened = await this.open();
    if ("ok" in opened) return opened;
    const { page } = opened;
    const goal = `extend session ${providerSessionId} by ${minutes} min`;

    return this.run(goal, page, async () => {
      await page.goto(URLS.sessions);
      await this.step("sessions", page);
      if (await this.atSignInScreen(page)) {
        return this.fail(page, "auth_expired", "ParkNYC asked to sign in; storage state is stale");
      }

      const row = selectors.sessions.sessionRow(page, providerSessionId);
      if (!(await row.isVisible({ timeout: 5_000 }).catch(() => false))) {
        return this.fail(
          page,
          "unknown",
          `session ${providerSessionId} not on the active-sessions screen`,
        );
      }
      await row.click();
      await selectors.sessions.extendButton(page).click();
      await this.step("extend-opened", page);

      const clicks = Math.max(1, Math.round(minutes / DURATION_STEP_MINUTES));
      for (let i = 0; i < clicks - 1; i += 1) {
        await selectors.duration.addTimeButton(page).click();
      }
      await selectors.duration.continueButton(page).click();
      await selectors.confirm.total(page).waitFor();
      await selectors.confirm.payButton(page).click();
      await this.step("extend-payment-submitted", page);

      await selectors.confirmation
        .successMarker(page)
        .or(selectors.confirm.declinedMessage(page))
        .first()
        .waitFor();
      if (await selectors.confirm.declinedMessage(page).isVisible()) {
        return this.fail(page, "payment_declined", "ParkNYC refused the extension payment");
      }
      await this.step("extend-confirmation", page);

      const text = await page.innerText("body");
      const now = new Date();
      // Extensions keep the session's id; expiry and amount must be fresh.
      const expiresAt = parseExpiresAt(text, now);
      const amountUsd = parseAmountUsd(text);
      if (expiresAt === null || amountUsd === null) {
        return this.fail(
          page,
          "ui_changed",
          "extension confirmation did not match the expected receipt shape",
        );
      }
      const parsed = parseConfirmation(text, now);
      return {
        ok: true,
        providerSessionId: parsed?.providerSessionId ?? providerSessionId,
        expiresAt,
        amountUsd,
      };
    });
  }

  async stopSession(providerSessionId: string): Promise<ExecutorResult> {
    const opened = await this.open();
    if ("ok" in opened) return opened;
    const { page } = opened;
    const goal = `stop session ${providerSessionId}`;

    return this.run(goal, page, async () => {
      await page.goto(URLS.sessions);
      await this.step("sessions", page);
      if (await this.atSignInScreen(page)) {
        return this.fail(page, "auth_expired", "ParkNYC asked to sign in; storage state is stale");
      }

      const row = selectors.sessions.sessionRow(page, providerSessionId);
      if (!(await row.isVisible({ timeout: 5_000 }).catch(() => false))) {
        return this.fail(
          page,
          "unknown",
          `session ${providerSessionId} not on the active-sessions screen`,
        );
      }
      await row.click();
      await selectors.sessions.stopButton(page).click();
      await selectors.sessions.stopConfirmButton(page).click();
      await this.step("stop-confirmed", page);

      // The row leaving the active list is the cheapest "it worked" signal.
      await row.waitFor({ state: "hidden" });
      return { ok: true, providerSessionId, expiresAt: new Date(), amountUsd: 0 };
    });
  }
}
