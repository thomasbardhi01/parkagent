/**
 * Stripe Link wallet for agents (docs.stripe.com/agentic-commerce/link-cli).
 *
 * Verified against the docs, 2026-09-21:
 * - OAuth (hosted agent / confidential client): authorize at
 *   https://login.link.com/auth (PKCE S256 + state required; scopes
 *   "payment_methods.agentic userinfo:read"; `key` = Stripe publishable
 *   key), token exchange/refresh at https://login.link.com/auth/token,
 *   revoke at /auth/revoke. Access token lives 1 h; refresh token 1 year,
 *   ROTATED on every use — always persist the new one.
 * - Spend requests are ONE PER PURCHASE: one amount + one merchant each;
 *   there is no batch approval. A multi-stop plan = one request (and one
 *   customer approval) per paid stop. `context` must be ≥ 100 chars.
 * - The approved credential is a ONE-TIME-USE virtual card valid until
 *   `valid_until` — 12 hours from spend-request creation. It is not
 *   merchant-locked (works anywhere cards are accepted), so nothing
 *   blocks it at ParkNYC, Passport, or SpotHero card forms.
 * - Limits (per agent integration): $500/request, $500/day, 30 concurrent
 *   active, 10 concurrent approved, 50 creations/hour; approval window
 *   10 minutes.
 *
 * UNVERIFIED (needs the sandbox + registered client — listed in the PR):
 * the raw REST paths under api.link.com that `link-cli spend-request …`
 * wraps are not publicly documented; makeLinkHttpClient's spend-request
 * transport is a best-effort mirror of the CLI contract behind
 * LINK_API_BASE and must be confirmed with `--test` mode before real use.
 */

export interface LinkTokens {
  accessToken: string;
  refreshToken: string;
  /** ISO instant the access token dies (issued lifetime: 1 h). */
  expiresAt: string;
  scope: string;
}

export interface LinkOneTimeCard {
  brand: string;
  number: string;
  cvc: string;
  expMonth: number;
  expYear: number;
  /** ISO — 12 h from spend-request creation. */
  validUntil: string;
}

export type LinkSpendStatus =
  | "created"
  | "pending_approval"
  | "requires_action"
  | "approved"
  | "denied"
  | "expired"
  | "canceled"
  | "succeeded"
  | "failed";

export interface LinkSpendRequestState {
  id: string;
  status: LinkSpendStatus;
  amountUsd: number;
  approvalUrl: string | null;
  validUntil: string | null;
  /** Present only when retrieved with includeCard on an approved request. */
  card?: LinkOneTimeCard;
}

export interface CreateSpendRequestArgs {
  amountUsd: number;
  /** ≥100 chars; shown to the customer on the approval screen. */
  context: string;
  merchantName: string;
  merchantUrl: string;
  /** Test mode returns test credentials and never charges. */
  test?: boolean;
}

export interface LinkClient {
  authorizationUrl(args: { state: string; codeChallenge: string }): string;
  exchangeCode(args: { code: string; codeVerifier: string }): Promise<LinkTokens>;
  refresh(refreshToken: string): Promise<LinkTokens>;
  revoke(refreshToken: string): Promise<void>;
  createSpendRequest(token: string, args: CreateSpendRequestArgs): Promise<LinkSpendRequestState>;
  retrieveSpendRequest(
    token: string,
    id: string,
    options?: { includeCard?: boolean },
  ): Promise<LinkSpendRequestState>;
  cancelSpendRequest(token: string, id: string): Promise<void>;
}

export interface LinkConfig {
  clientId: string;
  clientSecret: string;
  publishableKey: string;
  redirectUri: string;
  /** login.link.com unless overridden for tests. */
  authBase?: string;
  /** api.link.com unless overridden; spend-request paths are UNVERIFIED. */
  apiBase?: string;
  testMode?: boolean;
}

export const LINK_SCOPES = "payment_methods.agentic userinfo:read";

interface HttpJson {
  (url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
}

export function makeLinkHttpClient(config: LinkConfig, http: HttpJson = fetch): LinkClient {
  const authBase = config.authBase ?? "https://login.link.com";
  const apiBase = config.apiBase ?? "https://api.link.com";

  async function tokenRequest(form: Record<string, string>): Promise<LinkTokens> {
    const res = await http(`${authBase}/auth/token`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.publishableKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...form,
      }).toString(),
    });
    if (!res.ok) throw new Error(`link token endpoint answered ${res.status}`);
    const body = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
    };
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: new Date(Date.now() + body.expires_in * 1000).toISOString(),
      scope: body.scope,
    };
  }

  function parseSpendRequest(raw: unknown): LinkSpendRequestState {
    const r = raw as Record<string, unknown>;
    const card = r["card"] as Record<string, unknown> | undefined;
    return {
      id: String(r["id"]),
      status: String(r["status"]) as LinkSpendStatus,
      amountUsd: Number(r["amount"] ?? 0) / 100,
      approvalUrl: typeof r["approval_url"] === "string" ? r["approval_url"] : null,
      validUntil:
        typeof card?.["valid_until"] === "string"
          ? card["valid_until"]
          : typeof r["valid_until"] === "string"
            ? (r["valid_until"] as string)
            : null,
      ...(card && typeof card["number"] === "string"
        ? {
            card: {
              brand: String(card["brand"] ?? "unknown"),
              number: String(card["number"]),
              cvc: String(card["cvc"] ?? ""),
              expMonth: Number(card["exp_month"] ?? 0),
              expYear: Number(card["exp_year"] ?? 0),
              validUntil: String(card["valid_until"] ?? ""),
            },
          }
        : {}),
    };
  }

  async function api(path: string, token: string, init?: { method?: string; body?: unknown }) {
    const res = await http(`${apiBase}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!res.ok) throw new Error(`link api ${path} answered ${res.status}`);
    return res.json();
  }

  return {
    authorizationUrl({ state, codeChallenge }) {
      const params = new URLSearchParams({
        key: config.publishableKey,
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: "code",
        scope: LINK_SCOPES,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });
      return `${authBase}/auth?${params.toString()}`;
    },
    exchangeCode: ({ code, codeVerifier }) =>
      tokenRequest({
        grant_type: "authorization_code",
        redirect_uri: config.redirectUri,
        code,
        code_verifier: codeVerifier,
      }),
    refresh: (refreshToken) => tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }),
    async revoke(refreshToken) {
      await http(`${authBase}/auth/revoke`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.publishableKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          token: refreshToken,
          token_type_hint: "refresh_token",
        }).toString(),
      });
    },
    // UNVERIFIED transport (see file header): mirrors `link-cli
    // spend-request create/retrieve/cancel`. Confirm paths in sandbox.
    async createSpendRequest(token, args) {
      const raw = await api("/v1/spend_requests", token, {
        method: "POST",
        body: {
          amount: Math.round(args.amountUsd * 100),
          currency: "usd",
          context: args.context,
          merchant_name: args.merchantName,
          merchant_url: args.merchantUrl,
          credential_type: "card",
          ...(args.test ?? config.testMode ? { test: true } : {}),
        },
      });
      return parseSpendRequest(raw);
    },
    async retrieveSpendRequest(token, id, options) {
      const suffix = options?.includeCard ? "?include=card" : "";
      return parseSpendRequest(await api(`/v1/spend_requests/${id}${suffix}`, token));
    },
    async cancelSpendRequest(token, id) {
      await api(`/v1/spend_requests/${id}/cancel`, token, { method: "POST" });
    },
  };
}
