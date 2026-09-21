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
  search(query: GarageSearchQuery): Promise<GarageOption[]>;
  /** Hand off (deep link) or reserve (Partner API) a searched option. */
  book(optionId: string): Promise<GarageBooking>;
}
