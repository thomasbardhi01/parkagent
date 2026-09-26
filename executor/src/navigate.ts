/**
 * PERSONAL-USE PROTOTYPE — see index.ts header.
 *
 * Navigation with one retry. A provider page that doesn't load (a dropped
 * connection, a slow first byte on a cold machine) is worth one more try,
 * but only before the pay click: after it, a retried flow could pay twice,
 * so the caller's `canRetry` says no and the failure surfaces as-is (the
 * server reports it "not confirmed", never "unpaid").
 */

import type { Page } from "playwright";

/** Transport trouble and navigation timeouts: a second try may well work.
 * A page that loaded but looked wrong is not in here; that's ui_changed. */
const TRANSIENT =
  /(net::ERR_|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|Navigation timeout|Timeout \d+m?s exceeded)/i;

export function isTransientNavigationError(err: unknown): boolean {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return TRANSIENT.test(message);
}

export interface NavigateOptions {
  /** Per-step budget for one navigation. */
  timeoutMs: number;
  /** "domcontentloaded" for light reads; flows that were verified live
   * keep Playwright's default "load". */
  waitUntil?: "load" | "domcontentloaded";
  /** False once the pay click happened (and any other time a retry would
   * be unsafe). Checked at the moment of the retry, not up front. */
  canRetry: () => boolean;
  onRetry?: (err: unknown) => void;
  retryDelayMs?: number;
}

export async function gotoWithRetry(
  page: Pick<Page, "goto">,
  url: string,
  options: NavigateOptions,
): Promise<void> {
  const go = () =>
    page.goto(url, {
      timeout: options.timeoutMs,
      ...(options.waitUntil ? { waitUntil: options.waitUntil } : {}),
    });
  try {
    await go();
  } catch (err) {
    if (!isTransientNavigationError(err) || !options.canRetry()) throw err;
    options.onRetry?.(err);
    await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 1_000));
    await go();
  }
}
