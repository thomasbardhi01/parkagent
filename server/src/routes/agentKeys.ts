/**
 * A person's keys for external agents, and their consent (WS-4). Signed
 * in as themselves (a session, never an agent key): an agent can't mint,
 * list or revoke keys, and can't turn consent on for itself.
 *
 *   POST   /me/agent-keys      {label, scopes} → the key, shown once
 *   GET    /me/agent-keys      the keys, by prefix (never the key)
 *   DELETE /me/agent-keys/:id  revoke; the row stays for the ledger
 *   PATCH  /me/settings        {agentsMayAct}: whether agents may act
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";
import type { AgentKeyRow } from "../db.js";
import { generateAgentKey, hashApiKey } from "../services/apiKeys.js";

const createSchema = z.strictObject({
  label: z.string().trim().min(1).max(60),
  scopes: z
    .array(z.enum(["read", "confirm"]))
    .min(1)
    .refine((s) => new Set(s).size === s.length, "scopes repeat"),
});

const settingsSchema = z.strictObject({ agentsMayAct: z.boolean() });

/** At most this many live keys a person: each is a separate agent. */
const MAX_LIVE_KEYS = 10;

function view(key: AgentKeyRow) {
  return {
    id: key.id,
    prefix: key.prefix,
    label: key.label,
    scopes: key.scopes,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
  };
}

export function registerAgentKeys(app: FastifyInstance, deps: AppDeps): void {
  const now = () => deps.now?.() ?? new Date();

  app.post("/me/agent-keys", async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    const userId = req.authedUser!.id;
    const live = (await deps.db.agentKey.findMany({ where: { userId } })).filter(
      (k) => k.revokedAt === null,
    );
    if (live.length >= MAX_LIVE_KEYS) return reply.code(409).send({ error: "too_many_keys" });
    const { key, prefix } = generateAgentKey();
    const row = await deps.db.agentKey.create({
      data: {
        userId,
        prefix,
        hash: hashApiKey(deps.apiKeyPepper, key),
        scopes: parsed.data.scopes,
        label: parsed.data.label,
      },
    });
    await deps.db.decision.create({
      data: {
        kind: "agent_key",
        inputs: { label: row.label, scopes: row.scopes },
        rule: "created",
        outcome: { agentKeyId: row.id, prefix: row.prefix },
        userId,
      },
    });
    // The one time the key is shown: only its hash is kept.
    return reply.code(201).send({ key, ...view(row) });
  });

  app.get("/me/agent-keys", async (req) => {
    const keys = await deps.db.agentKey.findMany({ where: { userId: req.authedUser!.id } });
    return {
      keys: keys.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map(view),
    };
  });

  app.delete("/me/agent-keys/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = req.authedUser!.id;
    const key = await deps.db.agentKey.findUnique({ where: { id } });
    if (!key || key.userId !== userId)
      return reply.code(404).send({ error: "agent_key_not_found" });
    if (key.revokedAt !== null) return { ...view(key) };
    const row = await deps.db.agentKey.update({ where: { id }, data: { revokedAt: now() } });
    await deps.db.decision.create({
      data: {
        kind: "agent_key",
        inputs: { agentKeyId: id },
        rule: "revoked",
        outcome: { prefix: row.prefix },
        userId,
      },
    });
    return view(row);
  });

  app.patch("/me/settings", async (req, reply) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    const userId = req.authedUser!.id;
    await deps.db.user.update({
      where: { id: userId },
      data: { agentsMayAct: parsed.data.agentsMayAct },
      select: { id: true },
    });
    await deps.db.decision.create({
      data: {
        kind: "agent_consent",
        inputs: { agentsMayAct: parsed.data.agentsMayAct },
        rule: parsed.data.agentsMayAct ? "agents_may_act" : "agents_may_not_act",
        outcome: { saved: true },
        userId,
      },
    });
    return { agentsMayAct: parsed.data.agentsMayAct };
  });
}
