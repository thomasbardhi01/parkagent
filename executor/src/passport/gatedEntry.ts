/**
 * Signed out, or on the screen we came for? ParkBoston's single-page app
 * draws its gated entry (Sign In / Guest) ~0.4 s after DOM-ready (probed
 * live 2026-09-26), so an instant visibility check — `isVisible({ timeout })`
 * never waits — read a signed-out session as signed in, and the flow ran
 * on to a ui_changed timeout 20 s later: the health job never saw a
 * ParkBoston session expire, and a link with stale cookies retried for
 * minutes instead of asking the user to sign in again.
 *
 * So: wait ONCE for whichever shows first — the gated entry or
 * `signedIn`, the screen's own witness — then answer. Hidden copies don't
 * count (jQuery Mobile keeps other pages' markup in the DOM). Neither
 * showing within the cap answers "not gated" and the caller's own wait
 * says what it didn't find.
 */

import type { Locator, Page } from "playwright";

import { selectors } from "./selectors.js";

export const GATED_ENTRY_WAIT_MS = 10_000;

export async function atGatedEntry(
  page: Page,
  signedIn: Locator,
  timeoutMs: number = GATED_ENTRY_WAIT_MS,
): Promise<boolean> {
  const gated = selectors.gatedEntry.marker(page).filter({ visible: true });
  await gated
    .or(signedIn.filter({ visible: true }))
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs })
    .catch(() => {});
  return (await gated.count().catch(() => 0)) > 0;
}
