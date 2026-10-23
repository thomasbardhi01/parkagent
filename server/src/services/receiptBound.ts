/**
 * The receipt bound (D0 Q3, "Before DRY_RUN=false"): what a started session
 * records when the provider hands back its own receipt, and what the caps
 * count on top of it.
 *
 * A receipt within RECEIPT_BOUND_USD of the price, at or below the amount
 * the driver was shown, is recorded, so the stored spend and the daily cap
 * match the card (ParkBoston sells in per-zone increments, so a receipt
 * lands a few cents off the estimate).
 *
 * The session never records more than was shown. A receipt above it within
 * the bound is trimmed to the shown amount; one further off than the bound,
 * either way, records the price. Both flag the session for review, and the
 * part of the receipt above what was recorded is kept as `excessUsd`, which
 * the caps count on top of the session's amounts (moneyGate.ts spentToday
 * and sessionSpentUsd). So a provider that charged more than the ledger
 * shows makes the caps refuse sooner, never later.
 *
 * A receipt that doesn't add up (not a finite amount >= 0, or meter + fee
 * not its total) records the price and is flagged; when its total is still
 * a real amount (the card's charge), what it says beyond the price counts
 * on top, as above. The receipt itself rides on the decision's inputs.
 */

/** How far a receipt may sit from the price, either way. */
export const RECEIPT_BOUND_USD = 0.25;

/** The most `sessions.receipt_excess_usd` (DECIMAL(10,2)) holds: a larger
 * receipt is counted as this much, which every cap refuses past. */
export const RECEIPT_EXCESS_MAX_USD = 99_999_999.99;

export interface Amounts {
  meterUsd: number;
  feeUsd: number;
  totalUsd: number;
}

export interface Recorded extends Amounts {
  /** The receipt was set aside or trimmed: a person should look, the
   * decision says receipt_mismatch, and auto-extends stop. */
  needsReview: boolean;
  /** What the receipt says was charged beyond what is recorded, for the
   * caps to count; null when nothing is. */
  excessUsd: number | null;
}

const cents = (usd: number) => Math.round(usd * 100);

function wellFormed(receipt: Amounts): boolean {
  const parts = [receipt.meterUsd, receipt.feeUsd, receipt.totalUsd];
  if (!parts.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)) return false;
  return cents(receipt.meterUsd) + cents(receipt.feeUsd) === cents(receipt.totalUsd);
}

/**
 * What to record for a paid start. `shownTotalUsd` is the amount the tap
 * agreed to, when the caller had one; without it the price is what the
 * driver saw.
 */
export function boundReceipt(
  price: Amounts,
  receipt: Amounts | undefined,
  shownTotalUsd: number | undefined,
): Recorded {
  const recorded = (
    amounts: Amounts,
    needsReview: boolean,
    excessCents: number | null = null,
  ): Recorded => ({
    meterUsd: amounts.meterUsd,
    feeUsd: amounts.feeUsd,
    totalUsd: amounts.totalUsd,
    needsReview,
    excessUsd:
      excessCents !== null && excessCents > 0
        ? Math.min(excessCents / 100, RECEIPT_EXCESS_MAX_USD)
        : null,
  });
  if (!receipt) return recorded(price, false);
  if (!wellFormed(receipt)) {
    // The total is what the card was charged (the provider's own parser
    // reads a missing fee line as 0, so meter + fee can fall short of it):
    // a total that is a real amount still counts what it says beyond the
    // price.
    const total = receipt.totalUsd;
    const readable = typeof total === "number" && Number.isFinite(total) && total >= 0;
    return recorded(price, true, readable ? cents(total) - cents(price.totalUsd) : null);
  }
  const charged = cents(receipt.totalUsd);
  if (Math.abs(charged - cents(price.totalUsd)) > cents(RECEIPT_BOUND_USD)) {
    return recorded(price, true, charged - cents(price.totalUsd));
  }
  const shown = cents(shownTotalUsd ?? price.totalUsd);
  if (charged <= shown) return recorded(receipt, false);
  // Within the bound but above what was shown: the fee stands as charged,
  // the meter takes the trim, and the rest is counted on top.
  const meter = shown - cents(receipt.feeUsd);
  if (meter < 0) return recorded(price, true, charged - cents(price.totalUsd));
  return recorded(
    { meterUsd: meter / 100, feeUsd: receipt.feeUsd, totalUsd: shown / 100 },
    true,
    charged - shown,
  );
}
