/**
 * Provider-agnostic garage search. Today's only implementation is the
 * SpotHero DEEP-LINK provider (read-only public search + a prefilled
 * checkout link — we never automate their login or checkout); when
 * SpotHero Partner API access arrives, a PartnerApiProvider implements
 * this same interface and book() becomes a real reservation instead of a
 * hand-off. See docs in API.md "Assistant".
 */

import { createHash } from "node:crypto";

export interface GarageSearchQuery {
  lat: number;
  lng: number;
  /** ISO datetimes bounding the parking window. */
  startsAt: string;
  endsAt: string;
  /** Ceiling in USD; results above it are filtered out. */
  budgetUsd?: number;
}

export interface GarageOption {
  /** Unique per (provider, facility, window) — see garageOptionId. */
  id: string;
  provider: string;
  name: string;
  address: string;
  /** Facility coordinates when the provider reports them — plan-card map
   * pins and the recomputed distance guard both read these. */
  lat?: number;
  lng?: number;
  priceUsd: number;
  distanceM: number;
  walkMinutes: number;
  /** e.g. "self" | "valet" | "unknown" — what the lot's entry looks like. */
  entryType: string;
  /** Checkout URL with location and times prefilled. For the deep-link
   * provider this is where the user completes the purchase themselves. */
  deepLink: string;
}

export interface GarageBooking {
  /** "deeplink_handoff": the user completes checkout at the provider and
   * the pass lives in the provider's app; "reserved" once a Partner API
   * provider can hold the spot itself. */
  kind: "deeplink_handoff" | "reserved";
  option: GarageOption;
  /** For handoff: the link to open. For reserved: confirmation id. */
  deepLink?: string;
  confirmationId?: string;
  // ---------------------------------------------------------------------
  // Shared Payment Token seam (Stripe agentic commerce): when a garage
  // provider accepts SPTs, a "reserved" booking would carry the SPT
  // checkout here — create the token against the provider's network_id
  // (spend-request credential_type "shared_payment_token") and complete
  // the purchase server-side. No parking provider accepts SPTs today
  // (2026-09), so this stays a documented seam, not code.
  // ---------------------------------------------------------------------
}

export interface GarageProvider {
  readonly id: string;
  /** True when book() can reserve without the user finishing checkout. */
  readonly canReserve: boolean;
  /** Typed outcome: "the search broke" (blocked | parse_failed |
   * network) is a different fact from "no garages" ({ok, options: []})
   * and the assistant must never conflate them. A multi-provider search
   * where SOME providers failed reports them in `degraded` — partial
   * results with an honest asterisk, never silently narrower coverage. */
  search(query: GarageSearchQuery): Promise<
    | {
        ok: true;
        options: GarageOption[];
        fromCache: boolean;
        degraded?: { provider: string; error: string }[];
      }
    | { ok: false; error: "blocked" | "parse_failed" | "network"; detail: string }
  >;
  /** A recently searched option by id (cache lookup, no side effects);
   * null once the cache has expired. */
  optionById(optionId: string): GarageOption | null;
  /** Hand off (deep link) or reserve (Partner API) a searched option. */
  book(optionId: string): Promise<GarageBooking>;
}

/**
 * The id a garage option carries: provider, facility, and a short tag of
 * the search window. The same facility searched for two windows ("make
 * it 5 instead") is two different offers — different price, different
 * checkout link — and a facility-only id let the cache hand back the
 * FIRST window's link for the second window's card. Providers also share
 * a numeric id space (SpotHero facility 4521 ≠ ParkWhiz location 4521).
 */
export function garageOptionId(
  provider: string,
  facilityId: string,
  window: { startsAt: string; endsAt: string },
): string {
  const tag = createHash("sha256")
    .update(`${window.startsAt}|${window.endsAt}`)
    .digest("hex")
    .slice(0, 6);
  return `${provider}-${facilityId}-${tag}`;
}

/** The newest cached option with this id, across a provider's cache
 * entries (a re-search refreshes price, so newest wins). */
export function newestCachedOption(
  cache: Map<string, { at: number; options: GarageOption[] }>,
  optionId: string,
): GarageOption | null {
  let best: { at: number; option: GarageOption } | null = null;
  for (const entry of cache.values()) {
    const option = entry.options.find((o) => o.id === optionId);
    if (option && (!best || entry.at > best.at)) best = { at: entry.at, option };
  }
  return best?.option ?? null;
}

/** User-facing names and home pages for the garage sources — the handoff
 * note, the Link merchant, and the card's button all name the provider
 * the option actually came from. */
const GARAGE_PROVIDERS: Record<string, { name: string; url: string; host: RegExp }> = {
  spothero: { name: "SpotHero", url: "https://spothero.com", host: /(^|\.)spothero\.com$/ },
  parkwhiz: { name: "ParkWhiz", url: "https://www.parkwhiz.com", host: /(^|\.)parkwhiz\.com$/ },
};

/** A garage source by its id, else by the host of its checkout link;
 * null when neither names one we know. */
export function garageProviderInfo(
  provider: string | undefined,
  deepLink?: string,
): { id: string; name: string; url: string } | null {
  if (provider && GARAGE_PROVIDERS[provider]) {
    return { id: provider, ...GARAGE_PROVIDERS[provider] };
  }
  if (deepLink) {
    let host: string;
    try {
      host = new URL(deepLink).hostname;
    } catch {
      return null;
    }
    for (const [id, info] of Object.entries(GARAGE_PROVIDERS)) {
      if (info.host.test(host)) return { id, ...info };
    }
  }
  return null;
}

/** The handoff sentence for a garage option: where checkout finishes and
 * where the pass will live. */
export function garageHandoffNote(provider: string | undefined, deepLink?: string): string {
  const info = garageProviderInfo(provider, deepLink);
  return info
    ? `Checkout finishes in ${info.name}; the parking pass will live in your ${info.name} account.`
    : "Checkout finishes on the garage's own site; the parking pass will live there.";
}
