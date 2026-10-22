/**
 * What a reply's text is held to, a leaf module: the time line every user
 * message carries, and the scrubs that drop a verbal-confirm invitation or
 * a dollar amount the server doesn't stand behind. tools.ts and loop.ts
 * both read these; nothing here imports back.
 */

/** Phrasing that invites a verbal confirm — scrubbed if it ever appears. */
const VERBAL_CONFIRM_PATTERN =
  /[^.!?]*(?:say|type|reply|tell me|text me|answer)[^.!?]{0,40}(?:['"“”]?confirm['"“”]?|yes)[^.!?]*[.!?]?/gi;

/** Eastern time, both cities: the bracket every user message carries so
 * the model never has to guess what "tonight" means. */
export function currentTimeLine(at: Date): string {
  const eastern = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(at);
  const get = (type: string) => eastern.find((p) => p.type === type)?.value ?? "";
  return `[current time: ${get("weekday")} ${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ET]`;
}

/**
 * Join per-iteration text segments, dropping repeats: models restate
 * their opener after tool results ("Let me check… Let me check… it's
 * $4.10"), and the user reads it twice. A later segment that repeats an
 * earlier one (whole or as its prefix) loses the repeated part.
 */
export function joinReplySegments(segments: string[]): string {
  const kept: string[] = [];
  for (const raw of segments) {
    let segment = raw.trim();
    if (segment.length === 0) continue;
    for (const prior of kept) {
      if (segment === prior) {
        segment = "";
        break;
      }
      if (segment.startsWith(prior)) {
        segment = segment.slice(prior.length).trimStart();
      }
    }
    if (segment.length > 0) kept.push(segment);
  }
  return kept.join(" ").trim();
}

/** Strip any sentence that invites a verbal confirm; the card is the
 * only way to authorize, and the reply must say so instead. */
export function scrubVerbalConfirm(reply: string, hasPlan: boolean): string {
  if (!VERBAL_CONFIRM_PATTERN.test(reply)) return reply;
  VERBAL_CONFIRM_PATTERN.lastIndex = 0;
  const scrubbed = reply
    .replace(VERBAL_CONFIRM_PATTERN, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  const pointer = hasPlan ? "Tap Confirm on a card to go ahead." : "";
  return [scrubbed, pointer]
    .filter((s) => s.length > 0)
    .join(" ")
    .trim();
}

/** A dollar amount in prose: "$4.50", "$20", "$1,000.00". */
export const AMOUNT_PATTERN = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g;

/** A reply cut into sentences, each keeping its own spacing. A sentence
 * ends at . ! or ? followed by whitespace (so "$4.50" is not two), or at
 * a line break. */
export function sentencesOf(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    const next = text[i + 1];
    const ends =
      ch === "\n" ||
      ((ch === "." || ch === "!" || ch === "?") && (next === undefined || /\s/.test(next)));
    if (ends) {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/**
 * V6 (FR-43): drop every sentence that states a dollar amount the server
 * doesn't stand behind. `groundedCents` holds the amounts it does, in
 * cents — "$20" and "$20.00" are the same amount. Returns the reply and
 * the amounts dropped (dollars, in order, each once). A reply with nothing
 * to drop comes back untouched.
 */
export function scrubUngroundedAmounts(
  reply: string,
  groundedCents: ReadonlySet<number>,
): { text: string; dropped: number[] } {
  const dropped: number[] = [];
  const kept = sentencesOf(reply).filter((sentence) => {
    const ungrounded = [...sentence.matchAll(AMOUNT_PATTERN)]
      .map((m) =>
        Math.round(Number(`${m[1]!.replace(/,/g, "")}.${(m[2] ?? "").padEnd(2, "0")}`) * 100),
      )
      .filter((cents) => !groundedCents.has(cents));
    for (const cents of ungrounded) {
      if (!dropped.includes(cents / 100)) dropped.push(cents / 100);
    }
    return ungrounded.length === 0;
  });
  if (dropped.length === 0) return { text: reply, dropped };
  return {
    text: kept
      .join("")
      .replace(/\s{2,}/g, " ")
      .trim(),
    dropped,
  };
}
