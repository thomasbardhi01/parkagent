/**
 * Fan a garage search across every configured provider and merge the
 * results, deduping by facility ADDRESS (the same physical garage is
 * usually listed on both SpotHero and ParkWhiz; the user should see one
 * row — the cheaper one). Outcome semantics stay honest: options come
 * back ok as long as ANY provider answered, with the failed providers
 * named in `degraded`; only every-provider-failed is a search failure.
 */

import type {
  GarageBooking,
  GarageOption,
  GarageProvider,
  GarageSearchQuery,
} from "./garageProvider.js";

/**
 * Canonical form of a US street address for cross-provider matching:
 * lowercase, punctuation stripped, common suffixes/directions collapsed
 * ("503 Congress Street" ≡ "503 congress st"). City names (after a
 * comma) are dropped — providers disagree on including them.
 */
export function normalizeAddress(address: string): string {
  const ABBREV: Record<string, string> = {
    street: "st",
    avenue: "ave",
    av: "ave",
    boulevard: "blvd",
    drive: "dr",
    place: "pl",
    road: "rd",
    lane: "ln",
    court: "ct",
    square: "sq",
    north: "n",
    south: "s",
    east: "e",
    west: "w",
  };
  return (address.split(",")[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => ABBREV[w] ?? w)
    .join(" ");
}

const MAX_MERGED_RESULTS = 8;

export function makeMultiGarageProvider(providers: GarageProvider[]): GarageProvider {
  if (providers.length === 0)
    throw new Error("makeMultiGarageProvider needs at least one provider");
  if (providers.length === 1) return providers[0]!;

  async function search(query: GarageSearchQuery) {
    const outcomes = await Promise.all(
      providers.map(async (p) => ({ provider: p, outcome: await p.search(query) })),
    );
    const succeeded = outcomes.filter((o) => o.outcome.ok);
    if (succeeded.length === 0) {
      // Every source broke — surface the first failure as-is.
      const first = outcomes[0]!.outcome;
      return first.ok ? first : first;
    }
    const degraded = outcomes
      .filter((o) => !o.outcome.ok)
      .map((o) => ({
        provider: o.provider.id,
        error: o.outcome.ok ? "" : o.outcome.error,
      }));

    // Merge, then dedupe by normalized address keeping the CHEAPER of a
    // pair (an option with no usable address never collides).
    const byAddress = new Map<string, GarageOption>();
    const unaddressed: GarageOption[] = [];
    for (const { outcome } of succeeded) {
      if (!outcome.ok) continue;
      for (const option of outcome.options) {
        const key = normalizeAddress(option.address);
        if (key.length === 0) {
          unaddressed.push(option);
          continue;
        }
        const existing = byAddress.get(key);
        if (!existing || option.priceUsd < existing.priceUsd) {
          byAddress.set(key, option);
        }
      }
    }
    // Nearest first, and no more than one provider alone would return:
    // the model reads every row, and 16 rows cost twice what 8 do.
    const merged = [...byAddress.values(), ...unaddressed]
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, MAX_MERGED_RESULTS);
    return {
      ok: true as const,
      options: merged,
      fromCache: succeeded.every((o) => o.outcome.ok && o.outcome.fromCache),
      ...(degraded.length > 0 ? { degraded } : {}),
    };
  }

  function optionById(optionId: string): GarageOption | null {
    for (const p of providers) {
      const option = p.optionById(optionId);
      if (option) return option;
    }
    return null;
  }

  return {
    id: providers.map((p) => p.id).join("+"),
    // Reservable only when every source is — a mixed plan can't promise it.
    canReserve: providers.every((p) => p.canReserve),
    search,
    optionById,
    async book(optionId: string): Promise<GarageBooking> {
      for (const p of providers) {
        if (p.optionById(optionId)) return p.book(optionId);
      }
      throw new Error(
        `unknown garage option ${optionId} (search first — options expire with the cache)`,
      );
    },
  };
}
