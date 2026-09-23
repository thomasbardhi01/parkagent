/**
 * PERSONAL-USE PROTOTYPE — this package drives a parking provider's own web
 * app with the owner's account, for the owner's own parking only. See the
 * header in ../types.ts and issue #37.
 *
 * EVERY selector the Passport client uses lives in this file, one entry per
 * UI element, grouped and commented by the screen it belongs to — a UI
 * change is a one-file fix.
 *
 * Passport runs the SAME white-label web app for many cities (ParkBoston is
 * `bostonma.ppprk.com`; ParkMobile-style peers live at other `<city>.ppprk.com`
 * subdomains, e.g. `parkbyapp.ppprk.com`). This client is therefore reusable
 * for another Passport city by swapping the base domain — everything below
 * takes the base URL from `passportUrls(base)`.
 *
 * Provenance of what's below:
 *  - VERIFIED live (headless, 2026-09-20): the gated entry screen (Sign In /
 *    Register / Continue as Guest, ids #registerBtn/#guestContinueBtn), the
 *    T&C interstitial (#acceptTermsConditionsBtn), and the e-mail/phone
 *    verification screen (#regEmail/#verify_email) behind "Sign In" — the
 *    app is passwordless: a short code, then a 4-digit PIN.
 *  - VERIFIED from the signed-in recording (2026-09-21,
 *    fixtures/passport-resolve-…, mirrored into
 *    test/fixtures/pages/passport/zone-entry.html): the Enter Zone screen —
 *    input #zoneNumber (type=tel, "Zone Number"), button #zoneNext
 *    ("Continue"). That recording also established the app has NO map:
 *    signed-in navigation lands on Enter Zone, so zone numbers must come
 *    from us, not from a Find Parking map.
 *  - VERIFIED live (2026-09-22, fixture passport-start-2026-09-22T15-45-19-408Z):
 *    the Vehicles chooser (#vehicleManagement) — the screen after Review
 *    Signage: #selectVehicleLabel header, button.selectVehicle per saved
 *    vehicle, #addVehicleButton, and the .zoneInfoLabel terms line.
 *  - FROM SHIPPED SOURCE, NOT YET WALKED (TODO-verify on the first paid
 *    `record` run): everything after the chooser — the zone info panel
 *    (#zi_*), duration, confirm, session, and card screens.
 */

import type { Locator, Page } from "playwright";

/** ParkBoston's instance of the Passport white-label web app. */
export const BOSTON_BASE_URL = "https://bostonma.ppprk.com/park/";

/**
 * Hash routes, from the app's Common.PageSlug table (shared/common.js).
 * jQuery-Mobile style: the hash is the page div's id. Unauthenticated
 * navigation to any of these bounces back to the gated entry screen.
 */
export function passportUrls(base: string = BOSTON_BASE_URL) {
  const root = base.endsWith("/") ? base : `${base}/`;
  return {
    /** The app's origin, for context permissions/geolocation. */
    root,
    /** Gated entry: Sign In / Register / Continue as Guest. This is the
     * screen the app's link web view starts on (VERIFIED live). */
    home: root,
    signIn: root,
    /** Passwordless login (e-mail/phone + code + PIN). */
    login: `${root}#login`,
    /** Type-a-zone-number entry — where every ParkBoston session starts
     * (fallback; but #findParking is a real map+search page — see below). */
    zoneEntry: `${root}#zoneEntry`,
    /** Find Parking: map + "Zone, address or landmark" search. Its list
     * is driven by the getnearzoneswithoccupancy API. VERIFIED to exist
     * in the shipped shell 2026-09-21 (overrides the earlier "no map"
     * note); confirm live with `record --flow findParking`. */
    findParking: `${root}#findParking`,
    /** One zone's panel: name/street, zone number, rates, Select Zone. */
    zoneInfo: `${root}#zoneInfoPage`,
    /** Duration picker after selecting a zone. */
    durationPicker: `${root}#durationPickerPage`,
    /** The active session screen (extend/stop live here). */
    session: `${root}#session`,
    /** Past sessions. */
    parkerHistory: `${root}#parkerHistory`,
    /** Profile — the signed-in marker verifyAccount looks for. */
    account: `${root}#profile`,
    /** Saved cards. */
    paymentMethods: `${root}#creditCards`,
    /** Add/replace a card. */
    updateCard: `${root}#updateCard`,
  } as const;
}

