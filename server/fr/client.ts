/**
 * Harness for the live functional-requirements suite
 * (docs/functional-requirements.md). Every test in fr/ talks to a REAL
 * deployed API (prod by default) as a DEDICATED test user, in dry run.
 *
 * Guard rails, in order of importance:
 *  - `gate()` refuses to run anything until GET /policy reports effective
 *    dryRun true. The suite never runs against a server that can move money.
 *  - FR_API_KEY must belong to the dedicated FR user (create it with
 *    `pnpm -C server create:fr-user`), never a person's key: the suite
 *    writes parked_events/decisions rows and registers device tokens under
 *    whoever the key identifies.
 *  - Assistant turns are paid model calls; `assistantMessage()` counts them
 *    and fails the run past FR_ASSISTANT_MAX_CALLS (default 8) so a retry
 *    loop can never run up a bill.
 *  - The suite never calls PUT /policy, /session/extend|stop, any /card
 *    route, or a real provider link — nothing here can change the spending
 *    contract or touch a provider account.
 */

export const BASE = (process.env["FR_API_BASE"] ?? "https://parkagent-api.fly.dev").replace(
  /\/$/,
  "",
);

const KEY = process.env["FR_API_KEY"];

const ASSISTANT_MAX_CALLS = Number(process.env["FR_ASSISTANT_MAX_CALLS"] ?? "8");
let assistantCalls = 0;

export interface FrResponse {
  status: number;
  body: Record<string, unknown>;
}

/** fetch failures from before a connection existed: nothing reached the
 * server, so one retry can't double-apply even a POST. A reset
 * mid-request is deliberately absent — that request may have landed. */
const CONNECT_PHASE_CODES = new Set(["UND_ERR_CONNECT_TIMEOUT", "ECONNREFUSED", "EAI_AGAIN"]);

function fetchCause(err: unknown): { code: string | undefined; message: string } {
  const cause = (err as { cause?: { code?: unknown; message?: unknown } }).cause;
  return {
    code: typeof cause?.code === "string" ? cause.code : undefined,
    message: typeof cause?.message === "string" ? cause.message : String(err),
  };
}

export async function frFetch(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  payload?: unknown,
): Promise<FrResponse> {
  if (!KEY) {
    throw new Error(
      "FR_API_KEY is not set. Create the dedicated FR user with " +
        "`pnpm -C server create:fr-user` and export its key — never a personal key.",
    );
  }
  // The abuse limits are per user (e.g. /parked 30/min); a second run
  // minutes after the first can trip them. Waiting out one Retry-After is
  // signal-preserving — the retry answers the real question.
  for (let attempt = 0; ; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          "x-api-key": KEY,
          ...(payload !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      });
    } catch (err) {
      // Nightly 36015007755 went red on one connect timeout to the Fly
      // edge; a connect-phase blip gets one retry. Anything else, or a
      // second failure, fails the test naming the request and the cause
      // (bare "fetch failed" hid both from the report).
      const cause = fetchCause(err);
      if (attempt === 0 && cause.code && CONNECT_PHASE_CODES.has(cause.code)) {
        console.warn(`FR: ${method} ${path} failed to connect (${cause.code}); retrying once`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
      throw new Error(
        `${method} ${path}: fetch failed (${cause.code ?? "no code"}: ${cause.message})`,
        { cause: err },
      );
    }
    if (res.status === 429 && attempt === 0) {
      const retryAfter = Math.min(Number(res.headers.get("retry-after") ?? "30") || 30, 90);
      await new Promise((resolve) => setTimeout(resolve, (retryAfter + 1) * 1000));
      continue;
    }
    const text = await res.text();
    let body: Record<string, unknown>;
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = { raw: text };
    }
    return { status: res.status, body };
  }
}

let gatePromise: Promise<Record<string, unknown>> | null = null;

/**
 * The dry-run gate every fr/ file awaits in beforeAll. Resolves to the
 * active policy document; throws (failing the whole file) when the server
 * is unreachable, the key is bad, or effective dry run is OFF.
 */
