/**
 * City detection for onboarding: which city's meter system — and so which
 * provider — covers where the phone is right now. Reuses the zone candidate
 * fetcher with a metro-scale radius: the nearest zone's city wins, and a
 * fix nowhere near any metered zone answers city: null ("we're not there
 * yet"). Read-only — no rows are written.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";
import { providerForCity, providerStatusUsable } from "../providers/registry.js";

const querySchema = z.object({
  lat: z.coerce.number().gte(-90).lte(90),
  lng: z.coerce.number().gte(-180).lte(180),
});

/** Generous on purpose: onboarding often happens at home, km from a meter. */
const CITY_DETECT_RADIUS_M = 20_000;

export function registerCity(app: FastifyInstance, deps: AppDeps): void {
  app.get("/city", async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const user = req.authedUser!;

    const found = await deps.findCandidates({
      lat: parsed.data.lat,
      lng: parsed.data.lng,
      radiusM: CITY_DETECT_RADIUS_M,
    });
    const nearest = found[0];
    const providerInfo = providerForCity(nearest?.city ?? null);
    if (!nearest || !providerInfo) {
      return { city: nearest?.city ?? null, cityDisplayName: null, provider: null };
    }

    const account = await deps.db.providerAccount.findUnique({
      where: { userId_provider: { userId: user.id, provider: providerInfo.id } },
    });
    return {
      city: providerInfo.city,
      cityDisplayName: providerInfo.cityDisplayName,
      provider: {
        id: providerInfo.id,
        city: providerInfo.city,
        displayName: providerInfo.displayName,
        loginUrl: providerInfo.loginUrl,
        cookieDomains: providerInfo.cookieDomains,
        // Link-or-create: where sign-up starts and what the app may
        // prefill there (see registry.ts — text inputs only, ever).
        signup: providerInfo.signup,
        status: account?.status ?? "unlinked",
        linked: providerStatusUsable(account?.status),
      },
    };
  });
}
