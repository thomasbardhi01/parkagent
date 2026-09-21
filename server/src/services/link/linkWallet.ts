/**
 * Link wallet orchestration: OAuth connect state, sealed token storage
 * (same AES-256-GCM StateCrypto as provider cookies — tokens never leave
 * the server unsealed), per-stop spend requests on plan confirmation, and
 * the one-time-card lifecycle with the Issuing-card expiry fallback.
 */

import { createHash, randomBytes } from "node:crypto";

import type { AppDb } from "../../db.js";
import type { StateCrypto } from "../crypto.js";
import type { LinkClient, LinkOneTimeCard, LinkTokens } from "./linkClient.js";

export interface LinkWalletDeps {
  db: AppDb;
  stateCrypto?: StateCrypto | undefined;
  linkClient?: LinkClient | undefined;
  now?: (() => Date) | undefined;
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
    return { userId: pending.userId };
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
      update: { status: "disconnected", tokensEncrypted: null },
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
      stops: { stopId: string; label: string; amountUsd: number; merchantName: string; merchantUrl: string }[];
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
        ...(args.test !== undefined ? { test: args.test } : {}),
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
        },
      });
      out.push({ stopId: stop.stopId, spendRequestId: created.id, approvalUrl: created.approvalUrl });
    }
    return out;
  }

  /** Poll Link, mirror the status, and seal the one-time card on approval. */
  async syncSpendRequest(userId: string, id: string): Promise<{ status: string }> {
    if (!this.deps.linkClient || !this.deps.stateCrypto) throw new Error("link_not_configured");
    const row = await this.deps.db.linkSpendRequest.findUnique({ where: { id } });
    if (!row || row.userId !== userId) throw new Error("unknown_spend_request");
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

  /**
   * The stop's one-time card if it is approved, unexpired, and unused —
   * else null and the caller falls back to the Issuing card (and says so).
   */
  async usableCardForStop(
    userId: string,
    stopId: string,
  ): Promise<{ spendRequestId: string; card: LinkOneTimeCard } | null> {
    if (!this.deps.stateCrypto) return null;
    const rows = await this.deps.db.linkSpendRequest.findMany({ where: { userId } });
    const row = rows.find((r) => r.stopId === stopId && r.status === "approved");
    if (!row?.cardEncrypted || row.cardUsedAt !== null) return null;
    if (row.validUntil !== null && row.validUntil.getTime() <= this.now().getTime()) return null;
    try {
      const card = JSON.parse(this.deps.stateCrypto.open(row.cardEncrypted)) as LinkOneTimeCard;
      return { spendRequestId: row.id, card };
    } catch {
      return null;
    }
  }

  /** A virtual card is single-use — record the use so nothing retries it. */
  async markCardUsed(id: string): Promise<void> {
    await this.deps.db.linkSpendRequest.update({
      where: { id },
      data: { cardUsedAt: this.now() },
    });
  }
}
