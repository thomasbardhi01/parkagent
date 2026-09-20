/**
 * PERSONAL-USE PROTOTYPE — this package drives ParkNYC's own web app with
 * the owner's account, for the owner's own parking only. It is not a
 * shipping integration: automating a consumer app sits outside its intended
 * use and likely its Terms of Service, acceptable only as a personal
 * experiment. Issue #37 tracks moving this package to a private repo; it
 * must move before any customer uses it.
 *
 * EVERY selector the executor uses lives in this file, one entry per UI
 * element, grouped and commented by the screen it belongs to — when ParkNYC
 * changes its UI, this file is the whole fix. Prefer accessible roles and
 * visible text over CSS paths; they survive markup churn.
 *
 * The role names / text patterns below were drafted from memory of the
 * ParkNYC web flow and MUST be verified against a `pnpm -C executor record`
 * run before first real use (see README "Updating selectors").
 */

import type { Locator, Page } from "playwright";

// ParkNYC's web app is Flowbird's SPA at my.nyc.flowbirdapp.com (hash
// routing); parknyc.org / parknycapp.com is only the WordPress marketing
// site, and its /login is a literal 404 page. The sign-in link on the
// marketing homepage points at the ?panel=login route below.
export const URLS = {
  /** The signed-in app; also where the "Park" flow starts. */
  home: "https://my.nyc.flowbirdapp.com/#/Parking",
  /** Sign-in panel (login.ts opens this for the manual session). */
  signIn: "https://my.nyc.flowbirdapp.com/#/Parking?panel=login",
  /**
   * Active/past sessions, for extend and stop. TODO: verify this hash
   * route on the first `record` run — an unknown route lands on the SPA
   * default and the flow reports ui_changed with a capture.
   */
  sessions: "https://my.nyc.flowbirdapp.com/#/Sessions",
} as const;

export const selectors = {
  // -------------------------------------------------------------- Sign-in
  // Present only when we are NOT authenticated; used to detect auth_expired.
  signIn: {
    emailInput: (page: Page): Locator => page.getByRole("textbox", { name: /email/i }),
    passwordInput: (page: Page): Locator => page.getByRole("textbox", { name: /password/i }),
    submitButton: (page: Page): Locator => page.getByRole("button", { name: /sign in|log in/i }),
  },

  // ------------------------------------------------- Home / start parking
  home: {
    /** Entry point into the pay-for-parking flow. */
    parkButton: (page: Page): Locator =>
      page.getByRole("button", { name: /^park$|start parking/i }),
  },

  // -------------------------------------------------------- Zone entry
  zone: {
    zoneNumberInput: (page: Page): Locator => page.getByRole("textbox", { name: /zone/i }),
    continueButton: (page: Page): Locator => page.getByRole("button", { name: /continue|next/i }),
    /** Shown when the zone number is rejected. */
    notFoundMessage: (page: Page): Locator =>
      page.getByText(/zone.*(not.*(found|recognized|valid)|invalid)/i),
  },

  // ---------------------------------------------------- Vehicle selection
  vehicle: {
    /** The saved vehicle whose plate matches. */
    plateOption: (page: Page, plate: string): Locator =>
      page.getByRole("radio", { name: new RegExp(escapeForRegex(plate), "i") }),
    /** First saved vehicle, when no plate was given. */
    firstOption: (page: Page): Locator => page.getByRole("radio").first(),
    continueButton: (page: Page): Locator => page.getByRole("button", { name: /continue|next/i }),
  },

  // ---------------------------------------------------- Duration selection
  duration: {
    /** Steppers that add/remove time in fixed increments. */
    addTimeButton: (page: Page): Locator =>
      page.getByRole("button", { name: /add|\+|increase/i }).first(),
    /** The running readout, e.g. "1 hr 30 min". */
    display: (page: Page): Locator => page.getByText(/\d+\s*(hr|hour|min)/i).first(),
    continueButton: (page: Page): Locator =>
      page.getByRole("button", { name: /continue|next|review/i }),
  },

  // ------------------------------------------------------ Review & confirm
  confirm: {
    /** The shown total, e.g. "Total $7.28". */
    total: (page: Page): Locator => page.getByText(/total.*\$\s*\d+\.\d{2}/i),
    payButton: (page: Page): Locator =>
      page.getByRole("button", { name: /pay|confirm|start session/i }),
    /** Payment-refused banner. */
    declinedMessage: (page: Page): Locator =>
      page.getByText(/declined|payment (failed|unsuccessful)|could not process/i),
  },

  // ---------------------------------------------------- Confirmation screen
  confirmation: {
    /** Anything that marks the session as bought; the anchor we wait for. */
    successMarker: (page: Page): Locator =>
      page.getByText(/session (started|confirmed)|you're parked|receipt|confirmation/i),
  },

  // ------------------------------------------------- Sessions list (manage)
  sessions: {
    /** The row for a known session, matched by its confirmation number. */
    sessionRow: (page: Page, providerSessionId: string): Locator =>
      page.getByText(new RegExp(escapeForRegex(providerSessionId), "i")).first(),
    extendButton: (page: Page): Locator => page.getByRole("button", { name: /extend|add time/i }),
    stopButton: (page: Page): Locator => page.getByRole("button", { name: /stop|end session/i }),
    stopConfirmButton: (page: Page): Locator =>
      page.getByRole("button", { name: /yes|confirm|end/i }),
  },
} as const;

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
