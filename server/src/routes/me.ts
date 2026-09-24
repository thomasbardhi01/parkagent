/**
 * The signed-in user's own surface: profile (GET/PATCH /me), account
 * deletion (DELETE /me), vehicles CRUD, and the payment source —
 * "provider_card" (the card already on the user's ParkNYC / ParkBoston
 * account; onboarding default, skips card setup and funding) or
 * "issuing_card" (the ParkAgent Issuing card, selectable only when the
 * ISSUING_LIVE env flag is on). The daily and session caps apply to every
 * source — the choice moves where the charge lands, never what is allowed.
 *
 * DELETE /me contract (documented here on purpose): refresh tokens are
 * deleted (every device signs out), provider accounts are unlinked and
 * their sealed cookie states erased, any Issuing card is frozen (never
 * canceled — its ledger must keep resolving), vehicles, device tokens and
 * conversations are deleted, and the users row is TOMBSTONED — identity
 * fields scrubbed, deleted_at stamped, row kept — so the decisions ledger
 * (a non-negotiable) keeps a valid user id without keeping the person.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";
import { publicUser } from "../services/authService.js";

const putSchema = z.object({
  paymentSource: z.enum(["provider_card", "issuing_card"]),
});

const patchMeSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  // E.164-ish; loose on purpose. Never verified yet (no SMS flow), so
  // changing it clears phone_verified.
  phone: z
    .string()
    .regex(/^\+?[0-9 ()-]{7,20}$/)
    .nullable()
    .optional(),
});

const vehicleSchema = z.object({
  plate: z.string().min(2).max(8),
  state: z.string().length(2),
  label: z.string().max(40).nullable().optional(),
});

const vehiclePatchSchema = vehicleSchema.partial();

const normalizePlate = (plate: string): string => plate.trim().toUpperCase();

export function registerMe(app: FastifyInstance, deps: AppDeps): void {
  const issuingLive = deps.issuingLive === true;
  const now = () => deps.now?.() ?? new Date();

  const profileSelect = {
    id: true,
    name: true,
    email: true,
    emailVerified: true,
    phone: true,
    phoneVerified: true,
    appleSub: true,
    googleSub: true,
    paymentSource: true,
    createdAt: true,
  } as const;

  app.get("/me", async (req, reply) => {
    const row = await deps.db.user.findUnique({
      where: { id: req.authedUser!.id },
      select: profileSelect,
    });
    if (!row) return reply.code(401).send({ error: "unauthorized" });
    return { user: publicUser(row), paymentSource: row.paymentSource, issuingLive };
  });

  app.patch("/me", async (req, reply) => {
    const parsed = patchMeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    const data: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name.trim();
    if (parsed.data.phone !== undefined) {
      data.phone = parsed.data.phone;
      data.phoneVerified = false;
    }
    const row = await deps.db.user.update({
      where: { id: req.authedUser!.id },
      data,
      select: profileSelect,
    });
    return { user: publicUser(row) };
  });

  app.delete("/me", async (req) => {
    const user = req.authedUser!;
    const db = deps.db;

    // 1. Sessions out everywhere: refresh tokens and push channels gone.
    await db.refreshToken.deleteMany({ where: { userId: user.id } });
    await db.deviceToken.deleteMany({ where: { userId: user.id } });

    // 2. Provider accounts: unlink and erase the sealed cookie states.
    const accounts = await db.providerAccount.findMany({ where: { userId: user.id } });
    await db.providerAccount.updateMany({
      where: { userId: user.id },
      data: {
        status: "unlinked",
        stateEncrypted: null,
        cardAdded: false,
        cardBrand: null,
        cardLast4: null,
      },
    });

    // 3. Freeze (never cancel) any issued card — its authorizations must
    //    keep resolving against a live Stripe object.
    let cardFrozen = false;
    const holder = await db.issuingCardholder.findUnique({
      where: { userId: user.id },
      include: { cards: true },
    });
    for (const card of holder?.cards ?? []) {
      if (card.status === "active" && deps.stripe) {
        const status = await deps.stripe.setCardStatus(card.stripeCardId, "inactive");
        await db.issuingCard.update({ where: { stripeCardId: card.stripeCardId }, data: { status } });
        cardFrozen = true;
      }
    }

    // 4. Personal data: vehicles (sessions detach first — they are the
    //    money audit and stay), and assistant conversations.
    await db.session.updateMany({ where: { userId: user.id }, data: { vehicleId: null } });
    await db.vehicle.deleteMany({ where: { userId: user.id } });
    await db.conversation.deleteMany({ where: { userId: user.id } });

    // 5. Tombstone the users row: the decisions ledger keeps its user id,
    //    the person's identity is gone, and no credential works again.
    await db.user.update({
      where: { id: user.id },
      data: {
        name: "Deleted account",
        email: null,
        emailVerified: false,
        phone: null,
        phoneVerified: false,
        appleSub: null,
        googleSub: null,
        apiKey: null,
        apiKeyHash: null,
        apiKeyPrefix: null,
        deletedAt: now(),
      },
    });

    await db.decision.create({
      data: {
        kind: "account_delete",
        inputs: { providersUnlinked: accounts.map((a) => a.provider) },
        rule: "deleted",
        outcome: { ok: true, cardFrozen },
        userId: user.id,
      },
    });
    return { ok: true, deleted: true };
  });

  // ----------------------------------------------------------------- Vehicles

  const vehicleBody = (v: {
    id: string;
    plate: string;
    state: string;
    label: string | null;
  }) => ({ id: v.id, plate: v.plate, state: v.state, label: v.label });

  app.get("/me/vehicles", async (req) => {
    const rows = await deps.db.vehicle.findMany({
      where: { userId: req.authedUser!.id },
      orderBy: { createdAt: "asc" },
    });
    return { vehicles: rows.map(vehicleBody) };
  });

  app.post("/me/vehicles", async (req, reply) => {
    const parsed = vehicleSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    try {
      const row = await deps.db.vehicle.create({
        data: {
          userId: req.authedUser!.id,
          plate: normalizePlate(parsed.data.plate),
          state: parsed.data.state.toUpperCase(),
          label: parsed.data.label ?? null,
        },
      });
      return { vehicle: vehicleBody(row) };
    } catch (err) {
      // vehicles are unique by (plate, state) across users.
      if ((err as { code?: string }).code === "P2002") {
        return reply.code(409).send({ error: "plate_taken" });
      }
      throw err;
    }
  });

  app.patch("/me/vehicles/:id", async (req, reply) => {
    const parsed = vehiclePatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    const { id } = req.params as { id: string };
    const existing = await deps.db.vehicle.findUnique({ where: { id } });
    if (!existing || existing.userId !== req.authedUser!.id) {
      return reply.code(404).send({ error: "vehicle_not_found" });
    }
    try {
      const row = await deps.db.vehicle.update({
        where: { id },
        data: {
          ...(parsed.data.plate !== undefined ? { plate: normalizePlate(parsed.data.plate) } : {}),
          ...(parsed.data.state !== undefined ? { state: parsed.data.state.toUpperCase() } : {}),
          ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}),
        },
      });
      return { vehicle: vehicleBody(row) };
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") {
        return reply.code(409).send({ error: "plate_taken" });
      }
      throw err;
    }
  });

  app.delete("/me/vehicles/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await deps.db.vehicle.findUnique({ where: { id } });
    if (!existing || existing.userId !== req.authedUser!.id) {
      return reply.code(404).send({ error: "vehicle_not_found" });
    }
    // Sessions keep their history: detach this vehicle's, then delete it.
    await deps.db.session.updateMany({ where: { vehicleId: id }, data: { vehicleId: null } });
    await deps.db.vehicle.delete({ where: { id } });
    return { ok: true };
  });

  app.get("/me/payment-source", async (req) => {
    const user = req.authedUser!;
    const row = await deps.db.user.findUnique({
      where: { id: user.id },
      select: { paymentSource: true },
    });
    return { paymentSource: row?.paymentSource ?? "provider_card", issuingLive };
  });

  app.put("/me/payment-source", async (req, reply) => {
    const parsed = putSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const user = req.authedUser!;
    const wanted = parsed.data.paymentSource;

    // The Issuing card isn't live yet: the app shows it as "coming soon",
    // and the server refuses to let it become what pays.
    if (wanted === "issuing_card" && !issuingLive) {
      const decision = await deps.db.decision.create({
        data: {
          kind: "payment_source",
          inputs: { paymentSource: wanted, issuingLive },
          rule: "issuing_not_live",
          outcome: { allowed: false },
          userId: user.id,
        },
      });
      return reply.code(409).send({ error: "issuing_not_live", decisionId: decision.id });
    }

    const updated = await deps.db.user.update({
      where: { id: user.id },
      data: { paymentSource: wanted },
      select: { paymentSource: true },
    });
    await deps.db.decision.create({
      data: {
        kind: "payment_source",
        inputs: { paymentSource: wanted, issuingLive },
        rule: "set",
        outcome: { allowed: true, paymentSource: updated.paymentSource },
        userId: user.id,
      },
    });
    return { paymentSource: updated.paymentSource, issuingLive };
  });
}