export type PassportUrls = ReturnType<typeof passportUrls>;

/** The find-parking (map) screen's search + list, from the shell markup. */
export const findParkingSelectors = {
  searchField: "#parkingSearchField",
  autocompleteList: "#parkingAutocompleteListView",
  nearbyList: "#parkRightZoneList",
  mapCanvas: "#map-canvas",
  /** The zones-by-location API the map list calls (POST, encrypted params;
   * the JSON RESPONSE is readable). */
  nearbyZonesApi: "getnearzoneswithoccupancy",
} as const;

export const selectors = {
  // ------------------------------------------------- Gated entry (VERIFIED)
  // Shown whenever the cookies are NOT a signed-in session — the
  // auth_expired witness, like ParkNYC's sign-in panel.
  gatedEntry: {
    signInButton: (page: Page): Locator => page.locator("#registerBtn"), // labeled "Sign In"
    guestButton: (page: Page): Locator => page.locator("#guestContinueBtn"),
    /** Any of the three entry ids ⇒ we are logged out. */
    marker: (page: Page): Locator => page.locator("#registerBtn, #guestContinueBtn"),
  },

  // ------------------------------------------ T&C interstitial (VERIFIED)
  terms: {
    acceptButton: (page: Page): Locator => page.locator("#acceptTermsConditionsBtn"),
  },

  // ------------------------- Login (ids from login.js/verify.js; VERIFIED
  // through the e-mail verification screen, PIN step TODO-verify)
  login: {
    phoneOrEmailInput: (page: Page): Locator =>
      page.locator("#phoneNumberEmailInput, #usernameInput").first(),
    loginButton: (page: Page): Locator => page.locator("#loginBtn"),
    verifyEmailInput: (page: Page): Locator => page.locator("#regEmail"),
    sendCodeButton: (page: Page): Locator => page.locator("#verify_email"),
    pinInput: (page: Page): Locator => page.locator("#confirmPin"),
  },

  // ---- Zone entry (VERIFIED, 2026-09-21 recording: zone-entry.html fixture)
  zone: {
    zoneNumberInput: (page: Page): Locator => page.locator("#zoneNumber"),
    nextButton: (page: Page): Locator => page.locator("#zoneNext"),
    /** Shown when the zone number is rejected (wording TODO-verify). */
    notFoundMessage: (page: Page): Locator =>
      page.getByText(/zone.*(not.*(found|recognized|valid)|invalid)/i),
    /** The optional "Review Signage" interstitial that can appear after
     * Enter Zone: a popup with signage/meter-hours text and
     * Continue/Cancel. Operator-configured, so matched by structure +
     * keyword, not exact wording. */
    // Scope to the OPEN popup container (jQM keeps hidden popup copies in
    // the DOM, and TWO can be ui-popup-active at once); the signage one
    // has no id, so match it by its text. Verified live 2026-09-21.
    signageModal: (page: Page): Locator =>
      page
        .locator(".ui-popup-container.ui-popup-active")
        .filter({ hasText: /signage|meter hours|parking restrictions/i }),
    // The real Continue is a normal-sized in-popup button; the same popup
    // markup also carries zero-size "Continue" duplicates (.submit,
    // #saveProfile), so filter to the VISIBLE one — resolves to exactly 1.
    signageContinue: (page: Page): Locator =>
      page
        .locator(".ui-popup-container.ui-popup-active")
        .filter({ hasText: /signage|meter hours|parking restrictions/i })
        .getByRole("button", { name: /continue|ok|got it|i understand/i })
        .filter({ visible: true }),
    /** The popup-open overlay; it animates in (class "in") over the popup
     * and can intercept the click until it settles. */
    signageOverlay: (page: Page): Locator => page.locator(".ui-popup-screen"),
    /** ANY open popup container — the post-submit wait's "a modal showed
     * up" witness, before we know which one it is. */
    anyActivePopup: (page: Page): Locator => page.locator(".ui-popup-container.ui-popup-active"),
    /** "No Meter Parking. Please Check Signage" after-hours notice — the
     * provider's way of saying this zone isn't charging now. Scoped to the
     * open popup by text; its Ok is the visible in-popup button. */
    freePeriodModal: (page: Page): Locator =>
      // "No Meter Parking" is the app's fixed notice title; a string
      // hasText (substring, whitespace-normalized) scopes deterministically.
      page.locator(".ui-popup-container.ui-popup-active", { hasText: "No Meter Parking" }),
    freePeriodOk: (page: Page): Locator =>
      page
        .locator(".ui-popup-container.ui-popup-active", { hasText: "No Meter Parking" })
        .getByRole("button", { name: /^ok(ay)?$/i })
        .filter({ visible: true }),
    /** Recent-zones panel: pops on input focus, sits right after
     * #zoneNext, and (when non-empty) shifts/overlays it — the
     * 2026-09-21 regression. Dismissed before clicking Continue. */
    recentZonesPanel: (page: Page): Locator => page.locator("#recentZones"),
    /** A recent-zone chip for a specific number, if the account has one. */
    recentZoneChip: (page: Page, zoneNumber: string): Locator =>
      page.locator("#recentZonesList button", {
        hasText: new RegExp(`^\\s*${escapeForRegex(zoneNumber)}\\s*$`),
      }),
  },

  // ------------------- Zone info panel (zone-info.js ids; TODO-verify text)
  zoneInfo: {
    /** The zone's name — for Boston zones this is the street/block. */
    zoneName: (page: Page): Locator => page.locator("#zi_zoneName"),
    /** "Zone Number: NNNNN" (label wording from Strings; TODO-verify). */
    zoneNumber: (page: Page): Locator => page.locator("#zi_zoneno"),
    address: (page: Page): Locator => page.locator("#zi_address"),
    selectZoneButton: (page: Page): Locator => page.locator("#zi_selectZone"),
  },

  // ------------- Vehicle selection (#vehicleManagement, VERIFIED live
  // 2026-09-22, fixture passport-start-2026-09-22T15-45-19-408Z: zone
  // submit → signage → Vehicles chooser)
  vehicle: {
    /** The chooser's prompt label ("Please choose the vehicle you would
     * like to park in Zone …"). Present-but-hidden on every other screen
     * (jQM keeps all page divs in the DOM), so visibility ⇒ this screen. */
    chooserMarker: (page: Page): Locator => page.locator("#selectVehicleLabel"),
    /** One button per saved vehicle; its .vehicleDescription span reads
     * "<PLATE> (<STATE>)". Clicking it advances the flow — the screen has
     * no separate Continue (TODO-verify on the first paid recording). */
    vehicleButton: (page: Page, description: string): Locator =>
      page
        .locator("#vehicleManagement button.selectVehicle")
        .filter({ hasText: new RegExp(escapeForRegex(description), "i") })
        .first(),
    /** "Add Vehicle" — NEVER clicked: a missing plate is a typed
     * vehicle_missing result, the driver adds vehicles themselves. */
    addVehicleButton: (page: Page): Locator => page.locator("#addVehicleButton"),
    /** The Zone Information line, e.g. "$3.75 Hr|Max 5 Hr|M-Sat 8am-8pm". */
    zoneInfoLabel: (page: Page): Locator => page.locator("#vehicleManagement .zoneInfoLabel"),
  },

  // ----------------- Duration + confirm (duration-picker.js; TODO-verify)
  // Duration picker (#durationPickerPage, real ids from the 2026-09-21
  // recording): day/hour/minute steppers + #pickerNext to continue.
  duration: {
    hourPlus: (page: Page): Locator => page.locator("#hourPlus"),
    hourText: (page: Page): Locator => page.locator("#hourTimeText"),
    minPlus: (page: Page): Locator => page.locator("#minPlus"),
    minText: (page: Page): Locator => page.locator("#minTimeText"),
    /** The picker page itself, to confirm we're on it. */
    pickerPage: (page: Page): Locator => page.locator("#durationPickerPage"),
    continueButton: (page: Page): Locator => page.locator("#pickerNext"),
  },
  confirm: {
    total: (page: Page): Locator => page.getByText(/total.*\$\s*\d+\.\d{2}/i),
    payButton: (page: Page): Locator =>
      page.getByRole("button", { name: /pay|confirm|start (parking|session)/i }),
    declinedMessage: (page: Page): Locator =>
      page.getByText(/declined|payment (failed|unsuccessful)|could not process/i),
  },
  confirmation: {
    successMarker: (page: Page): Locator =>
      page.getByText(/session (started|confirmed|active)|you're parked|receipt|expires/i),
  },

  // ------------------- Active session screen (session.js; TODO-verify)
  sessions: {
    sessionRow: (page: Page, providerSessionId: string): Locator =>
      page.getByText(new RegExp(escapeForRegex(providerSessionId), "i")).first(),
    extendButton: (page: Page): Locator => page.getByRole("button", { name: /extend|add time/i }),
    stopButton: (page: Page): Locator =>
      page.getByRole("button", { name: /stop|end (session|parking)/i }),
    stopConfirmButton: (page: Page): Locator =>
      page.getByRole("button", { name: /yes|confirm|end/i }),
  },

  // --------------------------------- Profile / signed-in marker (TODO-verify)
  account: {
    signedInMarker: (page: Page): Locator =>
      page.getByText(/profile|sign out|log ?out|parker history/i).first(),
  },

  // ------------------- Card management (login.js UPDATE_CARD ids; TODO-verify)
  // Card form ids verified against the 2026-09-21 start recording's
  // #updateCard page ("Add Payment Details"): the same form both detects
  // a card-less account mid-start AND is where setupCard adds our card.
  payment: {
    addCardButton: (page: Page): Locator =>
      page.getByRole("button", { name: /add (a )?(payment|card)|new card/i }),
    /** The "Add Payment Details" screen itself: the start flow lands here
     * when the account has no saved payment method. */
    addPaymentHeader: (page: Page): Locator => page.locator("#updateCardWindowHeader"),
    addPaymentForm: (page: Page): Locator => page.locator("#updateCard #cardNumber"),
    cardNumberInput: (page: Page): Locator => page.locator("#cardNumber"),
    expiryMonthSelect: (page: Page): Locator => page.locator("#selectMonth"),
    expiryYearSelect: (page: Page): Locator => page.locator("#selectYear"),
    cvcInput: (page: Page): Locator => page.locator("#cvv"),
    zipInput: (page: Page): Locator => page.locator("#billingZipcode"),
    cardNameInput: (page: Page): Locator => page.locator("#cardName"),
    saveButton: (page: Page): Locator => page.locator("#saveCard"),
    successMarker: (page: Page): Locator =>
      page.getByText(/card (added|saved|updated)|payment method (added|updated)/i),
    cardRow: (page: Page, last4: string): Locator =>
      page
        .getByText(new RegExp(`(•+|\\*+|ending\\s*(in)?|x{4})\\s*${escapeForRegex(last4)}`, "i"))
        .first(),
    removeButton: (page: Page): Locator => page.getByRole("button", { name: /remove|delete/i }),
    removeConfirmButton: (page: Page): Locator =>
      page.getByRole("button", { name: /yes|confirm|remove/i }),
    removedMarker: (page: Page): Locator =>
      page.getByText(/card (removed|deleted)|payment method removed/i),
  },
} as const;

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
