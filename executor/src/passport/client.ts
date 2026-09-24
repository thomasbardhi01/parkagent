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
 * The gated entry / T&C / e-mail verification screens, the Enter Zone
 * screen (#zoneNumber, #zoneNext), the Review Signage popup, and the
 * Vehicles chooser (#vehicleManagement, 2026-09-22) are verified against
 * recordings. The START, EXTEND, and STOP paths are all verified end to
 * end against real paid sessions (2026-09-23: start txn 831908580, and a
 * start→extend→stop walk on txn 831997285):
 *  - START: after the chooser it walks Length of Stay (#lengthOfStay) →
 *    duration picker (#durationPickerPage) → Payment Methods
 *    (#paymentMethod) → Your Cards (#creditCards) → the "Please Confirm"
 *    dialog (Yes pays) → the active-session screen.
 *  - EXTEND: from the session screen, Extend (#extendBtn — dispatched, its
 *    centre is under the countdown overlay) → the same Length of Stay →
 *    duration → confirm, landing BACK on the session screen with the new
 *    End time and cumulative fees (the success marker, not a receipt page).
 *  - STOP: ParkBoston zone 456 offers no early stop (session.js pushes
 *    #sessStopBtn only when the operator enables it; Boston meter time is
 *    non-refundable), so the stop flow returns stopNotSupported — there is
 *    no stop action and no refund.
 * A "Parking Denied" operator lockout can appear after the confirm-Yes
 * click with NO charge; it is typed parking_denied.
 */

import { existsSync } from "node:fs";

import type { Browser, BrowserContext, Locator, Page } from "playwright";
import { chromium } from "playwright";

import { warmBrowser } from "../browser.js";
import { captureUnexpectedScreen } from "../parknyc/capture.js";
import { classifyFailure } from "../parknyc/classify.js";
import { parseAmountUsd, parseConfirmation, parseExpiresAt } from "../parknyc/parse.js";
import {
  findVehicleOption,
  isFreePeriodModal,
  isParkingDeniedModal,
  parsePassportReceipt,
  parseProviderHours,
  parseVehicleChooser,
  recentZonesState,
} from "./parse.js";
import { handleSignageModal, waitForPopupSettled } from "./signage.js";
import { parseSavedCardLabel } from "../savedCard.js";
import type {
  CardFormDetails,
  ExecutorError,
  ExecutorResult,
  ProviderOpResult,
  ProviderZoneTerms,
  ReadSavedCardResult,
  StorageStateValue,
  TopupWalletResult,
  VerifyAccountResult,
  ZoneResolution,
} from "../types.js";
import { BOSTON_BASE_URL, findParkingSelectors, passportUrls, selectors } from "./selectors.js";
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
  /** Diagnostic sink for the stable-click layer (which path it took). */
  log?: (message: string) => void;
  recordHarPath?: string;
  tracePath?: string;
  /** Recon walks only (record --abort-after): stop the flow right before
   * the duration Continue — the earliest click that could charge
   * (post-#pickerNext behavior is use_default_card, TODO-verify). */
  stopBeforePay?: boolean;
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

  /**
   * Click that survives jQuery Mobile page transitions. The app animates
   * pages in/out (slide/pop/fade), so a target's box keeps moving and
   * Playwright's actionability check never settles → timeout. Before every
   * click we wait for the active page's transition to finish (no in/out/
   * transition-type classes on any .ui-page) AND the target's bounding box
   * to hold still across two animation frames, scroll it into view, then
   * click. On a stability timeout we retry once with a forced click. The
   * path taken is logged.
   */
  private async stableClick(page: Page, locator: Locator, name: string): Promise<void> {
    const settleMs = Math.min(this.timeoutMs, 8_000);
    // 1. Page transition settled: an active page exists and no .ui-page
    //    carries a jQM transition token.
    await page
      .waitForFunction(
        () => {
          const doc = (globalThis as { document?: unknown }).document as {
            querySelector(s: string): unknown;
            querySelectorAll(s: string): ArrayLike<{ classList: { contains(t: string): boolean } }>;
          };
          const TOKENS = [
            "in",
            "out",
            "slide",
            "slideup",
            "slidedown",
            "fade",
            "pop",
            "flip",
            "turn",
          ];
          if (!doc.querySelector(".ui-page-active")) return false;
          const pages = Array.from(doc.querySelectorAll(".ui-page"));
          return !pages.some((p) => TOKENS.some((t) => p.classList.contains(t)));
        },
        { timeout: settleMs },
      )
      .catch(() => {});
    // 2. Target box stable across two animation frames.
    const handle = await locator.elementHandle({ timeout: settleMs }).catch(() => null);
    let stable = false;
    if (handle) {
      stable = await page
        .waitForFunction(
          (el: {
            getBoundingClientRect(): { top: number; left: number; width: number; height: number };
          }) =>
            new Promise<boolean>((resolve) => {
              const raf = (
                globalThis as unknown as { requestAnimationFrame: (cb: () => void) => void }
              ).requestAnimationFrame;
              const a = el.getBoundingClientRect();
              raf(() =>
                raf(() => {
                  const b = el.getBoundingClientRect();
                  resolve(
                    a.top === b.top &&
                      a.left === b.left &&
                      a.width === b.width &&
                      a.height === b.height,
                  );
                }),
              );
            }),
          handle,
          { timeout: settleMs },
        )
        .then(() => true)
        .catch(() => false);
      await handle.dispose();
    }
    await locator.scrollIntoViewIfNeeded({ timeout: settleMs }).catch(() => {});
    try {
      await locator.click({ timeout: settleMs });
      this.options.log?.(`stableClick ${name}: normal${stable ? "" : " (box never settled)"}`);
    } catch {
      // Actionability never settled — force through the moving overlay.
      await locator.click({ force: true });
      this.options.log?.(`stableClick ${name}: forced (actionability timeout)`);
    }
  }

  /**
   * READ-ONLY recon of the Find Parking (map) screen: navigate there with
   * the saved session, capture every getnearzoneswithoccupancy JSON
   * response (the map list's zones-by-location feed), and — when a query
   * is given — type it into the search field and capture the autocomplete
   * plus the resulting nearby zones. Pays for NOTHING; never touches the
   * duration/pay path. Returns what the route actually served so we can
   * judge it as a zone-number source.
   */
  async findParking(
    query?: string,
    coords?: { lat: number; lng: number },
  ): Promise<
    | {
        ok: true;
        landedOnFindParking: boolean;
        hasSearchField: boolean;
        hasMap: boolean;
        nearbyResponses: unknown[];
        autocomplete: string[];
      }
    | ExecutorError
  > {
    const opened = await this.open();
    if ("ok" in opened) return opened;
    const { page } = opened;

    // The map's "near me" load geolocates the browser; headless has none,
    // so point it at the query location to exercise the real Boston feed.
    if (coords && this.context) {
      await this.context.grantPermissions(["geolocation"], { origin: this.urls.root });
      await this.context.setGeolocation({ latitude: coords.lat, longitude: coords.lng });
    }

    const nearbyResponses: unknown[] = [];
    page.on("response", (response) => {
      if (!response.url().includes(findParkingSelectors.nearbyZonesApi)) return;
      response
        .json()
        .then((body) => nearbyResponses.push(body))
        .catch(() => {
          /* non-JSON error body — ignore, the count still tells the story */
        });
    });

    try {
      await page.goto(this.urls.findParking);
      await this.step("find-parking", page);

      // Did we land on the map, or get bounced to Enter Zone / sign-in?
      const searchField = page.locator(findParkingSelectors.searchField);
      // jQuery-Mobile reveals the search field a beat after the page div;
      // wait for it rather than racing the transition.
      await searchField.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
      const hasSearchField = (await searchField.count()) > 0 && (await searchField.isVisible());
      const hasMap = (await page.locator(findParkingSelectors.mapCanvas).count()) > 0;
      const landedOnFindParking = hasSearchField || hasMap;

      const autocomplete: string[] = [];
      if (query && hasSearchField) {
        await searchField.click();
        await searchField.fill(query);
        // Autocomplete + list are async off the keystroke; give the map
        // API a moment, then snapshot whatever came back.
        await page.waitForTimeout(4000);
        await this.step("find-parking-search", page);
        const items = page.locator(`${findParkingSelectors.autocompleteList} li`);
        const n = Math.min(await items.count(), 12);
        for (let i = 0; i < n; i += 1) {
          autocomplete.push((await items.nth(i).innerText()).trim());
        }
      } else {
        // No query: the crosshair "near me" load still fires the API.
        await page.waitForTimeout(3000);
      }

      return {
        ok: true as const,
        landedOnFindParking,
        hasSearchField,
        hasMap,
        nearbyResponses,
        autocomplete,
      };
    } catch (err) {
      return this.fail(
        page,
        classifyFailure(err, null),
        `find parking recon failed: ${String(err)}`,
      );
    }
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

  /**
   * Your Cards (#creditCards, VERIFIED live 2026-09-23): after Payment
   * Methods → Credit/Debit Card the app lists the saved cards. Click the
   * first saved card (accounts here have one); Add Card is NEVER clicked.
   * A no-op when the screen doesn't appear (single-method accounts may
   * skip straight to the confirmation).
   */
  private async chooseSavedCard(page: Page, stepName: string): Promise<void> {
    await selectors.cards
      .page(page)
      .or(selectors.confirm.dialog(page))
      .first()
      .waitFor({ state: "visible", timeout: 10_000 })
      .catch(() => {});
    if (
      !(await selectors.cards
        .page(page)
        .isVisible()
        .catch(() => false))
    ) {
      return;
    }
    const card = selectors.cards.cardItems(page).first();
    const description = (await card.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    this.options.log?.(`choosing saved card: ${description || "(unlabeled)"}`);
    await this.stableClick(page, card, "saved-card");
    await this.step(stepName, page);
  }

  /**
   * The "Please Confirm" pay dialog (VERIFIED live 2026-09-23) is a
   * jQuery-Mobile popup that fades in behind a .ui-popup-screen overlay —
   * the same trap as Review Signage. Clicking Yes during the fade lands on
   * the overlay and times out, so wait for the popup to settle, then click
   * Yes with a dispatchEvent fallback past the overlay. This click is what
   * PAYS; returning true means it landed (the dialog closed) or a receipt-
   * style pay button was clicked instead. Returns false only when no
   * confirm control could be found.
   */
  private async confirmPay(page: Page, stepName: string): Promise<boolean> {
    const dialog = selectors.confirm.dialog(page);
    const yes = selectors.confirm.dialogYes(page);
    // Either the jQM confirm dialog fades in, or a receipt-style page with a
    // labeled pay button renders — wait for whichever comes first.
    await dialog
      .or(selectors.confirm.payButton(page))
      .first()
      .waitFor({ state: "visible", timeout: 10_000 })
      .catch(() => {});

    if (await dialog.isVisible().catch(() => false)) {
      const settled = await waitForPopupSettled(page, dialog, 5_000);
      if (!settled) this.options.log?.(`${stepName}: confirm popup never settled; clicking anyway`);
      await yes.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
      try {
        await this.stableClick(page, yes, stepName);
      } catch (err) {
        this.options.log?.(`${stepName}: Yes click failed (${String(err).split("\n")[0]})`);
      }
      // If the dialog is still up (overlay ate the click), dispatch straight
      // on the button, past pointer interception.
      const closed = await dialog
        .waitFor({ state: "hidden", timeout: 3_000 })
        .then(() => true)
        .catch(() => false);
      if (!closed) {
        this.options.log?.(`${stepName}: dialog still open; dispatching click`);
        await yes.dispatchEvent("click").catch(() => {});
      }
      return true;
    }

    // No jQM dialog — a receipt-style page. Use the labeled pay button.
    const payButton = selectors.confirm.payButton(page);
    if (await payButton.isVisible().catch(() => false)) {
      await this.stableClick(page, payButton, stepName);
      return true;
    }
    return false;
  }

  /**
   * Click by dispatching the DOM click event straight on the element,
   * bypassing Playwright's hit-testing. The active-session screen
   * (#sessionButtonsDesktop) lays Extend / Discount / Zone Info as
   * full-width buttons whose CENTRE is covered by the countdown timer
   * overlay, so a normal OR forced click lands on the overlay, not the
   * button (VERIFIED live 2026-09-23: a forced #extendBtn click left the
   * page on #session; dispatchEvent advanced it to Length of Stay). Use
   * this only for those session-screen actions — every other screen's
   * buttons take stableClick.
   */
  private async dispatchClick(page: Page, locator: Locator, name: string): Promise<void> {
    await locator.waitFor({ state: "attached", timeout: this.timeoutMs }).catch(() => {});
    await locator.dispatchEvent("click");
    this.options.log?.(`dispatchClick ${name}`);
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
   *
   * `vehicle` is the session's plate from the server's vehicles table; the
   * Vehicles chooser (the screen after signage, verified 2026-09-22) lists
   * saved vehicles as "<PLATE> (<STATE>)" buttons and the flow clicks the
   * matching one — no match is a typed vehicle_missing, never Add Vehicle.
   */
  async startSession(
    zoneNumber: string,
    vehicle: { plate: string; state?: string } | undefined,
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
    // Filled when the flow crosses the Vehicles chooser; merged onto the
    // final result (success OR failure) after the run, so terms the
    // provider showed are never lost to a later derailment.
    let providerTerms: ProviderZoneTerms | undefined;
    let chooserResolution: ZoneResolution | undefined;
    const result = await this.run(goal, page, async () => {
      // Enter Zone (VERIFIED against the 2026-09-21 recording: input
      // #zoneNumber type=tel "Zone Number", button #zoneNext "Continue").
      await page.goto(this.urls.zoneEntry);
      await this.step("zone-entry", page);
      if (await this.atGatedEntry(page)) {
        return this.fail(page, "auth_expired", "Passport asked to sign in; state is stale");
      }
      await selectors.zone.zoneNumberInput(page).fill(zoneNumber);
      // The recent-zones panel pops on input focus and, when the account
      // has recent zones, renders right after #zoneNext and shifts/
      // overlays it — clicking Continue then times out on actionability
      // (2026-09-21 regression). Blur to collapse the panel, wait for it
      // to go away, then click Continue once it's actionable.
      await selectors.zone
        .zoneNumberInput(page)
        .blur()
        .catch(() => {});
      if (recentZonesState(await page.content()).visible) {
        await page.keyboard.press("Escape").catch(() => {});
        await selectors.zone
          .recentZonesPanel(page)
          .waitFor({ state: "hidden", timeout: 3_000 })
          .catch(() => {});
      }
      await this.stableClick(page, selectors.zone.nextButton(page), "zone-continue");
      await this.step("zone-submitted", page);

      // After submit the app renders ONE of: a rejection message, the "No
      // Meter Parking" notice, the Review Signage interstitial, the zone
      // info panel, or the duration picker — all a beat after the POST
      // returns. isVisible({ timeout }) does NOT wait (Playwright ignores
      // the option), so wait here, once, for whichever appears first
      // before branching. Racing past a late popup was the 2026-09-22
      // regression: the flow clicked into the hidden duration page while
      // Review Signage sat on top ("Element is not visible" on
      // #pickerNext; fixture passport-start-2026-09-22T15-09-13-438Z).
      await selectors.zone
        .notFoundMessage(page)
        .or(selectors.zone.anyActivePopup(page))
        .or(selectors.zoneInfo.selectZoneButton(page))
        .or(selectors.vehicle.chooserMarker(page))
        .or(selectors.lengthOfStay.page(page))
        .or(selectors.duration.pickerPage(page))
        .first()
        .waitFor({ state: "visible", timeout: 10_000 })
        .catch(() => {});

      if (
        await selectors.zone
          .notFoundMessage(page)
          .isVisible()
          .catch(() => false)
      ) {
        return this.fail(page, "zone_not_found", `Passport rejected zone ${zoneNumber}`);
      }

      // "No Meter Parking" after-hours notice: the provider says this
      // zone isn't charging now (e.g. after 8pm). Read the message, click
      // Ok, and return a typed free_period so the server records a free
      // period rather than a payment failure — nothing is charged.
      // The locator waits for the popup; the pure detector (pinned by the
      // free-period fixture) confirms the classification — it additionally
      // requires the Ok button we are about to click.
      const freeModal = selectors.zone.freePeriodModal(page);
      if (
        // One-shot on purpose: the combined wait above already gave the
        // screen time to render ({ timeout } on isVisible is a no-op).
        (await freeModal.isVisible().catch(() => false)) &&
        isFreePeriodModal(await page.content())
      ) {
        const rawText = (
          await freeModal
            .first()
            .innerText()
            .catch(() => "")
        )
          .replace(/\s+/g, " ")
          .trim();
        await this.stableClick(page, selectors.zone.freePeriodOk(page), "free-period-ok");
        await this.step("free-period", page);
        return {
          ok: false,
          code: "free_period",
          message: rawText || "No Meter Parking — this zone is not charging now",
          freePeriod: { rawText, hours: parseProviderHours(rawText) },
        };
      }

      // Optional "Review Signage" interstitial (operator-configured; may
      // or may not appear). handleSignageModal waits for the popup or the
      // screen after it, lets the fade finish (ui-popup-active + computed
      // opacity 1 + no transition running), clicks the visible Continue,
      // and falls back to dispatching the click event if the modal
      // survives. Never fails when the modal is absent.
      const signageHandled = await handleSignageModal(page, {
        click: (locator, name) => this.stableClick(page, locator, name),
        log: this.options.log,
      });
      if (signageHandled) {
        // Prove the flow moved on before stepping: the next screen (zone
        // info, the Vehicles chooser — the live 2026-09-22 path — or the
        // duration picker) is up, not just the modal gone.
        await selectors.zoneInfo
          .selectZoneButton(page)
          .or(selectors.vehicle.chooserMarker(page))
          .or(selectors.lengthOfStay.page(page))
          .or(selectors.duration.pickerPage(page))
          .first()
          .waitFor({ state: "visible", timeout: 10_000 })
          .catch(() => {});
        await this.step("signage-dismissed", page);
      }

      // After a valid zone the app shows the zone's info (rates) with a
      // Select Zone button, or goes straight on — both drafted from the
      // shipped view source, TODO-verify on the first paid recording.
      const selectZone = selectors.zoneInfo.selectZoneButton(page);
      if (await selectZone.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await this.stableClick(page, selectZone, "select-zone");
        // Wait for whichever screen follows before the one-shot visibility
        // checks below ({ timeout } on isVisible is a no-op).
        await selectors.vehicle
          .chooserMarker(page)
          .or(selectors.lengthOfStay.page(page))
          .or(selectors.duration.pickerPage(page))
          .first()
          .waitFor({ state: "visible", timeout: 10_000 })
          .catch(() => {});
        await this.step("zone-selected", page);
      }

      // Vehicles chooser (#vehicleManagement, VERIFIED live 2026-09-22):
      // one button per saved vehicle labeled "<PLATE> (<STATE>)", an Add
      // Vehicle button, and the zone's terms line. Click the button
      // matching the session's vehicle; a missing plate is a typed
      // vehicle_missing (the server pushes "add your plate"), and Add
      // Vehicle is NEVER clicked — the driver manages their own vehicles.
      // One-shot visibility on purpose: the waits above already gave the
      // screen time to render.
      if (
        await selectors.vehicle
          .chooserMarker(page)
          .isVisible()
          .catch(() => false)
      ) {
        const chooser = parseVehicleChooser(await page.content());
        if (chooser) {
          // The header echoes the zone the provider resolved — record it
          // as a non-fatal cross-check against the number we typed, and
          // keep the Zone Information terms for the server's
          // zone_terms_observed comparison.
          if (chooser.terms) providerTerms = chooser.terms;
          if (chooser.zoneNumber !== null) {
            chooserResolution = {
              mapZoneNumber: chooser.zoneNumber,
              mapStreet: chooser.zoneName ?? "",
              storedZoneNumber: zoneNumber,
              expectedStreet: null,
              matched: chooser.zoneNumber === zoneNumber,
            };
          }
        }
        const option = vehicle ? findVehicleOption(chooser?.vehicles ?? [], vehicle) : null;
        if (option === null) {
          const saved = (chooser?.vehicles ?? []).map((v) => v.description).join(", ") || "none";
          const wanted = vehicle
            ? `${vehicle.plate}${vehicle.state ? ` (${vehicle.state})` : ""}`
            : "(no plate given)";
          return this.fail(
            page,
            "vehicle_missing",
            `ParkBoston has no saved vehicle matching ${wanted}; saved: ${saved}`,
          );
        }
        await this.stableClick(
          page,
          selectors.vehicle.vehicleButton(page, option.description),
          "vehicle-select",
        );
        // Clicking the vehicle button advances the flow — the screen has
        // no Continue of its own (VERIFIED 2026-09-23: it advances to the
        // Length of Stay screen).
        await selectors.lengthOfStay
          .page(page)
          .or(selectors.duration.pickerPage(page))
          .first()
          .waitFor({ state: "visible", timeout: 10_000 })
          .catch(() => {});
        await this.step("vehicle-selected", page);
      }

      // Length of Stay (#lengthOfStay, VERIFIED live 2026-09-23): shortcut
      // stay buttons (e.g. "2 Hr ($7.85)" — the max stay, fee included)
      // plus "Choose Stay", which opens the duration picker. Always go
      // through Choose Stay so the requested minutes are exact.
      if (
        await selectors.lengthOfStay
          .page(page)
          .isVisible()
          .catch(() => false)
      ) {
        await this.stableClick(page, selectors.lengthOfStay.chooseStayButton(page), "choose-stay");
        await selectors.duration
          .pickerPage(page)
          .waitFor({ state: "visible", timeout: 10_000 })
          .catch(() => {});
        await this.step("length-of-stay", page);
      }

      // Duration picker (#durationPickerPage, VERIFIED ids 2026-09-21):
      // day/hour/minute steppers. Reach the requested minutes with hour
      // and minute (#minPlus) increments; the minute stepper's step is
      // assumed 15 (TODO-verify against a paid run's #minTimeText).
      if (
        await selectors.duration
          .pickerPage(page)
          .isVisible({ timeout: 5_000 })
          .catch(() => false)
      ) {
        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;
        for (let i = 0; i < hours; i += 1) {
          await this.stableClick(page, selectors.duration.hourPlus(page), "hour-plus");
        }
        for (let i = 0; i < Math.round(mins / DURATION_STEP_MINUTES); i += 1) {
          await this.stableClick(page, selectors.duration.minPlus(page), "min-plus");
        }
      }
      if (this.options.stopBeforePay) {
        await this.step("stopped-before-pay", page);
        return {
          ok: false,
          code: "unknown",
          message: "stopped before the duration Continue (stopBeforePay recon walk); nothing paid",
        };
      }
      await this.stableClick(page, selectors.duration.continueButton(page), "duration-continue");
      await this.step("duration-selected", page);

      // Payment Methods chooser (VERIFIED live 2026-09-23): Wallet vs
      // Credit/Debit Card. Take the card on file; the chooser may be
      // skipped entirely when the account has only one method.
      await selectors.paymentMethod
        .page(page)
        .or(selectors.confirm.dialog(page))
        .first()
        .waitFor({ state: "visible", timeout: 10_000 })
        .catch(() => {});
      if (
        await selectors.paymentMethod
          .page(page)
          .isVisible()
          .catch(() => false)
      ) {
        await this.stableClick(
          page,
          selectors.paymentMethod.creditCardButton(page),
          "payment-method-card",
        );
        await this.step("payment-method", page);
      }

      await this.chooseSavedCard(page, "card-chosen");

      // The pay click (VERIFIED live 2026-09-23): the "Please Confirm"
      // jQuery-Mobile dialog's Yes, or a labeled pay button on older
      // receipt-style variants. This is what charges the card. (No total
      // gate — Passport splits "Total Fee:" and "$1.10" across two nodes,
      // so confirmPay waits on the dialog/button itself.)
      if (!(await this.confirmPay(page, "confirm-yes"))) {
        return this.fail(page, "ui_changed", "no pay confirmation control on the confirm screen");
      }
      await this.step("payment-submitted", page);

      // After Yes the app shows a brief "Loading session details…" then the
      // active-session screen (VERIFIED live 2026-09-23). Wait for one of:
      // the loaded session screen (paid + active), a decline, the "Add
      // Payment Details" page (no card on file), or the "Parking Denied"
      // lockout popup (the operator refused re-parking — no charge). The
      // isVisible checks are active-page/popup-scoped — hidden SPA pages
      // don't count — so the ever-present add-card markup can't false-fire.
      await selectors.session
        .activeMarker(page)
        .or(selectors.confirm.declinedMessage(page))
        .or(selectors.payment.addPaymentHeader(page))
        .or(selectors.zone.parkingDeniedModal(page))
        .first()
        .waitFor({ state: "visible", timeout: 20_000 })
        .catch(() => {});

      // "Parking Denied" lockout: the operator blocked re-parking in this
      // zone (repark/zone lockout). VERIFIED live 2026-09-23 — it appears
      // AFTER the confirm-Yes click but the card is NOT charged. Typed so
      // the server tells the user to wait/move rather than "add a card" or
      // "tap to pay" (which would just be denied again).
      if (
        (await selectors.zone
          .parkingDeniedModal(page)
          .isVisible()
          .catch(() => false)) &&
        isParkingDeniedModal(await page.content())
      ) {
        const rawText = (
          await selectors.zone
            .parkingDeniedModal(page)
            .first()
            .innerText()
            .catch(() => "")
        )
          .replace(/\s+/g, " ")
          .trim();
        await this.stableClick(page, selectors.zone.parkingDeniedOk(page), "parking-denied-ok");
        await this.step("parking-denied", page);
        return {
          ok: false,
          code: "parking_denied",
          message:
            rawText || "ParkBoston: the operator has a lockout period on this zone right now",
        };
      }
      if (
        await selectors.payment
          .addPaymentHeader(page)
          .isVisible()
          .catch(() => false)
      ) {
        return this.fail(
          page,
          "payment_method_missing",
          "ParkBoston has no saved payment method on this account",
        );
      }
      if (
        await selectors.confirm
          .declinedMessage(page)
          .isVisible()
          .catch(() => false)
      ) {
        return this.fail(page, "payment_declined", "Passport refused the payment");
      }
      // The session screen is up: money has moved and the meter is running.
      await selectors.session
        .activeMarker(page)
        .first()
        .waitFor({ state: "visible", timeout: 10_000 });
      await this.step("session-active", page);

      // Report the ACTUAL charged amount from the receipt, not the server's
      // pre-charge estimate: ParkBoston sells in a per-zone duration
      // increment (zone 456: 12-minute increments) so a 15-minute request
      // is billed as 12 minutes ($0.75). The confirm dialog / session
      // screen lists "Parking Fee: $0.75 / Convenience Fee: $0.35 / Total
      // Fee: $1.10" — parse it so the audit matches the card to the cent.
      const now = new Date();
      const text = await page.innerText("body");
      const receipt = parsePassportReceipt(text);
      const amountUsd = receipt?.totalUsd ?? parseAmountUsd(text) ?? -1;
      const parsed = parseConfirmation(text, now);
      const providerSessionId = parsed?.providerSessionId ?? `passport-${now.getTime()}`;
      const expiresAt =
        parsed?.expiresAt ??
        parseExpiresAt(text, now) ??
        new Date(now.getTime() + minutes * 60_000);
      return {
        ok: true,
        providerSessionId,
        expiresAt,
        amountUsd,
        ...(receipt ? { receipt } : {}),
      };
    });
    if (result.ok) {
      return {
        ...result,
        ...(chooserResolution ? { zoneResolution: chooserResolution } : {}),
        ...(providerTerms ? { providerTerms } : {}),
      };
    }
    return { ...result, ...(providerTerms ? { providerTerms } : {}) };
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
      // session.js injects the action buttons a beat after navigation
      // (containers empty on first paint — 2026-09-23), so wait for Extend
      // first. Its centre is under the countdown overlay, so DISPATCH the
      // click on the element (a normal/forced click hits the overlay).
      await selectors.session
        .extendButton(page)
        .waitFor({ state: "visible", timeout: 15_000 })
        .catch(() => {});
      await this.dispatchClick(page, selectors.session.extendButton(page), "extend-open");
      // Extend advances to Length of Stay (VERIFIED live 2026-09-23), the
      // same screen start reaches after the Vehicles chooser.
      await selectors.lengthOfStay
        .page(page)
        .or(selectors.duration.pickerPage(page))
        .first()
        .waitFor({ state: "visible", timeout: 10_000 })
        .catch(() => {});
      await this.step("extend-opened", page);

      // "No Meter Parking" can meet an extension at the enforcement
      // boundary too (auto-extend firing near 8pm). A real waitFor, not
      // isVisible({timeout}) — Playwright ignores that timeout and the
      // popup is injected a beat after the click (the #106 lesson). The
      // typed free_period lets the server hold and say "parking is free
      // now" instead of pushing a payment failure. (Placement drafted,
      // TODO-verify: no extend recording crosses the boundary yet.)
      const extendFreeModal = selectors.zone.freePeriodModal(page);
      if (
        (await extendFreeModal
          .waitFor({ state: "visible", timeout: 3_000 })
          .then(() => true)
          .catch(() => false)) &&
        isFreePeriodModal(await page.content())
      ) {
        const rawText = (
          await extendFreeModal
            .first()
            .innerText()
            .catch(() => "")
        )
          .replace(/\s+/g, " ")
          .trim();
        await this.stableClick(page, selectors.zone.freePeriodOk(page), "extend-free-period-ok");
        await this.step("extend-free-period", page);
        return {
          ok: false,
          code: "free_period",
          message: rawText || "No Meter Parking — this zone is not charging now",
          freePeriod: { rawText, hours: parseProviderHours(rawText) },
        };
      }

      // Length of Stay can front the extend picker too, like at start.
      if (
        await selectors.lengthOfStay
          .page(page)
          .isVisible()
          .catch(() => false)
      ) {
        await this.stableClick(
          page,
          selectors.lengthOfStay.chooseStayButton(page),
          "extend-choose-stay",
        );
        await selectors.duration
          .pickerPage(page)
          .waitFor({ state: "visible", timeout: 10_000 })
          .catch(() => {});
        await this.step("extend-length-of-stay", page);
      }

      // Same duration picker as start (TODO-verify for the extend entry).
      if (
        await selectors.duration
          .pickerPage(page)
          .isVisible({ timeout: 5_000 })
          .catch(() => false)
      ) {
        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;
        for (let i = 0; i < hours; i += 1) {
          await this.stableClick(page, selectors.duration.hourPlus(page), "extend-hour-plus");
        }
        for (let i = 0; i < Math.round(mins / DURATION_STEP_MINUTES); i += 1) {
          await this.stableClick(page, selectors.duration.minPlus(page), "extend-min-plus");
        }
      }
      if (this.options.stopBeforePay) {
        await this.step("stopped-before-pay", page);
        return {
          ok: false,
          code: "unknown",
          message: "stopped before the extend Continue (stopBeforePay recon walk); nothing paid",
        };
      }
      await this.stableClick(
        page,
        selectors.duration.continueButton(page),
        "extend-duration-continue",
      );
      // Same Payment Methods chooser as start (card on file).
      await selectors.paymentMethod
        .page(page)
        .or(selectors.confirm.dialog(page))
        .first()
        .waitFor({ state: "visible", timeout: 10_000 })
        .catch(() => {});
      if (
        await selectors.paymentMethod
          .page(page)
          .isVisible()
          .catch(() => false)
      ) {
        await this.stableClick(
          page,
          selectors.paymentMethod.creditCardButton(page),
          "extend-payment-method-card",
        );
        await this.step("extend-payment-method", page);
      }
      await this.chooseSavedCard(page, "extend-card-chosen");
      if (!(await this.confirmPay(page, "extend-confirm-yes"))) {
        return this.fail(
          page,
          "ui_changed",
          "no pay confirmation control on the extend confirm screen",
        );
      }
      await this.step("extend-payment-submitted", page);

      // The extension returns to the ACTIVE SESSION screen with the NEW End
      // time and CUMULATIVE fees (VERIFIED live 2026-09-23: a 15-min extend
      // took End 2:58→3:11 PM and the fees to $1.50/$0.70/$2.20 total) — NOT
      // a separate receipt page, so the success marker is the session screen,
      // like start. A decline / lockout still shows its own popup first.
      await selectors.session
        .activeMarker(page)
        .or(selectors.confirm.declinedMessage(page))
        .or(selectors.zone.parkingDeniedModal(page))
        .first()
        .waitFor({ state: "visible", timeout: 20_000 })
        .catch(() => {});
      if (
        (await selectors.zone
          .parkingDeniedModal(page)
          .isVisible()
          .catch(() => false)) &&
        isParkingDeniedModal(await page.content())
      ) {
        await this.stableClick(
          page,
          selectors.zone.parkingDeniedOk(page),
          "extend-parking-denied-ok",
        );
        return {
          ok: false,
          code: "parking_denied",
          message: "ParkBoston: the operator has a lockout period on this zone right now",
        };
      }
      if (
        await selectors.confirm
          .declinedMessage(page)
          .isVisible()
          .catch(() => false)
      ) {
        return this.fail(page, "payment_declined", "Passport refused the extension payment");
      }
      await selectors.session
        .activeMarker(page)
        .first()
        .waitFor({ state: "visible", timeout: 10_000 });
      await this.step("extend-confirmation", page);

      // The new expiry is the session screen's "End:" clock. The fees shown
      // are CUMULATIVE for the whole session (not this extension), and the
      // server records its own per-extension price, so amountUsd here is the
      // session's running total — informational only.
      const text = await page.innerText("body");
      const now = new Date();
      const expiresAt = parseExpiresAt(text, now);
      if (expiresAt === null) {
        return this.fail(
          page,
          "ui_changed",
          "extension confirmation did not carry the new end time",
        );
      }
      const parsed = parseConfirmation(text, now);
      return {
        ok: true,
        providerSessionId: parsed?.providerSessionId ?? providerSessionId,
        expiresAt,
        amountUsd: parsePassportReceipt(text)?.totalUsd ?? parseAmountUsd(text) ?? -1,
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
      // Wait for the session screen to finish rendering — session.js injects
      // the buttons a beat after navigation (both button containers empty on
      // first paint, 2026-09-23).
      await selectors.session
        .activeMarker(page)
        .first()
        .waitFor({ state: "visible", timeout: 15_000 })
        .catch(() => {});

      // Early stop is an OPERATOR OPTION (session.js pushes #sessStopBtn only
      // when stopParkingOptionEnabled). ParkBoston zone 456 does NOT enable
      // it — the button is never in the DOM (VERIFIED live 2026-09-23):
      // Boston meter time is non-refundable, so there is nothing to stop and
      // no refund. The paid session simply runs to its purchased end. Mark
      // the local session stopped (forfeiting the remaining paid time, which
      // has no cash value) and report it, rather than failing.
      await selectors.session
        .stopButton(page)
        .waitFor({ state: "attached", timeout: 4_000 })
        .catch(() => {});
      const stopOffered = (await selectors.session.stopButton(page).count()) > 0;
      if (!stopOffered) {
        this.options.log?.("stop: ParkBoston offers no early stop for this zone (non-refundable)");
        await this.step("stop-not-offered", page);
        return {
          ok: true,
          providerSessionId,
          expiresAt: new Date(),
          amountUsd: 0,
          stopNotSupported: true,
        };
      }
      // When an operator DOES enable stop, its button sits on the session
      // screen under the countdown overlay like Extend — dispatch the click,
      // then confirm on the jQM Yes dialog.
      await this.dispatchClick(page, selectors.session.stopButton(page), "stop");
      await selectors.session
        .stopConfirmButton(page)
        .waitFor({ state: "visible", timeout: 8_000 })
        .catch(() => {});
      await this.stableClick(page, selectors.session.stopConfirmButton(page), "stop-confirm");
      await this.step("stop-confirmed", page);
      // The stop only took if the Stop button is now gone (session ended). A
      // NON-swallowed wait here: if it never hides — the confirm didn't
      // register, or the provider showed a decline/error — this throws, the
      // run() wrapper types it, and the server keeps the session active
      // (fail-closed). NEVER report ok on an unconfirmed stop.
      await selectors.session.stopButton(page).waitFor({ state: "hidden" });
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
      // Same #updateCard "Add Payment Details" form the start flow detects.
      // Field ids verified against the recording; the SUBMIT (saveButton
      // → successMarker) is TODO-verify — not yet walked with a real card.
      await selectors.payment.cardNumberInput(page).fill(card.number);
      await selectors.payment
        .expiryMonthSelect(page)
        .selectOption(String(card.expMonth).padStart(2, "0"));
      await selectors.payment.expiryYearSelect(page).selectOption(String(card.expYear));
      await selectors.payment.cvcInput(page).fill(card.cvc);
      await selectors.payment.saveButton(page).click(); // TODO-verify: submit + success
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

  /**
   * Read the account's own saved card off Your Cards (#creditCards,
   * VERIFIED live 2026-09-23 — rows read "<Name> (<last4>)"). Display data
   * for provider_card users, captured at link time; nothing is clicked and
   * no cards listed is a success with nulls.
   */
  async readSavedCard(): Promise<ReadSavedCardResult> {
    const opened = await this.open();
    if ("ok" in opened) return opened;
    const { page } = opened;

    let label: string | null = null;
    const flow = await this.run("read saved card", page, async () => {
      await page.goto(this.urls.paymentMethods);
      await this.step("your-cards", page);
      if (await this.atGatedEntry(page)) {
        return this.fail(
          page,
          "auth_expired",
          "Passport asked to sign in; cookies are not a session",
        );
      }
      const first = selectors.cards.cardItems(page).first();
      const listed = await first
        .waitFor({ state: "visible", timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
      if (listed) {
        label = (await first.innerText().catch(() => "")).replace(/\s+/g, " ").trim() || null;
      }
      return { ok: true, providerSessionId: "read-card", expiresAt: new Date(), amountUsd: 0 };
    });
    if (!flow.ok) return flow;
    return { ok: true, ...(label ? parseSavedCardLabel(label) : { brand: null, last4: null }) };
  }
}
