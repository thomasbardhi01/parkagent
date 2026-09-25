/**
 * APNs push sending, token-based auth (no external deps: ES256 JWT via
 * node:crypto, HTTP/2 via node:http2).
 *
 * Config comes from APNS_KEY (the .p8 file contents), APNS_KEY_ID,
 * APNS_TEAM_ID, APNS_BUNDLE_ID. With any of them missing the sender is a
 * logging no-op, so dev servers work without Apple credentials. Tokens are
 * read from device_tokens per user; each row's environment picks the
 * sandbox or production host, and a 400 BadDeviceToken / 410 Unregistered
 * response deletes the row.
 */

import { createPrivateKey, sign } from "node:crypto";
import { connect, constants as h2 } from "node:http2";

import { providerById } from "../providers/registry.js";

// The push types the iOS app handles (see API.md).
export type PushType =
  | "session_started"
  | "session_extended"
  | "session_expiring"
  | "payment_failed"
  | "provider_relink"
  | "itinerary_garage_link"
  | "free_period"
  | "card_declined";

export interface Push {
  type: PushType;
  title: string;
  body: string;
  /** Extra keys merged into the payload root next to `type`. */
  extra?: Record<string, unknown>;
}

/** Injectable seam: routes and the worker only know this signature. */
export type PushSender = (userId: string, push: Push) => Promise<void>;

// ---------------------------------------------------------------------------
// Templates. Dry-run pushes say what *would* have happened — the week-one
// audit loop reads these instead of a bank statement.

const money = (usd: number) => `$${usd.toFixed(2)}`;

export function sessionStartedPush(args: {
  zoneNumber: string;
  minutes: number;
  totalUsd: number;
  expiresAt: Date;
  dryRun: boolean;
}): Push {
  const paid = args.dryRun ? "Would have paid" : "Paid";
  return {
    type: "session_started",
    title: args.dryRun ? "Dry run: meter session" : "Meter paid",
    body: `${paid} ${money(args.totalUsd)} for ${args.minutes} min in zone ${args.zoneNumber}.`,
    extra: { expiresAt: args.expiresAt.toISOString() },
  };
}

export function sessionExtendedPush(args: {
  zoneNumber: string;
  minutes: number;
  totalUsd: number;
  expiresAt: Date;
  dryRun: boolean;
}): Push {
  const paid = args.dryRun ? "would have added" : "added";
  return {
    type: "session_extended",
    title: args.dryRun ? "Dry run: extended" : "Session extended",
    body: `Auto-extend ${paid} ${args.minutes} min (${money(args.totalUsd)}) in zone ${args.zoneNumber}.`,
    extra: { expiresAt: args.expiresAt.toISOString() },
  };
}

export type ExpiringReason = "max_stay" | "budget" | "no_auto_extend";

export function sessionExpiringPush(args: {
  zoneNumber: string;
  minutesLeft: number;
  reason: ExpiringReason;
}): Push {
  const why = {
    max_stay: "the zone's max stay is up — move the car",
    budget: "extending would blow the budget",
    no_auto_extend: "auto-extend is off or used up",
  }[args.reason];
  return {
    type: "session_expiring",
    title: "Meter expiring",
    body: `Zone ${args.zoneNumber} expires in ${args.minutesLeft} min and ${why}.`,
    extra: { reason: args.reason },
  };
}

export function paymentFailedPush(args: {
  zoneNumber: string;
  what: "pay" | "extend";
  code: string;
  /** The session city's provider display name from the registry ("ParkNYC",
   * "ParkBoston"); callers pass a neutral fallback when the city has none. */
  providerName: string;
}): Push {
  // A card-less account, an unknown plate, or an operator lockout are
  // distinct, actionable failures: the fix is doing something in the
  // provider's own app (or waiting), not blindly "retry"/"tap to pay".
  const body =
    args.code === "payment_method_missing"
      ? `The meter for zone ${args.zoneNumber} is unpaid — add a card to ${args.providerName}, then tap to pay.`
      : args.code === "vehicle_missing"
        ? `${args.providerName} doesn't know your plate — add your vehicle there, then tap to pay zone ${args.zoneNumber}.`
        : args.code === "parking_denied"
          ? `${args.providerName} won't let you re-park zone ${args.zoneNumber} right now (an operator lockout). Nothing was charged — wait or move the car.`
          : `Could not ${args.what} zone ${args.zoneNumber} (${args.code}). The meter is unpaid — tap to pay.`;
  return {
    type: "payment_failed",
    title:
      args.code === "payment_method_missing"
        ? `Add a card to ${args.providerName}`
        : args.code === "vehicle_missing"
          ? `Add your plate to ${args.providerName}`
          : args.code === "parking_denied"
            ? "Parking blocked right now"
            : "Payment failed",
    body,
    extra: {
      code: args.code,
      zoneNumber: args.zoneNumber,
      // Tap-to-pay fallback: the app opens its pay screen with the zone
      // prefilled (and copies the zone number for the provider's app).
      deepLink: `parkagent://pay?zone=${encodeURIComponent(args.zoneNumber)}`,
    },
  };
}

