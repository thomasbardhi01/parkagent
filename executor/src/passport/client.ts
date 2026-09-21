/**
 * PERSONAL-USE PROTOTYPE — this package drives the provider's own consumer
 * web app with the owner's account, for the owner's own parking only. See
 * ../types.ts header and issue #37.
 *
 * The Playwright client for Passport's white-label web app (ParkBoston at
 * bostonma.ppprk.com; reusable for other Passport cities by swapping the
 * base URL — see selectors.ts). One instance = one browser context restored
 * from storage state; the happy path is hardcoded against selectors.ts and
 * anything off-script is captured and returned as a typed error.
 *
 * There is NO map in the ParkBoston web app (verified on the 2026-09-21
 * signed-in recording, fixtures/passport-resolve-2026-09-21T01-17-11-693Z):
 * after login the app lands on a single "Enter Zone" screen — a zone-number
 * field and Continue. So startSession REQUIRES a zone number; the server
 * collects them from users at the meter (POST /zones/:zoneId/provider-number)
 * since Boston's open data carries none. Map-based resolution survives only
 * as the ParkNYC client's non-fatal cross-check.
 *
 * The gated entry / T&C / e-mail verification screens and the Enter Zone
 * screen (#zoneNumber, #zoneNext) are verified against recordings. The
 * screens AFTER zone submit (rates/duration/confirm) are still drafted from
 * the app's shipped view source and MUST be verified against a
 * `pnpm -C executor run record -- --provider passport` run (see README).
 */

import { existsSync } from "node:fs";

import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";

import { warmBrowser } from "../browser.js";
import { captureUnexpectedScreen } from "../parknyc/capture.js";
import { classifyFailure } from "../parknyc/classify.js";
import { parseAmountUsd, parseConfirmation, parseExpiresAt } from "../parknyc/parse.js";
import type {
  CardFormDetails,
  ExecutorError,
  ExecutorResult,
  ProviderOpResult,
  StorageStateValue,
  TopupWalletResult,
  VerifyAccountResult,
} from "../types.js";
import { BOSTON_BASE_URL, passportUrls, selectors } from "./selectors.js";
import type { PassportUrls } from "./selectors.js";

/** TODO-verify: assumed stepper increment, like the ParkNYC client's. */
const DURATION_STEP_MINUTES = 15;

export interface PassportClientOptions {
  /** Playwright storageState file (from `pnpm -C executor run login -- --provider passport`). */
  statePath?: string;
  /** Storage state as a value — the server decrypts per call. */
  storageState?: StorageStateValue;
  /** Passport city base URL; defaults to ParkBoston. */
  baseUrl?: string;
  sharedBrowser?: boolean;
  headless?: boolean;
  captureDir?: string;
  timeoutMs?: number;
  onStep?: (name: string, page: Page) => Promise<void>;
  recordHarPath?: string;
  tracePath?: string;
}

