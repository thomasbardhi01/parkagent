/**
 * Harness for the live functional-requirements suite
 * (docs/functional-requirements.md). Every test in fr/ talks to a REAL
 * deployed API (prod by default), in dry run.
 *
 * Isolation: every fr/ file runs as its OWN throwaway user, claimed by the
 * file's label from the minted pool (`ownUser`; the labels are in
 * pool.mjs, minted by `create-fr-throwaway --pool`). The file deletes its
 * conversations and then the account when its last test ends, so no file
 * reads state another left, and the suite runs shuffled (vitest.fr.config.ts).
 *
 * Guard rails, in order of importance:
 *  - `gate()` refuses to run anything until GET /policy reports effective
 *    dryRun true. The suite never runs against a server that can move money.
 *  - FR_API_KEY belongs to the dedicated FR user (`pnpm -C server
 *    create:fr-user`), never a person's key. It is used for the gate, the
 *    admin routes, and as a read-only observer — no test changes its state.
 *  - Assistant turns are paid model calls; `assistantMessage()` counts them
 *    and fails the run past FR_ASSISTANT_MAX_CALLS (default 12) so a retry
 *    loop can never run up a bill.
 *  - The suite never calls PUT /policy, /session/extend|stop, any /card
 *    route, or a real provider link — nothing here can change the spending
 *    contract or touch a provider account. PUT /wallet/source is called
 *    only with values a throwaway can't make ready; nothing creates a
 *    Stripe Customer, SetupIntent, hold, or Link spend request.
 *  - DELETE /me is never sent with the FR key (frFetch refuses it): only a
 *    throwaway's bearer may delete, and a bearer request never falls back
 *    to the key, so a lost bearer can't delete the FR user every later
 *    nightly depends on.
 */

import { readFileSync } from "node:fs";

import { afterAll, beforeAll } from "vitest";

import { EXTRA_USERS, fileLabel } from "./pool.mjs";

export const BASE = (process.env["FR_API_BASE"] ?? "https://parkagent-api.fly.dev").replace(
  /\/$/,
  "",
);

const KEY = process.env["FR_API_KEY"];

const ASSISTANT_MAX_CALLS = Number(process.env["FR_ASSISTANT_MAX_CALLS"] ?? "12");
let assistantCalls = 0;