/** The provider says this zone isn't charging now (after hours) — parking
 * is free; nothing was paid and there's nothing to tap. */
export function freePeriodPush(args: { zoneNumber: string; notice: string }): Push {
  return {
    type: "free_period",
    title: "Parking is free here right now",
    body: `No need to pay in zone ${args.zoneNumber} — ${args.notice}`,
    extra: { zoneNumber: args.zoneNumber },
  };
}

/** The ParkAgent card's funding card refused the hold for a leg: nothing
 * was paid (the hold comes before the provider), and the fix is in the
 * Wallet, not a retry. */
export function cardDeclinedPush(args: { zoneNumber: string; what: "pay" | "extend" }): Push {
  return {
    type: "card_declined",
    title: "Card declined",
    body:
      args.what === "pay"
        ? `Your card was declined — update it in Wallet. The meter for zone ${args.zoneNumber} is unpaid.`
        : `Your card was declined — update it in Wallet. Zone ${args.zoneNumber} was not extended.`,
    extra: { zoneNumber: args.zoneNumber, deepLink: "parkagent://wallet" },
  };
}

/** 15 minutes before a garage stop: the prepaid/deep link, one tap away. */
export function itineraryGaragePush(args: {
  stopLabel: string;
  itineraryId: string;
  stopId: string;
  deepLink: string;
}): Push {
  return {
    type: "itinerary_garage_link",
    title: `Garage for "${args.stopLabel}"`,
    body: "Your garage link is ready — open it at the entrance.",
    extra: { itineraryId: args.itineraryId, stopId: args.stopId, deepLink: args.deepLink },
  };
}

export function providerRelinkPush(args: { provider: string; displayName: string }): Push {
  return {
    type: "provider_relink",
    title: `${args.displayName} needs a re-link`,
    body: `Your ${args.displayName} session expired — sign in again so ParkAgent can keep paying meters.`,
    extra: {
      provider: args.provider,
      deepLink: `parkagent://providers/link?provider=${encodeURIComponent(args.provider)}`,
    },
  };
}

/** The five user-facing push types, and a representative sample of each —
 * what the admin push-test endpoint sends to prove delivery end to end. */
export const PUSH_TEST_TYPES = [
  "session_started",
  "session_extended",
  "session_expiring",
  "payment_failed",
  "provider_relink",
] as const;

export type PushTestType = (typeof PUSH_TEST_TYPES)[number];

/** The samples describe one Boston park (zone 456 on Boylston), so their
 * provider is Boston's — named from the registry like every real push. */
const SAMPLE_PROVIDER = providerById("passport");
const SAMPLE_PROVIDER_NAME = SAMPLE_PROVIDER?.displayName ?? "your parking account";

/** Build a labeled sample of one push type for the delivery test. */
export function samplePush(type: PushTestType, now: Date): Push {
  const expires = new Date(now.getTime() + 30 * 60_000);
  switch (type) {
    case "session_started":
      return sessionStartedPush({
        zoneNumber: "456",
        minutes: 90,
        totalUsd: 5.98,
        expiresAt: expires,
        dryRun: false,
      });
    case "session_extended":
      return sessionExtendedPush({
        zoneNumber: "456",
        minutes: 30,
        totalUsd: 1.94,
        expiresAt: expires,
        dryRun: false,
      });
    case "session_expiring":
      return sessionExpiringPush({ zoneNumber: "456", minutesLeft: 10, reason: "max_stay" });
    case "payment_failed":
      return paymentFailedPush({
        zoneNumber: "456",
        what: "pay",
        code: "payment_declined",
        providerName: SAMPLE_PROVIDER_NAME,
      });
    case "provider_relink":
      return providerRelinkPush({
        provider: SAMPLE_PROVIDER?.id ?? "passport",
        displayName: SAMPLE_PROVIDER_NAME,
      });
  }
}

// ---------------------------------------------------------------------------
// Transport.

export interface ApnsConfig {
  key: string; // .p8 contents; "\n" escapes accepted for env transport
  keyId: string;
  teamId: string;
  bundleId: string;
}

interface TokenRow {
  id: string;
  token: string;
  environment: string;
}

export interface ApnsDb {
  deviceToken: {
    findMany(args: { where: { userId: string } }): Promise<TokenRow[]>;
    delete(args: { where: { id: string } }): Promise<unknown>;
  };
}

/** Build the provider JWT. Apple wants it rotated between 20 and 60 min. */
function makeJwt(config: ApnsConfig, nowMs: number): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned =
    b64({ alg: "ES256", kid: config.keyId }) +
    "." +
    b64({ iss: config.teamId, iat: Math.floor(nowMs / 1000) });
  const key = createPrivateKey(config.key.replace(/\\n/g, "\n"));
  const signature = sign("sha256", Buffer.from(unsigned), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return unsigned + "." + signature.toString("base64url");
}