export function gate(): Promise<Record<string, unknown>> {
  gatePromise ??= (async () => {
    const health = await frFetch("GET", "/health");
    if (health.status !== 200) {
      throw new Error(`FR gate: GET /health answered ${health.status} at ${BASE}`);
    }
    const res = await frFetch("GET", "/policy");
    if (res.status !== 200) {
      throw new Error(
        `FR gate: GET /policy answered ${res.status} (${JSON.stringify(res.body)}) — bad FR_API_KEY?`,
      );
    }
    if (res.body["dryRun"] !== true) {
      throw new Error(
        "FR gate: effective dry run is OFF on the target server. " +
          "The FR suite only ever runs in dry run; refusing.",
      );
    }
    return res.body;
  })();
  return gatePromise;
}

/** One assistant turn, counted against the per-run model-call budget. */
export async function assistantMessage(
  text: string,
  options: { conversationId?: string; location?: { lat: number; lng: number } } = {},
): Promise<FrResponse> {
  assistantCalls += 1;
  if (assistantCalls > ASSISTANT_MAX_CALLS) {
    throw new Error(
      `FR budget: this run already made ${ASSISTANT_MAX_CALLS} assistant model calls ` +
        "(FR_ASSISTANT_MAX_CALLS). Refusing to spend more.",
    );
  }
  return frFetch("POST", "/assistant/message", {
    text,
    ...(options.conversationId ? { conversation_id: options.conversationId } : {}),
    ...(options.location ? { location: options.location } : {}),
  });
}

// ---------------------------------------------------------------------------
// Time helpers: /parked prices at the request ts, and a ts outside
// [now-24h, now+10min] is clamped to server time — so the tests phrase
// "a weekday afternoon" as YESTERDAY at that local Eastern time, which is
// inside the window whenever the suite runs before that hour (the nightly
// cron fires ~5am Eastern).
// ---------------------------------------------------------------------------

const ET = "America/New_York";

function etParts(d: Date): { y: number; m: number; d: number; weekday: string; offset: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    timeZoneName: "longOffset",
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const gmt = get("timeZoneName"); // "GMT-4" | "GMT-5"
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(gmt);
  const offset = m ? `${m[1]}${m[2]!.padStart(2, "0")}:${m[3] ?? "00"}` : "-05:00";
  return {
    y: Number(get("year")),
    m: Number(get("month")),
    d: Number(get("day")),
    weekday: get("weekday"),
    offset,
  };
}

