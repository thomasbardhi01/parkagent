/**
 * The receipt bound (D0 Q3, "Before DRY_RUN=false"): what a started session
 * records when the provider hands back its own receipt.
 *
 * A receipt within RECEIPT_BOUND_USD of the price is recorded, so the
 * stored spend and the daily cap match the card (ParkBoston sells in
 * per-zone increments, so a receipt lands a few cents off the estimate).
 * It is never recorded above the amount the driver was shown: past that it
 * is trimmed to the shown amount.
 *
 * Anything else records the price and flags the session for review: a
 * receipt further off than the bound, or one that doesn't add up (not a
 * finite, non-negative amount, or meter + fee not its total). The price is
 * what the gate checked against the caps and what the tap agreed to, so a
 * provider that reads back something else never moves the ledger past
 * either. The receipt itself is kept on the decision for the audit.
 */

/** How far a receipt may sit from the price, either way. */
export const RECEIPT_BOUND_USD = 0.25;

export interface Amounts {
  meterUsd: number;
  feeUsd: number;
  totalUsd: number;
}

export interface Recorded extends Amounts {
  /** The receipt disagreed: the price was recorded instead. */
  mismatch: boolean;
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
  const asPriced = (mismatch: boolean): Recorded => ({
    meterUsd: price.meterUsd,
    feeUsd: price.feeUsd,
    totalUsd: price.totalUsd,
    mismatch,
  });
  if (!receipt) return asPriced(false);
  if (!wellFormed(receipt)) return asPriced(true);
  if (Math.abs(cents(receipt.totalUsd) - cents(price.totalUsd)) > cents(RECEIPT_BOUND_USD)) {
    return asPriced(true);
  }
  const shown = cents(shownTotalUsd ?? price.totalUsd);
  if (cents(receipt.totalUsd) <= shown) {
    const { meterUsd, feeUsd, totalUsd } = receipt;
    return { meterUsd, feeUsd, totalUsd, mismatch: false };
  }
  // Within the bound but above what was shown: the fee stands as charged,
  // and the meter takes the trim.
  const meter = shown - cents(receipt.feeUsd);
  if (meter < 0) return asPriced(true);
  return { meterUsd: meter / 100, feeUsd: receipt.feeUsd, totalUsd: shown / 100, mismatch: false };
}
