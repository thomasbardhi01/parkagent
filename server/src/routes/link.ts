/**
 * Link wallet for agents: connect (OAuth against login.link.com),
 * status, disconnect, spend-request sync (the app polls after sending the
 * user to a Link approval URL), and the one-time card reveal for paying
 * an approved garage at the garage's own checkout.
 *
 * /link/callback is PUBLIC (the browser redirect carries no api key);
 * the CSRF `state` minted at /link/connect is what binds it to a user.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";
import { makeRateLimiter } from "../services/rateLimit.js";

const callbackSchema = z.object({
  state: z.string().min(1).max(200),
  code: z.string().min(1).max(500),
});

export function registerLink(app: FastifyInstance, deps: AppDeps): void {
  const limit = makeRateLimiter({ max: 30, windowMs: 60_000 });

  app.get("/link/status", { preHandler: limit }, async (req, reply) => {
    if (!deps.linkWallet) return reply.code(503).send({ error: "link_not_configured" });
    const user = req.authedUser!;
    const status = await deps.linkWallet.status(user.id);
    return { configured: deps.linkWallet.configured, ...status };
  });

  app.post("/link/connect", { preHandler: limit }, async (req, reply) => {
    if (!deps.linkWallet?.configured) {
      return reply.code(503).send({ error: "link_not_configured" });
    }
    const user = req.authedUser!;
    const { url } = deps.linkWallet.startConnect(user.id);
    await deps.db.decision.create({
      data: {
        kind: "link_wallet",
        inputs: {},
        rule: "connect_started",
        outcome: {},
        userId: user.id,
      },
    });
    return { url };
  });

  // Public: see file header. Answers a tiny HTML page that bounces back
  // into the app.
  app.get("/link/callback", async (req, reply) => {
    if (!deps.linkWallet?.configured) {
      return reply.code(503).send({ error: "link_not_configured" });
    }
    const parsed = callbackSchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_callback" });
    }
    try {
      const { userId } = await deps.linkWallet.handleCallback(parsed.data.state, parsed.data.code);
      await deps.db.decision.create({
        data: {
          kind: "link_wallet",
          inputs: {},
          rule: "connected",
          outcome: {},
          userId,
        },
      });
      return reply
        .header("content-type", "text/html; charset=utf-8")
        .send(
          `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">` +
            `<body style="font-family:-apple-system,sans-serif;padding:2rem;text-align:center">` +
            `<h2>Link wallet connected</h2><p>You can return to ParkAgent.</p>` +
            `<p><a href="parkagent://link/connected">Open ParkAgent</a></p></body>`,
        );
    } catch {
      // Stale/forged state or a failed exchange — never echo details.
      return reply.code(400).send({ error: "link_connect_failed" });
    }
  });

  app.post("/link/disconnect", { preHandler: limit }, async (req, reply) => {
    if (!deps.linkWallet) return reply.code(503).send({ error: "link_not_configured" });
    const user = req.authedUser!;
    await deps.linkWallet.disconnect(user.id);
    await deps.db.decision.create({
      data: {
        kind: "link_wallet",
        inputs: {},
        rule: "disconnected",
        outcome: {},
        userId: user.id,
      },
    });
    return { ok: true };
  });

  // The app polls this after opening an approval URL; on approval the
  // wallet seals the one-time card server-side.
  app.post("/link/spend-requests/:id/sync", { preHandler: limit }, async (req, reply) => {
    if (!deps.linkWallet?.configured) {
      return reply.code(503).send({ error: "link_not_configured" });
    }
    const user = req.authedUser!;
    const { id } = req.params as { id: string };
    try {
      const { status } = await deps.linkWallet.syncSpendRequest(user.id, id);
      return { id, status };
    } catch (err) {
      const message = err instanceof Error ? err.message : "sync_failed";
      if (message === "unknown_spend_request") {
        return reply.code(404).send({ error: message });
      }
      return reply.code(409).send({ error: message });
    }
  });

  // The approved one-time card, for the user to pay the garage's own
  // checkout with (we never automate that checkout, so the card has to
  // reach the person at it). The app asks for Face ID first and hides the
  // details after 30 seconds. Only the owner's approved, unexpired, unused
  // card; never cached, never logged; every reveal is a decisions row.
  const limitReveal = makeRateLimiter({ max: 10, windowMs: 60_000 });
  app.post("/link/spend-requests/:id/card", { preHandler: limitReveal }, async (req, reply) => {
    if (!deps.linkWallet?.configured) {
      return reply.code(503).send({ error: "link_not_configured" });
    }
    const user = req.authedUser!;
    const { id } = req.params as { id: string };
    try {
      const card = await deps.linkWallet.revealCard(user.id, id);
      await deps.db.decision.create({
        data: {
          kind: "link_card_reveal",
          inputs: { spendRequestId: id },
          rule: "reveal_ok",
          outcome: { ok: true, validUntil: card.validUntil },
          userId: user.id,
        },
      });
      return reply.header("cache-control", "no-store").send({
        spendRequestId: id,
        brand: card.brand,
        number: card.number,
        cvc: card.cvc,
        expMonth: card.expMonth,
        expYear: card.expYear,
        validUntil: card.validUntil,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "reveal_failed";
      await deps.db.decision.create({
        data: {
          kind: "link_card_reveal",
          inputs: { spendRequestId: id },
          rule: message,
          outcome: { ok: false },
          userId: user.id,
        },
      });
      if (message === "unknown_spend_request") return reply.code(404).send({ error: message });
      return reply.code(409).send({ error: message });
    }
  });
}