export interface FrResponse {
  status: number;
  body: Record<string, unknown>;
  /** Response headers, lowercased. */
  headers: Record<string, string>;
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

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export async function frFetch(
  method: Method,
  path: string,
  payload?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<FrResponse> {
  if (method === "DELETE" && path.split("?")[0] === "/me") {
    throw new Error(
      "FR: refusing DELETE /me with the FR key — that would delete the FR user itself.",
    );
  }
  if (!KEY) {
    throw new Error(
      "FR_API_KEY is not set. Create the dedicated FR user with " +
        "`pnpm -C server create:fr-user` and export its key — never a personal key.",
    );
  }
  return send(method, path, payload, { "x-api-key": KEY, ...extraHeaders });
}

/** One request with the suite's two retries: a connect-phase failure and
 * one 429 Retry-After. Carries exactly the auth header it's given. */
async function send(
  method: Method,
  path: string,
  payload: unknown,
  headers: Record<string, string>,
): Promise<FrResponse> {
  // The abuse limits are per user (e.g. /parked 30/min); a second run
  // minutes after the first can trip them. Waiting out one Retry-After is
  // signal-preserving — the retry answers the real question.
  for (let attempt = 0; ; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          ...(payload !== undefined ? { "content-type": "application/json" } : {}),
          ...headers,
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
    return { status: res.status, body: await readBody(res), headers: headersOf(res) };
  }
}

function headersOf(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

async function readBody(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return { raw: text };
  }
}

/**
 * A request as an app SESSION — a bearer access token, or nothing at all
 * for the public /auth/* routes. Never sends x-api-key, by construction:
 * the FR-32 tests delete their throwaway account, and a request that lost
 * its bearer must fail 401, not fall back to the FR user.
 */
export async function sessionFetch(
  method: Method,
  path: string,
  options: { bearer?: string; payload?: unknown } = {},
): Promise<FrResponse> {
  const { bearer, payload } = options;
  if (method === "DELETE" && path === "/me" && !bearer) {
    throw new Error("FR: DELETE /me needs the throwaway's bearer token");
  }
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(payload !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  return { status: res.status, body: await readBody(res), headers: headersOf(res) };
}

/** A throwaway user from FR_THROWAWAY_POOL (minted by `pnpm -C server
 * create:fr-throwaway --pool`, an admin script run where the target's
 * secrets live — never an API route). Its tokens are updated in place
 * whenever the harness refreshes them. */
export interface FrUser {
  label: string;
  userId: string;
  deviceId: string;
  accessToken: string;
  refreshToken: string;
  /** Set by a test that deleted the account itself and proved it gone. */
  deleted: boolean;
}

let pool: Record<string, Record<string, unknown>> | null = null;

/** The minted pool: from the file FR_THROWAWAY_POOL_FILE names (the
 * nightly — an env var's value is printed in every later step's log
 * header, and user and device ids needn't be public), else the JSON in
 * FR_THROWAWAY_POOL (a local run). */
function readPool(): string | undefined {
  const file = process.env["FR_THROWAWAY_POOL_FILE"]?.trim();
  if (file) return readFileSync(file, "utf8").trim();
  return process.env["FR_THROWAWAY_POOL"]?.trim();
}

function poolEntry(label: string): Omit<FrUser, "label" | "deleted"> {
  if (!pool) {
    const raw = readPool();
    if (!raw) {
      throw new Error(
        "No throwaway pool: set FR_THROWAWAY_POOL_FILE or FR_THROWAWAY_POOL. Every FR file runs as its " +
          'own throwaway user: mint them with `pnpm -C server create:fr-throwaway --pool "$(node ' +
          "server/fr/pool.mjs)\"` against the target's database, and save or export the JSON line it prints.",
      );
    }
    pool = JSON.parse(raw) as Record<string, Record<string, unknown>>;
  }
  const entry = pool[label];
  if (!entry) {
    throw new Error(
      `FR_THROWAWAY_POOL has no user labelled "${label}" — was the pool minted from this ` +
        "checkout's pool.mjs?",
    );
  }
  for (const key of ["userId", "deviceId", "refreshToken", "accessToken"] as const) {
    if (typeof entry[key] !== "string" || entry[key] === "") {
      throw new Error(`FR_THROWAWAY_POOL.${label} is missing ${key}`);
    }
  }
  return entry as unknown as Omit<FrUser, "label" | "deleted">;
}

/**
 * This file's own throwaway user (or, with `extra`, one of the extra users
 * pool.mjs declares for it). Registers the file's hooks: before its first
 * test, the gate runs and the user must authenticate as itself; after its
 * last, the user's conversations and then the account are deleted, and the
 * account is proven gone. Call at the top level of an fr/ file.
 */
export function ownUser(fileUrl: string, extra?: string): FrUser {
  const file = fileLabel(fileUrl);
  if (extra !== undefined && !(EXTRA_USERS as Record<string, string[]>)[file]?.includes(extra)) {
    throw new Error(
      `FR: ${file} asked for an extra user "${extra}" — declare it in fr/pool.mjs so it's minted`,
    );
  }
  const label = extra === undefined ? file : `${file}.${extra}`;
  const user: FrUser = { label, ...poolEntry(label), deleted: false };

  beforeAll(async () => {
    await gate();
    const me = await userFetch(user, "GET", "/me");
    if (me.status !== 200) {
      throw new Error(`FR: ${label}'s throwaway doesn't authenticate (GET /me ${me.status})`);
    }
    const id = (me.body["user"] as Record<string, unknown> | undefined)?.["id"];
    if (id !== user.userId) {
      throw new Error(`FR: ${label}'s bearer is user ${String(id)}, not ${user.userId}`);
    }
  });
  afterAll(async () => {
    await releaseUser(user);
  });
  return user;
}

/** Delete a throwaway's conversations, then the account; prove it gone.
 * Throws when any step answers wrong, so a leak fails its file (the
 * nightly's purge still removes what a dead run leaves). */
async function releaseUser(user: FrUser): Promise<void> {
  if (user.deleted) return;
  for (;;) {
    const list = await userFetch(user, "GET", "/assistant/conversations?limit=50");
    if (list.status !== 200) {
      throw new Error(`FR: listing ${user.label}'s conversations answered ${list.status}`);
    }
    const conversations = list.body["conversations"] as { id: string }[];
    if (conversations.length === 0) break;
    for (const c of conversations) {
      const deleted = await userFetch(
        user,
        "DELETE",
        `/assistant/conversations/${encodeURIComponent(c.id)}`,
      );
      if (deleted.status !== 200) {
        throw new Error(
          `FR: deleting ${user.label}'s conversation ${c.id} answered ${deleted.status}`,
        );
      }
    }
  }
  const bearer = await freshBearer(user);
  const res = await sessionFetch("DELETE", "/me", { bearer });
  if (res.status !== 200) {
    throw new Error(`FR: DELETE /me for ${user.label} answered ${res.status}`);
  }
  user.deleted = true;
  const after = await sessionFetch("GET", "/me", { bearer });
  if (after.status !== 401) {
    throw new Error(`FR: ${user.label} still authenticates after DELETE /me (${after.status})`);
  }
}

/** Seconds left on an access JWT (its `exp`), or 0 when unreadable. */
function secondsLeft(accessToken: string): number {
  try {
    const claims = JSON.parse(
      Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { exp?: unknown };
    return typeof claims.exp === "number" ? claims.exp - Date.now() / 1000 : 0;
  } catch {
    return 0;
  }
}

/** The user's access token, refreshed first when it has under 90 s left
 * (the pool is minted before the suite; a file late in a shuffled run
 * starts past the 15-minute lifetime). A refresh carries a secret, so it
 * is never retried: a failure fails the test that needed it. */
export async function freshBearer(user: FrUser): Promise<string> {
  if (secondsLeft(user.accessToken) >= 90) return user.accessToken;
  const res = await sessionFetch("POST", "/auth/refresh", {
    payload: { refreshToken: user.refreshToken, deviceId: user.deviceId },
  });
  if (res.status !== 200) {
    throw new Error(
      `FR: refreshing ${user.label}'s session answered ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  user.accessToken = res.body["accessToken"] as string;
  user.refreshToken = res.body["refreshToken"] as string;
  return user.accessToken;
}

/** A request as a throwaway user: its bearer (refreshed ahead of expiry)
 * and the suite's retries — never the FR key. */
export async function userFetch(
  user: FrUser,
  method: Method,
  path: string,
  payload?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<FrResponse> {
  const bearer = await freshBearer(user);
  return send(method, path, payload, { authorization: `Bearer ${bearer}`, ...extraHeaders });
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

/** One assistant turn as `user`, counted against the per-run model-call
 * budget. */
export async function assistantMessage(
  user: FrUser,
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
  return userFetch(user, "POST", "/assistant/message", {
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

/** "2026-10-06": the Eastern calendar date `daysAhead` after `now`'s. */
function easternDate(now: Date, daysAhead: number): string {
  const p = etParts(now);
  return new Date(Date.UTC(p.y, p.m - 1, p.d + daysAhead, 12)).toISOString().slice(0, 10);
}

/** hh:mm Eastern on a calendar date, as ISO with that day's offset. */
function easternIsoOn(date: string, hh: number, mm: number): string {
  // Noon Eastern that day (16:00Z is noon EDT, 11 AM EST): its offset.
  const { offset } = etParts(new Date(`${date}T16:00:00Z`));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date}T${pad(hh)}:${pad(mm)}:00${offset}`;
}

/**
 * The day the assistant tests ask about, pinned so a run's scenario never
 * depends on the hour it runs at: the next Tuesday at least two days out
 * — never today or tomorrow, so no "has 7 PM passed yet?" reading, and
 * always a weekday both cities enforce. Nightly 36361125345 asked "at 7
 * PM" at 8:11 PM and tested a different scenario from the 5 AM runs.
 * `phrase` is how a person says it: "on Tuesday, October 6".
 */
export function pinnedDay(now = new Date()): { phrase: string; date: string } {
  for (let ahead = 2; ahead <= 8; ahead += 1) {
    const date = easternDate(now, ahead);
    const day = new Date(`${date}T16:00:00Z`);
    if (easternWeekday(day.toISOString()) !== "Tue") continue;
    const month = new Intl.DateTimeFormat("en-US", { timeZone: ET, month: "long" }).format(day);
    return { phrase: `on Tuesday, ${month} ${Number(date.slice(8))}`, date };
  }
  throw new Error("FR: no Tuesday within 8 days"); // unreachable
}

/**
 * A clock time that has already passed today by 90 minutes or more, on
 * the half hour ("6:30 PM"), with its next occurrence tomorrow — the "ask
 * after the time" scenario, pinned relative to the run. Null within 90
 * minutes of midnight Eastern, when nothing today has passed that long.
 */
export function passedClockTime(
  now = new Date(),
): { label: string; clock: string; tomorrowIso: string } | null {
  const earlier = new Date(now.getTime() - 90 * 60_000);
  if (easternDate(earlier, 0) !== easternDate(now, 0)) return null;
  const [hh, mm] = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(earlier)
    .split(":")
    .map(Number) as [number, number];
  const minute = mm >= 30 ? 30 : 0;
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  const suffix = hh < 12 ? "AM" : "PM";
  return {
    label: minute === 0 ? `${h12} ${suffix}` : `${h12}:30 ${suffix}`,
    // How the card's window writes it: "6:30–8:30 PM", "6:00–8:00 PM".
    clock: `${h12}:${minute === 0 ? "00" : "30"}`,
    tomorrowIso: easternIsoOn(easternDate(now, 1), hh, minute),
  };
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

/** A point about 27 m inside the Prudential Center's underground garage in
 * Back Bay (bos-prudential-center-parking-garage-31d731 in the 2026-10-01
 * OSM load). FR-49 finds the garage by its name, not its id: a rename at
 * the source changes the id's slug, and the name is what a person knows. */
export const BOS_GARAGE = {
  lat: num("FR_BOS_GARAGE_LAT", 42.3464),
  lng: num("FR_BOS_GARAGE_LNG", -71.08176),
  name: new RegExp(process.env["FR_BOS_GARAGE_NAME"] ?? "Prudential", "i"),
};

/** The inner harbor between downtown and East Boston: inside no garage or
 * lot, with at most a pier's lot within 400 m. */
export const BOS_HARBOR = { lat: 42.3625, lng: -71.0425 };

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
