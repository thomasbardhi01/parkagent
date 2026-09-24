/**
 * Provider-agnostic garage search. Today's only implementation is the
 * SpotHero DEEP-LINK provider (read-only public search + a prefilled
 * checkout link — we never automate their login or checkout); when
 * SpotHero Partner API access arrives, a PartnerApiProvider implements
 * this same interface and book() becomes a real reservation instead of a
 * hand-off. See docs in API.md "Assistant".
 */

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
  /** Provider-scoped id, stable for the cache lifetime. */
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
