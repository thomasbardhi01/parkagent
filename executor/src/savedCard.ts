/**
 * Parsing for the provider's "Your Cards" rows — provider_card users keep
 * their own card on the account, and the app shows which one pays by brand
 * + last4 read off that screen at link time. Display data only: the row
 * text never contains a full PAN, and we never ask for one.
 *
 * Row shapes seen/expected:
 *  - Passport (#creditCards, VERIFIED live 2026-09-23): "<Name> (<last4>)"
 *    where <Name> is the user's nickname for the card — often the brand
 *    ("Visa (4242)"), sometimes not ("Main card (4242)").
 *  - ParkNYC (drafted, TODO-verify): masked forms like "Visa •••• 4242"
 *    or "ending in 4242".
 */

export interface SavedCardLabel {
  /** Canonical brand name when the row names one; null otherwise. */
  brand: string | null;
  last4: string | null;
}

const BRANDS: [RegExp, string][] = [
  [/\bvisa\b/i, "Visa"],
  [/\bmaster\s*card\b/i, "Mastercard"],
  [/\bamex\b|\bamerican\s*express\b/i, "American Express"],
  [/\bdiscover\b/i, "Discover"],
];

export function parseSavedCardLabel(text: string): SavedCardLabel {
  const brand = BRANDS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
  // Prefer an explicitly masked/parenthesized group; fall back to the last
  // standalone 4-digit run (avoids matching a year in "expires 2030" by
  // requiring exactly four digits with boundaries).
  const masked =
    /(?:\(|•+\s*|\*+\s*|ending\s*(?:in\s*)?)(\d{4})\)?/i.exec(text)?.[1] ??
    [...text.matchAll(/(?<!\d)(\d{4})(?!\d)/g)].at(-1)?.[1] ??
    null;
  return { brand, last4: masked };
}
