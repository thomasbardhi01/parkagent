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
 *  - FROM SHIPPED SOURCE, NOT YET WALKED (TODO-verify on the first paid
 *    `record` run): everything after zone submit — the zone info panel
 *    (#zi_*), vehicle, duration, confirm, session, and card screens.
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
    /** Gated entry: Sign In / Register / Continue as Guest. This is the
     * screen the app's link web view starts on (VERIFIED live). */
    home: root,
    signIn: root,
    /** Passwordless login (e-mail/phone + code + PIN). */
    login: `${root}#login`,
    /** Type-a-zone-number entry — where every ParkBoston session starts
     * (the app has no map; #findParking lands here). */
    zoneEntry: `${root}#zoneEntry`,
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

  // ---------------------------------------------------- Vehicle selection
  vehicle: {
    plateOption: (page: Page, plate: string): Locator =>
      page.getByText(new RegExp(escapeForRegex(plate), "i")).first(),
    firstOption: (page: Page): Locator => page.getByRole("radio").first(),
    continueButton: (page: Page): Locator => page.getByRole("button", { name: /continue|next/i }),
  },

  // ----------------- Duration + confirm (duration-picker.js; TODO-verify)
  duration: {
    addTimeButton: (page: Page): Locator =>
      page.getByRole("button", { name: /add|\+|increase/i }).first(),
    display: (page: Page): Locator => page.getByText(/\d+\s*(hr|hour|min)/i).first(),
    continueButton: (page: Page): Locator =>
      page.getByRole("button", { name: /continue|next|review|park/i }),
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
  payment: {
    addCardButton: (page: Page): Locator =>
      page.getByRole("button", { name: /add (a )?(payment|card)|new card/i }),
    cardNumberInput: (page: Page): Locator => page.getByRole("textbox", { name: /card number/i }),
    expiryInput: (page: Page): Locator =>
      page.getByRole("textbox", { name: /expir|mm\s*\/\s*yy/i }),
    cvcInput: (page: Page): Locator =>
      page.getByRole("textbox", { name: /cvc|cvv|security code/i }),
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