export class PassportClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  readonly urls: PassportUrls;

  constructor(private readonly options: PassportClientOptions) {
    this.urls = passportUrls(options.baseUrl ?? BOSTON_BASE_URL);
  }

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? 20_000;
  }

  private async open(): Promise<{ page: Page } | ExecutorError> {
    if (this.page) return { page: this.page };
    const state = this.options.storageState ?? this.options.statePath;
    if (state === undefined) {
      return { ok: false, code: "auth_expired", message: "no Passport storage state given" };
    }
    if (typeof state === "string" && !existsSync(state)) {
      return {
        ok: false,
        code: "auth_expired",
        message: `no Passport storage state at ${state}; run \`pnpm -C executor run login -- --provider passport\``,
      };
    }
    this.browser = this.options.sharedBrowser
      ? await warmBrowser(this.options.headless ?? true)
      : await chromium.launch({ headless: this.options.headless ?? true });
    this.context = await this.browser.newContext({
      storageState: state,
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
    await this.context?.close().catch(() => {});
    if (!this.options.sharedBrowser) {
      await this.browser?.close().catch(() => {});
    }
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  private async step(name: string, page: Page): Promise<void> {
    await this.options.onStep?.(name, page);
  }

  private async fail(
    page: Page,
    code: ExecutorError["code"],
    message: string,
  ): Promise<ExecutorError> {
    const diagnostics = await captureUnexpectedScreen(page, this.options.captureDir);
    return { ok: false, code, message, diagnostics };
  }

  /** Wrap a flow: anything thrown becomes a typed error with capture. */
  private async run(
    goal: string,
    page: Page,
    flow: () => Promise<ExecutorResult>,
  ): Promise<ExecutorResult> {
    try {
      return await flow();
    } catch (err) {
      const diagnostics = await captureUnexpectedScreen(page, this.options.captureDir);
      const code = classifyFailure(err, diagnostics.pageText ?? null);
      const message = err instanceof Error ? err.message.split("\n")[0]! : String(err);
      return { ok: false, code, message: `${goal}: ${message}`, diagnostics };
    }
  }

  /** The gated entry screen means the cookies are not a signed-in session. */
  private async atGatedEntry(page: Page): Promise<boolean> {
    return await selectors.gatedEntry
      .marker(page)
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false);
  }

  /**
   * Start a session by typing the zone number into the Enter Zone screen —
   * the only entry the ParkBoston web app has (no map; verified on the
   * 2026-09-21 recording). The zone number comes from our zones table,
   * fed by user reports (POST /zones/:zoneId/provider-number).
   */
  async startSession(
    zoneNumber: string,
    plate: string | undefined,
    minutes: number,
  ): Promise<ExecutorResult> {
    if (zoneNumber === "") {
      // Never reach the provider without a number: the server refuses
      // earlier (needs_zone_number), this is the belt to that suspender.
      return {
        ok: false,
        code: "zone_not_found",
        message: "no zone number for this zone — ParkBoston needs the posted number",
      };
    }
    const opened = await this.open();
    if ("ok" in opened) return opened;
    const { page } = opened;

    const goal = `start ${minutes} min in zone ${zoneNumber}`;
    const result = await this.run(goal, page, async () => {
      // Enter Zone (VERIFIED against the 2026-09-21 recording: input
      // #zoneNumber type=tel "Zone Number", button #zoneNext "Continue").
      await page.goto(this.urls.zoneEntry);
      await this.step("zone-entry", page);
      if (await this.atGatedEntry(page)) {
        return this.fail(page, "auth_expired", "Passport asked to sign in; state is stale");
      }
      await selectors.zone.zoneNumberInput(page).fill(zoneNumber);
      await selectors.zone.nextButton(page).click();
      await this.step("zone-submitted", page);
      if (
        await selectors.zone
          .notFoundMessage(page)
          .isVisible({ timeout: 3_000 })
          .catch(() => false)
      ) {
        return this.fail(page, "zone_not_found", `Passport rejected zone ${zoneNumber}`);
      }

      // After a valid zone the app shows the zone's info (rates) with a
      // Select Zone button, or goes straight on — both drafted from the
      // shipped view source, TODO-verify on the first paid recording.
      const selectZone = selectors.zoneInfo.selectZoneButton(page);
      if (await selectZone.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await selectZone.click();
        await this.step("zone-selected", page);
      }

      // Vehicle (skipped by the app when only one is saved — TODO-verify).
      const vehicle = plate
        ? selectors.vehicle.plateOption(page, plate)
        : selectors.vehicle.firstOption(page);
      if (await vehicle.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await vehicle.click();
        await selectors.vehicle.continueButton(page).click();
        await this.step("vehicle-selected", page);
      }

      // Duration: stepper increments assumed 15 min (TODO-verify).
      const clicks = Math.max(0, Math.round(minutes / DURATION_STEP_MINUTES) - 1);
      for (let i = 0; i < clicks; i += 1) {
        await selectors.duration.addTimeButton(page).click();
      }
      await selectors.duration.continueButton(page).click();
      await this.step("duration-selected", page);

      await selectors.confirm.total(page).waitFor();
      await selectors.confirm.payButton(page).click();
      await this.step("payment-submitted", page);

      await selectors.confirmation
        .successMarker(page)
        .or(selectors.confirm.declinedMessage(page))
        .first()
        .waitFor();
      if (await selectors.confirm.declinedMessage(page).isVisible()) {
        return this.fail(page, "payment_declined", "Passport refused the payment");
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
    return result;
  }

  async extendSession(providerSessionId: string, minutes: number): Promise<ExecutorResult> {
    const opened = await this.open();
    if ("ok" in opened) return opened;
    const { page } = opened;
    const goal = `extend session ${providerSessionId} by ${minutes} min`;

    return this.run(goal, page, async () => {
      await page.goto(this.urls.session);
      await this.step("session", page);
      if (await this.atGatedEntry(page)) {
        return this.fail(page, "auth_expired", "Passport asked to sign in; state is stale");
      }
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
        return this.fail(page, "payment_declined", "Passport refused the extension payment");
      }
      await this.step("extend-confirmation", page);

      const text = await page.innerText("body");
      const now = new Date();
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

    return this.run(`stop session ${providerSessionId}`, page, async () => {
      await page.goto(this.urls.session);
      await this.step("session", page);
      if (await this.atGatedEntry(page)) {
        return this.fail(page, "auth_expired", "Passport asked to sign in; state is stale");
      }
      await selectors.sessions.stopButton(page).click();
      await selectors.sessions.stopConfirmButton(page).click();
      await this.step("stop-confirmed", page);
      await selectors.sessions.stopButton(page).waitFor({ state: "hidden" });
      return { ok: true, providerSessionId, expiresAt: new Date(), amountUsd: 0 };
    });
  }

  // -------------------------------------------------------------------------
  // Account operations. verifyAccount is what POST /providers/passport/link
  // runs; the card ops are drafted (TODO-verify) — shadow mode never uses
  // them, and real card setup waits for a signed-in recording.

  async verifyAccount(): Promise<VerifyAccountResult> {
    const opened = await this.open();
    if ("ok" in opened) return opened;
    const { page } = opened;

    const flow = await this.run("verify account", page, async () => {
      await page.goto(this.urls.account);
      await this.step("account", page);
      if (await this.atGatedEntry(page)) {
        return this.fail(
          page,
          "auth_expired",
          "Passport asked to sign in; cookies are not a session",
        );
      }
      await selectors.account.signedInMarker(page).waitFor();
      // ParkBoston has no wallet balance we read yet (Passport Wallet is
      // optional per city) — null means "not shown".
      return { ok: true, providerSessionId: "verify", expiresAt: new Date(), amountUsd: -1 };
    });
    if (!flow.ok) return flow;
    return { ok: true, walletBalanceCents: null };
  }

  /** Drafted, TODO-verify: Passport's update-card screen (#updateCard). The
   * form has no card-type radio (unlike ParkNYC), so any brand passes. */
  async setupCard(card: CardFormDetails): Promise<ProviderOpResult> {
    const opened = await this.open();
    if ("ok" in opened) return opened;
    const { page } = opened;

    const flow = await this.run("set up issuing card as payment method", page, async () => {
      await page.goto(this.urls.updateCard);
      await this.step("update-card", page);
      if (await this.atGatedEntry(page)) {
        return this.fail(
          page,
          "auth_expired",
          "Passport asked to sign in; cookies are not a session",
        );
      }
      await selectors.payment.cardNumberInput(page).fill(card.number);
      await selectors.payment
        .expiryInput(page)
        .fill(
          `${String(card.expMonth).padStart(2, "0")}/${String(card.expYear % 100).padStart(2, "0")}`,
        );
      await selectors.payment.cvcInput(page).fill(card.cvc);
      await selectors.payment.saveButton(page).click();
      await this.step("card-submitted", page);
      await selectors.payment.successMarker(page).waitFor();
      await this.step("card-saved", page);
      return { ok: true, providerSessionId: "setup-card", expiresAt: new Date(), amountUsd: 0 };
    });

    card.number = "";
    card.cvc = "";
    return flow.ok ? { ok: true } : flow;
  }

  /** Drafted, TODO-verify: remove our card (by last4) from saved cards. */
  async removeCard(last4: string): Promise<ProviderOpResult> {
    const opened = await this.open();
    if ("ok" in opened) return opened;
    const { page } = opened;

    const flow = await this.run(`remove card …${last4}`, page, async () => {
      await page.goto(this.urls.paymentMethods);
      await this.step("payment-methods", page);
      if (await this.atGatedEntry(page)) {
        return this.fail(
          page,
          "auth_expired",
          "Passport asked to sign in; cookies are not a session",
        );
      }
      const row = selectors.payment.cardRow(page, last4);
      if (!(await row.isVisible({ timeout: 5_000 }).catch(() => false))) {
        return { ok: true, providerSessionId: "remove-card", expiresAt: new Date(), amountUsd: 0 };
      }
      await row.click();
      await selectors.payment.removeButton(page).click();
      await selectors.payment.removeConfirmButton(page).click();
      await selectors.payment
        .removedMarker(page)
        .waitFor({ timeout: 5_000 })
        .catch(() => row.waitFor({ state: "hidden" }));
      await this.step("card-removed", page);
      return { ok: true, providerSessionId: "remove-card", expiresAt: new Date(), amountUsd: 0 };
    });
    return flow.ok ? { ok: true } : flow;
  }

  /** ParkBoston sessions charge the card directly; there is no wallet to
   * top up (Passport's Zone Cash is not enabled for Boston — TODO-verify). */
  async topupWallet(amountUsd: number): Promise<TopupWalletResult> {
    return {
      ok: false,
      code: "unknown",
      message: `ParkBoston has no wallet to top up $${amountUsd.toFixed(2)} into (Passport Zone Cash not enabled)`,
    };
  }
}