/** ISO timestamp at hh:mm Eastern on the calendar day `daysAgo` days back. */
export function easternDaysAgoAt(daysAgo: number, hh: number, mm: number): string {
  const day = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  const p = etParts(day);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(hh)}:${pad(mm)}:00${p.offset}`;
}

/**
 * The most recent occurrence of hh:mm Eastern that is already in the past
 * — today's if the clock has passed it, else yesterday's. Always inside
 * /parked's [now-24h, now+10min] window, so it prices as sent instead of
 * being clamped to server time, whatever hour the suite runs at.
 */
export function mostRecentEasternAt(hh: number, mm: number): string {
  const today = easternDaysAgoAt(0, hh, mm);
  if (Date.parse(today) <= Date.now() - 60_000) return today;
  return easternDaysAgoAt(1, hh, mm);
}

/** Weekday ("Sun".."Sat") of an ISO timestamp, in Eastern time. */
export function easternWeekday(iso: string): string {
  return etParts(new Date(iso)).weekday;
}

/** True while the current Eastern local time is inside [startH, endH). */
export function easternHourWithin(startH: number, endH: number): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: ET, hour: "numeric", hour12: false }).format(
      new Date(),
    ),
  );
  return hour >= startH && hour < endH;
}

// ---------------------------------------------------------------------------
// Fixture coordinates: real zones read from the loaded dataset (centerline
// centroids). Env-overridable so a re-drawn block doesn't need a code
// change. If a location test starts failing with unknown_zone or an
// unexpected rule, re-check the zone here against the zones table first.
// ---------------------------------------------------------------------------

function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? Number(v) : fallback;
}

/** nyc-417371, 30th Ave & Steinway: $2.00/$3.00, 120 min — under every cap
 * and the rate ceiling, so a weekday-afternoon park auto-pays. */
export const NYC_AUTOPAY = {
  lat: num("FR_NYC_AUTOPAY_LAT", 40.76264),
  lng: num("FR_NYC_AUTOPAY_LNG", -73.91611),
};

/** nyc-100031 (Financial District): $5.50/$9.00 — the ladder tops the
 * $8/hr auto-pay ceiling, so this zone must never auto-pay. */
export const NYC_PRICEY = {
  lat: num("FR_NYC_PRICEY_LAT", 40.70237),
  lng: num("FR_NYC_PRICEY_LNG", -74.01124),
};

/** bos-boylston-st-d-c-0cf971 — Boylston between Dartmouth and Clarendon,
 * the acceptance-run block. Posted ParkBoston zone number 456 (verified
 * live 2026-09-23, receipts in docs/acceptance-report.md Part B). */
export const BOS_ZONE_456 = {
  lat: num("FR_BOS_456_LAT", 42.35038),
  lng: num("FR_BOS_456_LNG", -71.0763),
  postedNumber: process.env["FR_BOS_456_NUMBER"] ?? "456",
};

/** bos-albany-st-6810a4-00 — a South End block with no reported ParkBoston
 * number ($2.00 flat, Mon–Sat 08:00–18:00). If a driver or import ever
 * numbers it, the without-number test skips itself. */
export const BOS_UNNUMBERED = {
  lat: num("FR_BOS_UNNUMBERED_LAT", 42.33527),
  lng: num("FR_BOS_UNNUMBERED_LNG", -71.07112),
};

/** Open water south of Long Island — no metered zone within 20 km. */
export const NOWHERE = { lat: 40.55, lng: -73.4 };

/** POST /parked body with the FR marker signal (greppable in decisions). */
export function parkedBody(
  at: { lat: number; lng: number },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    lat: at.lat,
    lng: at.lng,
    accuracy: 10,
    signals: ["fr_suite"],
    ...overrides,
  };
}

/**
 * The pay-by-app fee the active policy sets for a city, resolved the way
 * API.md documents it: `city_overrides.<city>.parking_fee_usd`, else the
 * deprecated top-level `parknyc_fee_usd` (accepted for one release). A quote
 * whose fee isn't this number is reading the wrong key — asserting only
 * `fee > 0` couldn't tell, because the server's last-resort default happens
 * to equal NYC's fee.
 */
export function policyFeeUsd(policy: Record<string, unknown>, city: "nyc" | "bos"): number {
  const overrides = policy["city_overrides"] as
    Record<string, { parking_fee_usd?: unknown } | undefined> | undefined;
  const fee = overrides?.[city]?.parking_fee_usd ?? policy["parknyc_fee_usd"];
  if (typeof fee !== "number") {
    throw new Error(
      `FR: the active policy sets no pay-by-app fee for ${city} ` +
        `(city_overrides.${city}.parking_fee_usd) — was migrate:policy-fee applied?`,
    );
  }
  return fee;
}

/** Ladder pricing as API.md documents it: first 60 charged minutes at the
 * first-hour rate, the rest at the additional-hour rate, prorated, rounded
 * half-up once. Used to check a live quote is self-consistent. */
export function ladderMeterUsd(
  chargedMinutes: number,
  firstHourUsd: number,
  additionalHourUsd: number,
): number {
  const first = Math.min(chargedMinutes, 60);
  const rest = Math.max(chargedMinutes - 60, 0);
  const raw = (first / 60) * firstHourUsd + (rest / 60) * additionalHourUsd;
  return Math.round(raw * 100 + Number.EPSILON) / 100;
}
