/**
 * Link wallet orchestration: OAuth connect state, sealed token storage
 * (same AES-256-GCM StateCrypto as provider cookies — tokens never leave
 * the server unsealed), per-stop spend requests on plan confirmation, and
 * the one-time-card lifecycle.
 *
 * Scope (the Wallet's "Link" choice): assistant plans and garages. A
 * spend request is made for each paid GARAGE stop — the user approves it
 * in Link, then pays at the garage's own checkout with the one-time card
 * (revealCard, Face ID in the app). Street meters never use Link: the
 * executor would have to put the one-time card on the provider account,
 * whose single saved card is the user's own and can't be restored after.
 */

import { createHash, randomBytes } from "node:crypto";

import type { AppDb } from "../../db.js";
import type { StateCrypto } from "../crypto.js";
import type {
  LinkClient,
  LinkOneTimeCard,
  LinkPaymentMethodSummary,
  LinkTokens,
} from "./linkClient.js";
import { LINK_APPROVAL_WINDOW_MS } from "./linkClient.js";

export interface LinkWalletDeps {
  db: AppDb;
  stateCrypto?: StateCrypto | undefined;
  linkClient?: LinkClient | undefined;
  /** LINK_TEST_MODE: spend requests carry test:true and never charge —
   * the only way one may be created while dry run is on. */
  testMode?: boolean | undefined;
  now?: (() => Date) | undefined;
}

/** Link's statuses for a request still waiting on the user. */
export const LINK_AWAITING_APPROVAL = ["created", "pending_approval", "requires_action"];

/** How stale the cached Link payment method may get before GET /wallet
 * asks Link again (best effort — a failure keeps the cached one). */
const PAYMENT_METHOD_MAX_AGE_MS = 10 * 60_000;

export interface PendingLinkApproval {
  spendRequestId: string;
  amountUsd: number;
  merchantName: string | null;
  approvalUrl: string | null;
  expiresAt: string;
}

/** How close to access-token expiry we refresh proactively. */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** Pending OAuth handshakes (state → verifier). In-memory on purpose: the
 * whole handshake lives inside one 10-minute window on one machine; a
 * restart mid-handshake just means tapping Connect again. */
const PENDING_TTL_MS = 10 * 60_000;

interface PendingAuth {
  userId: string;
  codeVerifier: string;
  createdAt: number;
}

export class LinkWallet {
  private pending = new Map<string, PendingAuth>();

  constructor(private readonly deps: LinkWalletDeps) {}

  get configured(): boolean {
    return this.deps.linkClient !== undefined && this.deps.stateCrypto !== undefined;
  }

