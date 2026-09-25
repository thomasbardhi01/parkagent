/**
 * The signed-in user's own surface: profile (GET/PATCH /me), account
 * deletion (DELETE /me), and vehicles CRUD. How the user pays lives in the
 * Wallet now (routes/wallet.ts); GET /me still reports the active source
 * so the Account sheet and the Wallet read the same fact.
 *
 * DELETE /me tombstones the account: every device signs out, provider
 * accounts are unlinked, personal data goes, and the users row stays so the
 * decisions ledger keeps a valid id. The full contract lives with the
 * teardown itself, services/accountDeletion.ts (the FR throwaway purge
 * runs the same one).
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";
import { deleteAccount } from "../services/accountDeletion.js";
import { publicUser } from "../services/authService.js";
import { normalizeSource } from "../services/wallet/summary.js";

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
    return {
      user: publicUser(row),
      paymentSource: normalizeSource(row.paymentSource),
      issuingLive,
    };
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
    // The teardown is shared with the FR throwaway purge; see
    // services/accountDeletion.ts for what goes and what stays.
    await deleteAccount(
      {
        db: deps.db,
        stripe: deps.stripe,
        linkWallet: deps.linkWallet,
        appleTokens: deps.appleTokens,
        stateCrypto: deps.stateCrypto,
        now,
      },
      req.authedUser!.id,
    );
    return { ok: true, deleted: true };
  });

  // ----------------------------------------------------------------- Vehicles

  const vehicleBody = (v: { id: string; plate: string; state: string; label: string | null }) => ({
    id: v.id,
    plate: v.plate,
    state: v.state,
    label: v.label,
  });

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
}