function postNotification(
  host: string,
  jwt: string,
  bundleId: string,
  deviceToken: string,
  payload: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const client = connect(`https://${host}`);
    client.on("error", reject);
    const req = client.request({
      [h2.HTTP2_HEADER_METHOD]: "POST",
      [h2.HTTP2_HEADER_PATH]: `/3/device/${deviceToken}`,
      authorization: `bearer ${jwt}`,
      "apns-topic": bundleId,
      "apns-push-type": "alert",
      "content-type": "application/json",
    });
    let status = 0;
    let body = "";
    req.on("response", (headers) => {
      status = Number(headers[h2.HTTP2_HEADER_STATUS] ?? 0);
    });
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      client.close();
      resolve({ status, body });
    });
    req.on("error", (err) => {
      client.close();
      reject(err);
    });
    req.end(JSON.stringify(payload));
  });
}

const JWT_TTL_MS = 50 * 60_000;

/** One device's delivery outcome — what the debug endpoint reports back. */
export interface ApnsDeliveryResult {
  /** First 8 chars only; a device token is a credential. */
  tokenPrefix: string;
  environment: string;
  /** APNs HTTP status (200 = accepted), or null when the request threw. */
  status: number | null;
  /** APNs `reason` on a non-200 (e.g. "BadDeviceToken"), else null. */
  reason: string | null;
  /** True when a 410/BadDeviceToken caused the row to be deleted. */
  deleted: boolean;
}

/** Delivery status for a whole send: config/target state plus per-device
 * APNs results. Returned by the debug sender; the void PushSender ignores it. */
export interface ApnsSendReport {
  configured: boolean;
  deviceCount: number;
  results: ApnsDeliveryResult[];
}

/**
 * Core APNs delivery, returning a per-device report. Fans a push out to
 * every registered device of the user; failures are captured (and logged),
 * never thrown — a push must not fail the money path.
 */
export function makeApnsDelivery(
  config: ApnsConfig | null,
  db: ApnsDb,
  log: { info: (msg: string) => void; warn: (msg: string) => void },
  now: () => Date = () => new Date(),
): (userId: string, push: Push) => Promise<ApnsSendReport> {
  let cachedJwt: { value: string; at: number } | null = null;

  return async (userId, push) => {
    const tokens = await db.deviceToken.findMany({ where: { userId } });
    if (!config) {
      log.info(`apns not configured; skipping "${push.type}" to ${tokens.length} device(s)`);
      return { configured: false, deviceCount: tokens.length, results: [] };
    }
    if (tokens.length === 0) {
      log.info(`no device tokens for user ${userId}; dropping "${push.type}"`);
      return { configured: true, deviceCount: 0, results: [] };
    }
    const nowMs = now().getTime();
    if (!cachedJwt || nowMs - cachedJwt.at > JWT_TTL_MS) {
      cachedJwt = { value: makeJwt(config, nowMs), at: nowMs };
    }
    const payload = {
      aps: { alert: { title: push.title, body: push.body }, sound: "default" },
      type: push.type,
      ...push.extra,
    };
    const results: ApnsDeliveryResult[] = [];
    for (const row of tokens) {
      const host =
        row.environment === "development" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
      const base: ApnsDeliveryResult = {
        tokenPrefix: row.token.slice(0, 8),
        environment: row.environment,
        status: null,
        reason: null,
        deleted: false,
      };
      try {
        const res = await postNotification(
          host,
          cachedJwt.value,
          config.bundleId,
          row.token,
          payload,
        );
        base.status = res.status;
        // APNs returns `{"reason": "..."}` on non-200.
        if (res.status !== 200 && res.body) {
          try {
            base.reason = (JSON.parse(res.body) as { reason?: string }).reason ?? null;
          } catch {
            base.reason = res.body.slice(0, 120);
          }
        }
        if (res.status === 410 || (res.status === 400 && res.body.includes("BadDeviceToken"))) {
          log.warn(`apns token ${row.token.slice(0, 8)}… rejected (${res.status}); deleting`);
          await db.deviceToken.delete({ where: { id: row.id } });
          base.deleted = true;
        } else if (res.status !== 200) {
          log.warn(`apns ${res.status} for "${push.type}": ${res.body}`);
        }
      } catch (err) {
        base.reason = String(err).split("\n")[0] ?? "error";
        log.warn(`apns send failed: ${String(err)}`);
      }
      results.push(base);
    }
    return { configured: true, deviceCount: tokens.length, results };
  };
}

/**
 * Real sender (the money-path seam). Fans a push out to every registered
 * device; failures are logged, never thrown. A thin wrapper over
 * makeApnsDelivery that discards the per-device report.
 */
export function makeApnsSender(
  config: ApnsConfig | null,
  db: ApnsDb,
  log: { info: (msg: string) => void; warn: (msg: string) => void },
  now: () => Date = () => new Date(),
): PushSender {
  const deliver = makeApnsDelivery(config, db, log, now);
  return async (userId, push) => {
    await deliver(userId, push);
  };
}