  /** Sandbox spend requests (test:true) — nothing can charge. */
  get testMode(): boolean {
    return this.deps.testMode === true;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async status(userId: string): Promise<{ connected: boolean; connectedAt: string | null }> {
    const row = await this.deps.db.linkAccount.findUnique({ where: { userId } });
    return {
      connected: row?.status === "connected",
      connectedAt: row?.connectedAt?.toISOString() ?? null,
    };
  }

  /** Start OAuth: PKCE verifier + CSRF state, held until the callback. */
  startConnect(userId: string): { url: string; state: string } {
    if (!this.deps.linkClient) throw new Error("link_not_configured");
    const state = randomBytes(24).toString("base64url");
    const codeVerifier = randomBytes(48).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const at = this.now().getTime();
    for (const [key, value] of this.pending) {
      if (at - value.createdAt > PENDING_TTL_MS) this.pending.delete(key);
    }
    this.pending.set(state, { userId, codeVerifier, createdAt: at });
    return { url: this.deps.linkClient.authorizationUrl({ state, codeChallenge }), state };
  }

  /** OAuth redirect landed: verify state, exchange, seal, connect. */
  async handleCallback(state: string, code: string): Promise<{ userId: string }> {
    if (!this.deps.linkClient || !this.deps.stateCrypto) throw new Error("link_not_configured");
    const pending = this.pending.get(state);
    if (!pending || this.now().getTime() - pending.createdAt > PENDING_TTL_MS) {
      throw new Error("unknown_state");
    }
    this.pending.delete(state);
    const tokens = await this.deps.linkClient.exchangeCode({
      code,
      codeVerifier: pending.codeVerifier,
    });
    await this.persistTokens(pending.userId, tokens);
    // Display only: which card/bank the wallet pays with. Best effort.
    await this.refreshPaymentMethod(pending.userId, { force: true }).catch(() => undefined);
    return { userId: pending.userId };
  }

  /** The cached Link payment method ("Link · Visa ••1234"), refreshed from
   * Link when stale. Never throws: a failed refresh keeps what we had. */
  async paymentMethod(userId: string): Promise<LinkPaymentMethodSummary | null> {
    await this.refreshPaymentMethod(userId).catch(() => undefined);
    const row = await this.deps.db.linkAccount.findUnique({ where: { userId } });
    if (row?.status !== "connected" || !row.pmType) return null;
    return {
      type: row.pmType === "bank_account" ? "bank_account" : "card",
      brand: row.pmBrand ?? null,
      last4: row.pmLast4 ?? null,
    };
  }

  private async refreshPaymentMethod(userId: string, options: { force?: boolean } = {}) {
    if (!this.deps.linkClient) return;
    const row = await this.deps.db.linkAccount.findUnique({ where: { userId } });
    if (row?.status !== "connected") return;
    const fresh =
      row.pmFetchedAt &&
      this.now().getTime() - row.pmFetchedAt.getTime() < PAYMENT_METHOD_MAX_AGE_MS;
    if (fresh && !options.force) return;
    const token = await this.accessToken(userId);
    if (!token) return;
    const pm = await this.deps.linkClient.defaultPaymentMethod(token);
    await this.deps.db.linkAccount.update({
      where: { userId },
      data: {
        pmType: pm?.type ?? null,
        pmBrand: pm?.brand ?? null,
        pmLast4: pm?.last4 ?? null,
        pmFetchedAt: this.now(),
      },
    });
  }

  /** Requests still waiting for the user's approval in Link, inside the
   * approval window — the Wallet shows them with their approval links. */
  async pendingApprovals(userId: string): Promise<PendingLinkApproval[]> {
    const at = this.now().getTime();
    const rows = await this.deps.db.linkSpendRequest.findMany({ where: { userId } });
    return rows
      .filter((r) => LINK_AWAITING_APPROVAL.includes(r.status))
      .map((r) => ({ row: r, expiresAt: approvalDeadline(r) }))
      .filter(({ expiresAt }) => expiresAt.getTime() > at)
      .sort((a, b) => b.row.createdAt.getTime() - a.row.createdAt.getTime())
      .map(({ row, expiresAt }) => ({
        spendRequestId: row.id,
        amountUsd: Number(row.amountUsd),
        merchantName: row.merchantName ?? null,
        approvalUrl: row.approvalUrl,
        expiresAt: expiresAt.toISOString(),
      }));
  }

  /**
   * The approval timeout: every request still awaiting approval past
   * Link's window becomes `expired` here, claimed with a compare-and-set so
   * an approval that lands mid-sweep is never overwritten. Nothing was
   * charged — an unapproved request never produced a card. Returns the
   * expired rows so the caller can audit them.
   */
  async expireStaleApprovals(): Promise<{ id: string; userId: string; amountUsd: number }[]> {
    const at = this.now().getTime();
    const waiting = await this.deps.db.linkSpendRequest.findMany({
      where: { status: { in: LINK_AWAITING_APPROVAL } },
    });
    const expired: { id: string; userId: string; amountUsd: number }[] = [];
    for (const row of waiting) {
      if (approvalDeadline(row).getTime() > at) continue;
      const claim = await this.deps.db.linkSpendRequest.updateMany({
        where: { id: row.id, status: { in: LINK_AWAITING_APPROVAL } },
        data: { status: "expired" },
      });
      if (claim.count === 1) {
        expired.push({ id: row.id, userId: row.userId, amountUsd: Number(row.amountUsd) });
      }
    }
    return expired;
  }

  /**
   * The one-time card of an approved garage request, for the user to pay
   * with at the garage's own checkout (we never automate it). Only the
   * owner, only while approved and unexpired, and only ONCE: the first
   * successful retrieval stamps revealed_at with a compare-and-set (only
   * where it is still null), so of any number of calls — a retry, a second
   * tap, a stolen token — exactly one ever gets the number, and every
   * later one throws `card_already_revealed`. Throws a typed message
   * otherwise, and never one carrying card data: the sealed card is opened
   * only after every check passed, and a card that won't open is
   * `card_unreadable`, never the parser's own message (which quotes its
   * input).
   */
  async revealCard(userId: string, id: string): Promise<LinkOneTimeCard> {
    if (!this.deps.stateCrypto) throw new Error("link_not_configured");
    const row = await this.deps.db.linkSpendRequest.findUnique({ where: { id } });
    if (!row || row.userId !== userId) throw new Error("unknown_spend_request");
    if (row.revealedAt != null) throw new Error("card_already_revealed");
    if (row.status !== "approved" || !row.cardEncrypted) throw new Error("not_approved");
    if (row.cardUsedAt !== null) throw new Error("card_used");
    if (row.validUntil !== null && row.validUntil.getTime() <= this.now().getTime()) {
      throw new Error("card_expired");
    }
    let card: LinkOneTimeCard;
    try {
      card = JSON.parse(this.deps.stateCrypto.open(row.cardEncrypted)) as LinkOneTimeCard;
    } catch {
      throw new Error("card_unreadable");
    }
    const claim = await this.deps.db.linkSpendRequest.updateMany({
      where: { id, status: "approved", revealedAt: null },
      data: { revealedAt: this.now() },
    });
    if (claim.count !== 1) throw new Error("card_already_revealed");
    return card;
  }

  private async persistTokens(userId: string, tokens: LinkTokens): Promise<void> {
    const sealed = this.deps.stateCrypto!.seal(JSON.stringify(tokens));
    await this.deps.db.linkAccount.upsert({
      where: { userId },
      create: { userId, status: "connected", tokensEncrypted: sealed, connectedAt: this.now() },
      update: { status: "connected", tokensEncrypted: sealed, connectedAt: this.now() },
    });
  }

  async disconnect(userId: string): Promise<void> {
    const tokens = await this.openTokens(userId);
    if (tokens && this.deps.linkClient) {
      // Best effort — a failed revoke never blocks the disconnect.
      await this.deps.linkClient.revoke(tokens.refreshToken).catch(() => {});
    }
    await this.deps.db.linkAccount.upsert({
      where: { userId },
      create: { userId, status: "disconnected", tokensEncrypted: null },
      update: {
        status: "disconnected",
        tokensEncrypted: null,
        pmType: null,
        pmBrand: null,
        pmLast4: null,
        pmFetchedAt: null,
      },
    });
  }

  private async openTokens(userId: string): Promise<LinkTokens | null> {
    if (!this.deps.stateCrypto) return null;
    const row = await this.deps.db.linkAccount.findUnique({ where: { userId } });
    if (row?.status !== "connected" || !row.tokensEncrypted) return null;
    try {
      return JSON.parse(this.deps.stateCrypto.open(row.tokensEncrypted)) as LinkTokens;
    } catch {
      return null; // key rotated — the user re-connects
    }
  }

  /** A live access token, refreshing (and persisting the ROTATED refresh
   * token — Link invalidates the old one on every use) when near expiry. */
  async accessToken(userId: string): Promise<string | null> {
    const tokens = await this.openTokens(userId);
    if (!tokens || !this.deps.linkClient) return null;
    if (new Date(tokens.expiresAt).getTime() - this.now().getTime() > REFRESH_MARGIN_MS) {
      return tokens.accessToken;
    }
    try {
      const fresh = await this.deps.linkClient.refresh(tokens.refreshToken);
      await this.persistTokens(userId, fresh);
      return fresh.accessToken;
    } catch {
      // Refresh token dead (revoked, >1y, rotation raced): needs re-connect.
      await this.deps.db.linkAccount.upsert({
        where: { userId },
        create: { userId, status: "disconnected", tokensEncrypted: null },
        update: { status: "disconnected", tokensEncrypted: null },
      });
      return null;
    }
  }

  /**
   * One spend request per paid stop (verified: Link has no batch
   * approval). Returns each stop's approval URL for the client to walk
   * the user through; context strings must be ≥100 chars per Link.
   */
  async createSpendRequestsForStops(
    userId: string,
    args: {
      planId: string;
      itineraryId?: string;
      stops: {
        stopId: string;
        label: string;
        amountUsd: number;
        merchantName: string;
        merchantUrl: string;
      }[];
      test?: boolean;
    },
  ): Promise<{ stopId: string; spendRequestId: string; approvalUrl: string | null }[]> {
    if (!this.deps.linkClient || !this.deps.stateCrypto) throw new Error("link_not_configured");
    const token = await this.accessToken(userId);
    if (!token) throw new Error("link_not_connected");
    const out: { stopId: string; spendRequestId: string; approvalUrl: string | null }[] = [];
    for (const stop of args.stops) {
      const context =
        `ParkAgent parking plan ${args.planId}, stop "${stop.label}": paying ${stop.merchantName} ` +
        `$${stop.amountUsd.toFixed(2)} for parking. The customer reviewed this plan in the ParkAgent ` +
        `app and signed it off; this request covers exactly this stop.`;
      const created = await this.deps.linkClient.createSpendRequest(token, {
        amountUsd: stop.amountUsd,
        context,
        merchantName: stop.merchantName,
        merchantUrl: stop.merchantUrl,
        ...(args.test !== undefined ? { test: args.test } : this.testMode ? { test: true } : {}),
      });
      await this.deps.db.linkSpendRequest.create({
        data: {
          id: created.id,
          userId,
          planId: args.planId,
          ...(args.itineraryId ? { itineraryId: args.itineraryId } : {}),
          stopId: stop.stopId,
          amountUsd: stop.amountUsd,
          status: created.status,
          approvalUrl: created.approvalUrl,
          validUntil: created.validUntil ? new Date(created.validUntil) : null,
          merchantName: stop.merchantName,
          approvalExpiresAt: new Date(this.now().getTime() + LINK_APPROVAL_WINDOW_MS),
        },
      });
      out.push({
        stopId: stop.stopId,
        spendRequestId: created.id,
        approvalUrl: created.approvalUrl,
      });
    }
    return out;
  }

  /** Poll Link, mirror the status, and seal the one-time card on approval. */
  async syncSpendRequest(userId: string, id: string): Promise<{ status: string }> {
    if (!this.deps.linkClient || !this.deps.stateCrypto) throw new Error("link_not_configured");
    const row = await this.deps.db.linkSpendRequest.findUnique({ where: { id } });
    if (!row || row.userId !== userId) throw new Error("unknown_spend_request");
    // Our timeout sweep already closed it: a late approval can't revive a
    // request the plan has moved past.
    if (row.status === "expired") return { status: "expired" };
    const token = await this.accessToken(userId);
    if (!token) throw new Error("link_not_connected");
    const remote = await this.deps.linkClient.retrieveSpendRequest(token, id, {
      includeCard: true,
    });
    await this.deps.db.linkSpendRequest.update({
      where: { id },
      data: {
        status: remote.status,
        ...(remote.card
          ? {
              cardEncrypted: this.deps.stateCrypto.seal(JSON.stringify(remote.card)),
              validUntil: new Date(remote.card.validUntil),
            }
          : {}),
      },
    });
    return { status: remote.status };
  }
}

/** When a request's approval window closes (rows from before the column
 * existed fall back to creation + the window). */
function approvalDeadline(row: { approvalExpiresAt?: Date | null; createdAt: Date }): Date {
  return row.approvalExpiresAt ?? new Date(row.createdAt.getTime() + LINK_APPROVAL_WINDOW_MS);
}
