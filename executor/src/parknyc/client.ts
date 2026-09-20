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

import { warmBrowser } from "../browser.js";
import type {
  CardFormDetails,
  ExecutorError,
  ExecutorResult,
  ProviderOpResult,
  StorageStateValue,
  TopupWalletResult,
  VerifyAccountResult,
  ZoneResolution,
} from "../types.js";
import { captureUnexpectedScreen } from "./capture.js";
import { classifyFailure } from "./classify.js";
import { parseAmountUsd, parseConfirmation, parseExpiresAt } from "./parse.js";
import { llmRecoveryEnabled, suggestRecovery } from "./recovery.js";
import { brandRadioPattern, selectors, URLS } from "./selectors.js";

/** TODO: verify against a recording — assumed stepper increment and floor. */
const DURATION_STEP_MINUTES = 15;

export interface ParkNycClientOptions {
  /** Playwright storageState file (from `pnpm -C executor run login`). */
  statePath?: string;
  /**
   * Storage state as a value — the server decrypts the user's linked
   * cookies per call. Exactly one of statePath/storageState must be set.
   */
  storageState?: StorageStateValue;
  /**
   * Reuse the warm shared browser (fresh context per client, relaunched if
   * the process died). Off for login/record, which want their own.
   */
  sharedBrowser?: boolean;
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
    const state = this.options.storageState ?? this.options.statePath;
    if (state === undefined) {
      return { ok: false, code: "auth_expired", message: "no ParkNYC storage state given" };
    }
    if (typeof state === "string" && !existsSync(state)) {
      return {
        ok: false,
        code: "auth_expired",
        message: `no ParkNYC storage state at ${state}; run \`pnpm -C executor run login\``,
      };
    }
    this.browser = this.options.sharedBrowser
      ? await warmBrowser(this.options.headless ?? true)
      : await chromium.launch({ headless: this.options.headless ?? true });
    this.context = await this.browser.newContext({
      storageState: state,
      // The map cross-check centers the zone map on the car by feeding the
      // fix through browser geolocation.
      permissions: ["geolocation"],
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
    // The shared browser stays warm for the next call; only close a
    // dedicated one.
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

  /**
   * NON-FATAL map cross-check: center the zone map on the car and read the
   * zone number under the nearest pin. Any failure (map never renders, no
   * pins, unreadable popup) returns null and the payment flow proceeds —
   * this only ever adds evidence, it never blocks. Selectors are broad
   * TODO-verify guesses (see selectors.map); tune on the first recording.
   */
  private async resolveZoneFromMap(
    page: Page,
    carLat: number,
    carLng: number,
  ): Promise<{ zoneNumber: string; street: string } | null> {
    try {
      await this.context!.setGeolocation({ latitude: carLat, longitude: carLng });
      await page.goto(URLS.home);
      await this.step("map-cross-check", page);
      const markers = selectors.map.markers(page);
      await markers.first().waitFor({ timeout: 8_000 });
      const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
      const cx = viewport.width / 2;
      const cy = viewport.height / 2;
      const count = await markers.count();
      let best = -1;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let i = 0; i < Math.min(count, 100); i += 1) {
        const box = await markers.nth(i).boundingBox();
        if (!box) continue;
        const d = Math.hypot(box.x + box.width / 2 - cx, box.y + box.height / 2 - cy);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      if (best < 0) return null;
      await markers.nth(best).click({ timeout: 4_000 });
      const text = await selectors.map.popup(page).innerText({ timeout: 6_000 });
      // ParkNYC zone numbers are 6 digits; the popup's first long digit run.
      const zone = /(\d{5,7})/.exec(text)?.[1];
      if (!zone) return null;
      // First non-numeric line of the popup is the best street guess.
      const street =
        text
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.length > 2 && !/^\d+$/.test(l)) ?? "";
      return { zoneNumber: zone, street };
    } catch {
      return null;
    }
  }

  async startSession(
    zoneNumber: string,
    plate: string | undefined,
    minutes: number,
    zoneCheck?: { carLat: number; carLng: number },
  ): Promise<ExecutorResult> {
    const opened = await this.open();
    if ("ok" in opened) return opened;
    const { page } = opened;
    const goal = `start ${minutes} min in zone ${zoneNumber}`;

    // Cross-check first, in its own navigation, so a wedged map can't
    // derail the payment flow below. Both numbers land on the decision.
    let zoneResolution: ZoneResolution | undefined;
    if (zoneCheck) {
      const resolved = await this.resolveZoneFromMap(page, zoneCheck.carLat, zoneCheck.carLng);
      if (resolved) {
        zoneResolution = {
          mapZoneNumber: resolved.zoneNumber,
          mapStreet: resolved.street,
          storedZoneNumber: zoneNumber,
          expectedStreet: null,
          matched: resolved.zoneNumber === zoneNumber,
        };
      }
    }

    const result = await this.run(goal, page, async () => {
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
    if (result.ok && zoneResolution) {
      return { ...result, zoneResolution };
    }
    return result;
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

  // -------------------------------------------------------------------------
  // Account operations (provider linking, card setup, wallet). Flows drafted
  // blind like the session flows above — verify against a `record` run.

  /** "$12.50" somewhere in the balance element → 1250; null when absent. */
  private async readWalletBalanceCents(page: Page): Promise<number | null> {
    const text = await selectors.account
      .walletBalance(page)
      .innerText({ timeout: 3_000 })
      .catch(() => null);
    const match = text?.match(/\$\s*(\d+)\.(\d{2})/);
    return match ? Number(match[1]) * 100 + Number(match[2]) : null;
  }

  /** Do the cookies constitute a signed-in session? Reads, never writes. */
  async verifyAccount(): Promise<VerifyAccountResult> {
    const opened = await this.open();
    if ("ok" in opened) return opened;
    const { page } = opened;

    const flow = await this.run("verify account", page, async () => {
      await page.goto(URLS.account);
      await this.step("account", page);
      if (await this.atSignInScreen(page)) {
        return this.fail(
          page,
          "auth_expired",
          "ParkNYC asked to sign in; cookies are not a session",
        );
      }
      await selectors.account.signedInMarker(page).waitFor();
      // Encode success through the session-result shape; the wrapper below
      // rebuilds the verify result. amountUsd carries the balance in cents.
      const balance = await this.readWalletBalanceCents(page);
      return {
        ok: true,
        providerSessionId: "verify",
        expiresAt: new Date(),
        amountUsd: balance ?? -1,
      };
    });
    if (!flow.ok) return flow;
    return { ok: true, walletBalanceCents: flow.amountUsd >= 0 ? flow.amountUsd : null };
  }

  /**
   * Make the given card the account's payment method. The card-type radio
   * is driven by the Stripe brand (the card-brand fix) — an unmapped brand
   * fails typed before the form is touched. Field values are blanked after
   * submit; nothing here may log them.
   */
  async setupCard(card: CardFormDetails): Promise<ProviderOpResult> {
    const brandPattern = brandRadioPattern(card.brand);
    if (brandPattern === null) {
      return {
        ok: false,
        code: "unsupported_card_brand",
        message: `no card-type radio mapping for brand "${card.brand}"`,
      };
    }
    const opened = await this.open();
    if ("ok" in opened) return opened;
    const { page } = opened;

    // Goal text carries no card data — it lands in logs and decisions rows.
    const flow = await this.run("set up issuing card as payment method", page, async () => {
      await page.goto(URLS.paymentMethods);
      await this.step("payment-methods", page);
      if (await this.atSignInScreen(page)) {
        return this.fail(
          page,
          "auth_expired",
          "ParkNYC asked to sign in; cookies are not a session",
        );
      }

      await selectors.payment.addCardButton(page).click();
      await this.step("add-card-opened", page);

      await selectors.payment.cardNumberInput(page).fill(card.number);
      await selectors.payment
        .expiryInput(page)
        .fill(
          `${String(card.expMonth).padStart(2, "0")}/${String(card.expYear % 100).padStart(2, "0")}`,
        );
      await selectors.payment.cvcInput(page).fill(card.cvc);
      await selectors.payment.brandRadio(page, brandPattern).check();
      await selectors.payment.saveButton(page).click();
      await this.step("card-submitted", page);

      // Replacing an existing default may ask for confirmation.
      const replace = selectors.payment.replaceConfirmButton(page);
      if (await replace.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await replace.click();
      }
      await selectors.payment.successMarker(page).waitFor();
      await this.step("card-saved", page);
      return { ok: true, providerSessionId: "setup-card", expiresAt: new Date(), amountUsd: 0 };
    });

    // Best-effort scrub: drop our references to the sensitive values the
    // moment the form is done with them (GC does the rest).
    card.number = "";
    card.cvc = "";

    return flow.ok ? { ok: true } : flow;
  }

  /** Best-effort: remove our card (by last4) from the account. */
  async removeCard(last4: string): Promise<ProviderOpResult> {
    const opened = await this.open();
    if ("ok" in opened) return opened;
    const { page } = opened;

    const flow = await this.run(`remove card …${last4}`, page, async () => {
      await page.goto(URLS.paymentMethods);
      await this.step("payment-methods", page);
      if (await this.atSignInScreen(page)) {
        return this.fail(
          page,
          "auth_expired",
          "ParkNYC asked to sign in; cookies are not a session",
        );
      }
      const row = selectors.payment.cardRow(page, last4);
      if (!(await row.isVisible({ timeout: 5_000 }).catch(() => false))) {
        // Nothing to remove is a success for an unlink.
        return { ok: true, providerSessionId: "remove-card", expiresAt: new Date(), amountUsd: 0 };
      }
      await row.click();
      await selectors.payment.removeButton(page).click();
      await selectors.payment.removeConfirmButton(page).click();
      // Success is either the removed banner or the row disappearing.
      await selectors.payment
        .removedMarker(page)
        .waitFor({ timeout: 5_000 })
        .catch(() => row.waitFor({ state: "hidden" }));
      await this.step("card-removed", page);
      return { ok: true, providerSessionId: "remove-card", expiresAt: new Date(), amountUsd: 0 };
    });
    return flow.ok ? { ok: true } : flow;
  }

  /** Top up the wallet from the card on file. Money moves — the server
   * gates this behind policy and dry run before the call ever gets here. */
  async topupWallet(amountUsd: number): Promise<TopupWalletResult> {
    const opened = await this.open();
    if ("ok" in opened) return opened;
    const { page } = opened;

    const flow = await this.run(`top up wallet $${amountUsd.toFixed(2)}`, page, async () => {
      await page.goto(URLS.wallet);
      await this.step("wallet", page);
      if (await this.atSignInScreen(page)) {
        return this.fail(
          page,
          "auth_expired",
          "ParkNYC asked to sign in; cookies are not a session",
        );
      }
      await selectors.wallet.topupButton(page).click();
      await this.step("topup-opened", page);

      // Preset chip when the amount matches one; free input otherwise.
      const preset = selectors.wallet.amountOption(page, Math.round(amountUsd));
      if (await preset.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await preset.check();
      } else {
        await selectors.wallet.amountInput(page).fill(amountUsd.toFixed(2));
      }
      await selectors.wallet.payButton(page).click();
      await this.step("topup-submitted", page);

      await selectors.wallet
        .successMarker(page)
        .or(selectors.confirm.declinedMessage(page))
        .first()
        .waitFor();
      if (await selectors.confirm.declinedMessage(page).isVisible()) {
        return this.fail(page, "payment_declined", "ParkNYC refused the wallet top-up");
      }
      const balance = await this.readWalletBalanceCents(page);
      return {
        ok: true,
        providerSessionId: "topup",
        expiresAt: new Date(),
        amountUsd: balance ?? -1,
      };
    });
    if (!flow.ok) return flow;
    return { ok: true, walletBalanceCents: flow.amountUsd >= 0 ? flow.amountUsd : null };
  }
}
