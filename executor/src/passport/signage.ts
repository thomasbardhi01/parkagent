/**
 * PERSONAL-USE PROTOTYPE — see the header in ../types.ts and issue #37.
 *
 * The optional "Review Signage" interstitial, extracted from the client so
 * the waiting behavior is testable against fixture DOM (see
 * test/signageFade.dom.test.ts).
 *
 * Why this exists (2026-09-22 regression, fixture
 * passport-start-2026-09-22T15-09-13-438Z): `isVisible({ timeout })` does
 * NOT wait — Playwright ignores the option and answers immediately — so
 * the #92 check raced the popup's injection + fade-in, lost, and the flow
 * clicked into the still-hidden duration page underneath the modal
 * ("Element is not visible" on #pickerNext). The handler below waits for
 * the popup (or the screen that follows when the operator hasn't
 * configured one), then for the popup to be FULLY shown — ui-popup-active,
 * computed opacity 1, no transition/animation still running on it or the
 * .ui-popup-screen overlay — before resolving and clicking the visible
 * Continue with an auto-retrying visibility wait (the library-mode
 * equivalent of expect(locator).toBeVisible()). If the modal survives the
 * click, the click event is dispatched straight on the button (bypasses
 * overlay pointer interception).
 */

import type { Locator, Page } from "playwright";

import { selectors } from "./selectors.js";

export interface SignageHooks {
  /** The client's transition-hardened click (stableClick). */
  click: (locator: Locator, name: string) => Promise<void>;
  log?: ((message: string) => void) | undefined;
  /** How long to wait for the modal OR the screen after it to render. */
  appearTimeoutMs?: number;
  /** How long to allow the fade-in to finish before clicking anyway. */
  settleTimeoutMs?: number;
}

/**
 * Wait until the popup container is fully shown: still ui-popup-active,
 * computed opacity 1, and nothing animating on it (subtree included) or on
 * the .ui-popup-screen overlay. jQuery Mobile fades popups in; a click
 * during the fade lands on the animating overlay. Resolves false (never
 * throws) if the popup keeps animating past the timeout — the caller then
 * clicks anyway and relies on the dispatchEvent fallback.
 */
export async function waitForPopupSettled(
  page: Page,
  popup: Locator,
  timeoutMs: number,
): Promise<boolean> {
  const handle = await popup
    .first()
    .elementHandle({ timeout: timeoutMs })
    .catch(() => null);
  if (!handle) return false;
  // NO named inner functions in this closure: it is serialized into the
  // page, and tsx/esbuild's keepNames would inject a __name helper that
  // doesn't exist there (ReferenceError on every poll → instant false).
  const settled = await page
    .waitForFunction(
      (el: {
        classList: { contains(t: string): boolean };
        getAnimations?: (opts: { subtree: boolean }) => ArrayLike<{ playState: string }>;
        ownerDocument: {
          defaultView: { getComputedStyle(n: unknown): { opacity: string } };
          querySelector(s: string): unknown;
        };
      }) => {
        if (!el.classList.contains("ui-popup-active")) return false;
        if (el.ownerDocument.defaultView.getComputedStyle(el).opacity !== "1") return false;
        if (
          typeof el.getAnimations === "function" &&
          Array.from(el.getAnimations({ subtree: true })).some((a) => a.playState === "running")
        ) {
          return false;
        }
        // The overlay keeps class "in" while open (verified live
        // 2026-09-22), so only a RUNNING animation on it blocks.
        const screen = el.ownerDocument.querySelector(".ui-popup-screen") as typeof el | null;
        if (
          screen &&
          typeof screen.getAnimations === "function" &&
          Array.from(screen.getAnimations({ subtree: true })).some((a) => a.playState === "running")
        ) {
          return false;
        }
        return true;
      },
      handle,
      { timeout: timeoutMs },
    )
    .then(() => true)
    .catch(() => false);
  await handle.dispose();
  return settled;
}

/**
 * Detect and dismiss the operator-configured "Review Signage" interstitial
 * after zone submit. Never fails when the modal is absent: it waits for
 * whichever renders first — the modal, the zone-info panel, or the
 * duration picker — and returns false if the modal isn't the one that
 * showed up. Returns true once the modal was dismissed (hidden).
 */
export async function handleSignageModal(page: Page, hooks: SignageHooks): Promise<boolean> {
  const appearTimeoutMs = hooks.appearTimeoutMs ?? 5_000;
  const settleTimeoutMs = hooks.settleTimeoutMs ?? 5_000;
  const modal = selectors.zone.signageModal(page);

  await modal
    .or(selectors.zoneInfo.selectZoneButton(page))
    .or(selectors.vehicle.chooserMarker(page))
    .or(selectors.duration.pickerPage(page))
    .first()
    .waitFor({ state: "visible", timeout: appearTimeoutMs })
    .catch(() => {});
  if (!(await modal.isVisible().catch(() => false))) return false;

  const settled = await waitForPopupSettled(page, modal, settleTimeoutMs);
  if (!settled) {
    hooks.log?.("signage: popup never fully settled; proceeding to click");
  }

  const continueButton = selectors.zone.signageContinue(page);
  // Auto-retrying visibility wait on the popup-scoped locator, not a
  // one-shot resolution of the visible filter.
  await continueButton.waitFor({ state: "visible", timeout: settleTimeoutMs }).catch(() => {});
  try {
    await hooks.click(continueButton, "signage-continue");
  } catch (err) {
    // "Element is not visible" / interception — fall through to the
    // dispatchEvent path below instead of failing the whole flow.
    hooks.log?.(`signage: click failed (${String(err).split("\n")[0]}); trying dispatchEvent`);
  }

  const closed = await modal
    .waitFor({ state: "hidden", timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  if (!closed) {
    // Clicked mid-overlay or the duplicate button ate it — dispatch the
    // event straight on the Continue, past pointer interception.
    hooks.log?.("signage: still open after click; dispatching click event");
    await continueButton.dispatchEvent("click").catch(() => {});
    await modal.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
  }
  return true;
}
