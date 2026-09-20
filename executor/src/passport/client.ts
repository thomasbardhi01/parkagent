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
 * Zone resolution is map-first: Boston's open data has NO ParkBoston zone
 * numbers, so startSession centers the provider's own Find Parking map on
 * the car's coordinates (context geolocation), opens the nearest zone pin,
 * and reads the zone number and street off the panel. A panel street that
 * disagrees with the street our zone data carries refuses with
 * zone_mismatch — paying the wrong block is worse than not paying.
 *
 * Only the gated entry / T&C / e-mail verification screens have been walked
 * live (headless, 2026-09-20). Every signed-in flow below is drafted from
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
  ZoneResolution,
} from "../types.js";
import type { ZonePanel } from "./parse.js";
import { parseZoneNumberText, streetsMatch } from "./parse.js";
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

/** Coordinates + expectation for the map-based zone resolution. */
export interface ZoneResolveArgs {
  carLat: number;
  carLng: number;
  /** Refuse with zone_mismatch when the panel street disagrees; null/absent
   * means we have nothing to check against (log-only). */
  expectedStreet?: string | null;
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
      // The Find Parking map centers on "my location": granting geolocation
      // and setting it to the car's fix is how we center the map on the car.
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
   * Map-based zone resolution: center the Find Parking map on the car,
   * open the nearest zone pin, and read the panel. Returns the panel or a
   * typed error; leaves the page ON the zone info panel so startSession can
   * continue with Select Zone. TODO-verify end to end (drafted from
   * find-parking.js / zone-info.js source).
   */
  async resolveZoneFromMap(args: ZoneResolveArgs): Promise<ZonePanel | ExecutorError> {
    const opened = await this.open();
    if ("ok" in opened) return opened;
    const { page } = opened;

    const outcome = await this.run(
      `resolve zone from map at ${args.carLat.toFixed(5)},${args.carLng.toFixed(5)}`,
      page,
      async () => {
        await this.context!.setGeolocation({ latitude: args.carLat, longitude: args.carLng });
        await page.goto(this.urls.findParking);
        await this.step("find-parking", page);
        if (await this.atGatedEntry(page)) {
          return this.fail(page, "auth_expired", "Passport asked to sign in; state is stale");
        }
        await selectors.map.canvas(page).waitFor();
        // Give the map a beat to geolocate, fetch nearby zones, drop pins.
        await selectors.map.markers(page).first().waitFor({ timeout: this.timeoutMs });
        await this.step("map-markers", page);

        // Nearest pin to the viewport center — the map is centered on the
        // car (geolocation), so the nearest pin to center is the nearest
        // zone to the car.
        const markers = selectors.map.markers(page);
        const count = await markers.count();
        const viewport = page.viewportSize() ?? { width: 800, height: 600 };
        const cx = viewport.width / 2;
        const cy = viewport.height / 2;
        let best = -1;
        let bestDist = Number.POSITIVE_INFINITY;
        for (let i = 0; i < count; i += 1) {
          const box = await markers.nth(i).boundingBox();
          if (!box) continue;
          const d = Math.hypot(box.x + box.width / 2 - cx, box.y + box.height / 2 - cy);
          if (d < bestDist) {
            bestDist = d;
            best = i;
          }
        }
        if (best < 0) {
          return this.fail(page, "zone_not_found", "no zone pins on the map at the car's location");
        }
        await markers.nth(best).click();
        await this.step("marker-clicked", page);

        // The info window's zone-name link opens the zone info panel.
        await selectors.map.infoWindowZoneLink(page).click();
        await selectors.zoneInfo.zoneNumber(page).waitFor();
        await this.step("zone-info", page);

        const zoneNoText = await selectors.zoneInfo.zoneNumber(page).innerText();
        const street = (await selectors.zoneInfo.zoneName(page).innerText()).trim();
        const zoneNumber = parseZoneNumberText(zoneNoText);
        if (zoneNumber === null || street.length === 0) {
          return this.fail(
            page,
            "ui_changed",
            `zone panel did not carry a readable zone number/street (saw "${zoneNoText}")`,
          );
        }
        // Success smuggled through the session-result shape; unwrapped below.
        return {
          ok: true,
          providerSessionId: `${zoneNumber} ${street}`,
          expiresAt: new Date(),
          amountUsd: 0,
        };
      },
    );
    if (!outcome.ok) return outcome;
    // First token is the zone number; the rest is the street (it has spaces).
    const sep = outcome.providerSessionId.indexOf(" ");
    return {
      zoneNumber: outcome.providerSessionId.slice(0, sep),
      street: outcome.providerSessionId.slice(sep + 1),
    };
  }

  /**
   * Start a session. Boston zones carry no zone number in our data, so when
   * car coordinates are given the zone is resolved from the provider's map
   * first; a stored zone number (other Passport cities) is used directly
   * when no coordinates are available.
   */
  async startSession(
    zoneNumber: string,
    plate: string | undefined,
    minutes: number,
    resolve?: ZoneResolveArgs,
  ): Promise<ExecutorResult> {
    const opened = await this.open();
    if ("ok" in opened) return opened;
    const { page } = opened;

    let zoneResolution: ZoneResolution | undefined;
    let effectiveZone = zoneNumber;
    let onZonePanel = false;

    if (resolve) {
      const panel = await this.resolveZoneFromMap(resolve);
      if ("ok" in panel) return panel; // typed error, capture attached
      const expected = resolve.expectedStreet ?? null;
      const matched =
        zoneNumber !== ""
          ? panel.zoneNumber === zoneNumber
          : expected !== null
            ? streetsMatch(expected, panel.street)
            : null;
      zoneResolution = {
        mapZoneNumber: panel.zoneNumber,
        mapStreet: panel.street,
        storedZoneNumber: zoneNumber,
        expectedStreet: expected,
        matched,
      };
      if (expected !== null && !streetsMatch(expected, panel.street)) {
        return this.fail(
          page,
          "zone_mismatch",
          `map zone ${panel.zoneNumber} is on "${panel.street}" but our zone data says "${expected}"`,
        );
      }
      effectiveZone = zoneNumber !== "" ? zoneNumber : panel.zoneNumber;
      onZonePanel = true;
    }
    if (effectiveZone === "") {
      return {
        ok: false,
        code: "zone_not_found",
        message: "no zone number and no car coordinates to resolve one from the map",
      };
    }

    const goal = `start ${minutes} min in zone ${effectiveZone}`;
    const result = await this.run(goal, page, async () => {
      if (onZonePanel) {
        // resolveZoneFromMap left us on the zone info panel.
        await selectors.zoneInfo.selectZoneButton(page).click();
      } else {
        await page.goto(this.urls.zoneEntry);
        await this.step("zone-entry", page);
        if (await this.atGatedEntry(page)) {
          return this.fail(page, "auth_expired", "Passport asked to sign in; state is stale");
        }
        await selectors.zone.zoneNumberInput(page).fill(effectiveZone);
        await selectors.zone.nextButton(page).click();
        await this.step("zone-submitted", page);
        if (
          await selectors.zone
            .notFoundMessage(page)
            .isVisible({ timeout: 3_000 })
            .catch(() => false)
        ) {
          return this.fail(page, "zone_not_found", `Passport rejected zone ${effectiveZone}`);
        }
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
