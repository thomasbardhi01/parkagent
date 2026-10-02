/**
 * How place names are compared: the word tokens of a query and of a
 * result's name, and when one stands for the other. Shared by the scorer
 * (placeScore.ts) and the classifier (placeMatch.ts), which re-exports
 * `nameTokens` and `tokenMatches`.
 */

/** Words that only join a phrase together. */
const FILLER_WORDS = new Set(["a", "an", "the", "at", "in", "on", "near", "by", "of", "and"]);

/** Words that describe a kind of place, not its name. */
const GENERIC_WORDS = new Set([
  ...FILLER_WORDS,
  "restaurant",
  "steakhouse",
  "steak",
  "bar",
  "grill",
  "cafe",
  "coffee",
  "pub",
  "bistro",
  "diner",
  "tavern",
  "kitchen",
  "hotel",
  "place",
  "spot",
  "venue",
  "club",
]);

export function isGenericWord(token: string): boolean {
  return GENERIC_WORDS.has(token);
}

/** "the", "of", "near": said, but no part of what a place is called. */
export function isFillerWord(token: string): boolean {
  return FILLER_WORDS.has(token);
}

/** Street-name abbreviations people say or type, spelled out — "Newbury
 * St" is "Newbury Street". */
const ABBREVIATIONS: Record<string, string> = {
  st: "street",
  ave: "avenue",
  av: "avenue",
  blvd: "boulevard",
  rd: "road",
  sq: "square",
  pl: "place",
  ln: "lane",
  dr: "drive",
  ct: "court",
  pkwy: "parkway",
  hwy: "highway",
  wy: "way",
};

/** "Mooo" is "Moo": a letter held down is one letter. */
const collapseStretched = (token: string) => token.replace(/([a-z])\1+/g, "$1");

/** Lowercased, accent- and punctuation-free word tokens, abbreviations
 * spelled out, stretched letters collapsed ("Mooo...." → ["mo"], "LoLa 42"
 * → ["lola", "42"], "Newbury St" and "Newbury Street" alike). */
export function nameTokens(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 0)
    .map((t) => ABBREVIATIONS[t] ?? t)
    .map(collapseStretched);
}

export function tokenMatches(queryToken: string, nameToken: string): boolean {
  if (queryToken === nameToken) return true;
  // A partial word counts only past two letters ("lol" ≠ "lola 42").
  return (
    Math.min(queryToken.length, nameToken.length) >= 3 &&
    (nameToken.startsWith(queryToken) || queryToken.startsWith(nameToken))
  );
}

/** Words a set of initials skips: "MFA" is the Museum of Fine Arts. */
const CONNECTORS = new Set(["of", "the", "and", "at", "for", "in", "on", "a"]);

/**
 * Whether a query word is the initials of a whole name: "MFA" for "Museum
 * of Fine Arts", "MIT" for "Massachusetts Institute of Technology". The
 * name needs two words or more, and every one of them is spoken for —
 * with its connecting words or without ("MoMA"). Compared the way tokens
 * are made, so a doubled letter is one.
 */
function isInitialsOf(queryToken: string, name: readonly string[]): boolean {
  if (queryToken.length < 2 || !/^[a-z]+$/.test(queryToken)) return false;
  const initials = (words: readonly string[]) =>
    words.length >= 2 ? collapseStretched(words.map((w) => w[0]).join("")) : null;
  return (
    initials(name) === queryToken || initials(name.filter((w) => !CONNECTORS.has(w))) === queryToken
  );
}

/** Whether a result's name (as tokens) carries one word of the query. */
export function nameCarries(name: readonly string[], queryToken: string): boolean {
  return name.some((n) => tokenMatches(queryToken, n)) || isInitialsOf(queryToken, name);
}
