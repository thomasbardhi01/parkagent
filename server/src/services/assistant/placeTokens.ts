/**
 * How place names are compared: the word tokens of a query and of a
 * result's name, and when one stands for the other. Shared by the scorer
 * (placeScore.ts) and the classifier (placeMatch.ts), which re-exports
 * `nameTokens`.
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

/**
 * How a result's name carries one word of the query, or null when it
 * doesn't:
 *
 *  - "exact": the name has the word;
 *  - "joined": the word is two or more of the name's words run together
 *    ("lola42" is "LoLa 42", "joes" is "Joe's", "seafoods" is "Sea Foods");
 *  - "initials": the word is the name's initials ("MFA");
 *  - "fragment": the word is only the start of a longer name word ("Pru"
 *    of "Prudential", "Mass" of "Massachusetts") — three letters at least.
 *
 * A name word that is only the start of the QUERY word is no match:
 * "xyzzy" is not "W XYZ Bar", however much of it "XYZ" spells.
 */
export type NameMatch = "exact" | "joined" | "initials" | "fragment";

export function nameMatch(name: readonly string[], queryToken: string): NameMatch | null {
  if (name.includes(queryToken)) return "exact";
  if (joinsWords(name, queryToken)) return "joined";
  if (isInitialsOf(queryToken, name)) return "initials";
  if (
    queryToken.length >= 3 &&
    name.some((n) => n.length > queryToken.length && n.startsWith(queryToken))
  ) {
    return "fragment";
  }
  return null;
}

/** Whether a word is two or more consecutive name words run together. */
function joinsWords(name: readonly string[], queryToken: string): boolean {
  for (let start = 0; start < name.length - 1; start += 1) {
    let joined = name[start]!;
    for (let end = start + 1; end < name.length && joined.length < queryToken.length; end += 1) {
      joined += name[end]!;
      if (joined === queryToken) return true;
    }
  }
  return false;
}

/**
 * Whether a name carries the whole of a query's name: every word, and at
 * least one of them as more than a fragment. "Pru" alone is not
 * "Prudential Center" — a word's first letters are too little to stand
 * on — while "Mass Ave" is "Massachusetts Avenue" ("Ave" is whole).
 */
export function carriesAll(name: readonly string[], queryTokens: readonly string[]): boolean {
  if (queryTokens.length === 0) return false;
  const matches = queryTokens.map((t) => nameMatch(name, t));
  return matches.every((m) => m !== null) && matches.some((m) => m !== "fragment");
}
