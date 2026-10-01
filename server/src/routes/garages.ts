/**
 * Garage and lot footprints (FR-49): what's around a point, and one garage
 * by id. Read-only — nothing here decides, pays, or writes a row.
 *
 * GET /garages/near is also what the phone's footprint cache fills from
 * (ios Detection/FootprintIndex.swift), a 2 km cell at a time, so every
 * garage carries its outline and entrances and the caller may ask for more
 * than the default ten.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";
import type { GarageFootprint, LatLng } from "../services/garageLookup.js";
import { compareIds, describeFootprint, isGarageKind } from "../services/garageLookup.js";
import { makeRateLimiter } from "../services/rateLimit.js";

const DEFAULT_NEAR_RADIUS_M = 250;
/** A 2 km cell's center-to-corner distance (1,415 m) fits under it. */
export const GARAGE_NEAR_MAX_RADIUS_M = 1_500;
const DEFAULT_NEAR_LIMIT = 10;
/** Hard ceiling on what one call returns; `truncated` says when it was hit.
 * Room for a whole 2 km cell: the densest in the 2026-10-01 load holds 442
 * outlines, about 230 KB. */
export const GARAGE_NEAR_MAX_LIMIT = 1_000;

const nearQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius: z.coerce.number().positive().max(GARAGE_NEAR_MAX_RADIUS_M).default(DEFAULT_NEAR_RADIUS_M),
  limit: z.coerce.number().int().min(1).max(GARAGE_NEAR_MAX_LIMIT).default(DEFAULT_NEAR_LIMIT),
});

/** "<city>-<slug>-<hash>": lowercase letters, digits, and hyphens. (The
 * router itself answers 414 for a path parameter over 100 characters.) */
const GARAGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** What the license of each source asks us to say wherever its data shows. */
const ATTRIBUTIONS: Record<string, string> = {
  osm: "© OpenStreetMap contributors",
};

function attributionFor(garages: readonly GarageFootprint[]): string {
  const sources = [...new Set(garages.map((garage) => garage.source))];
  // An empty answer still names the default source, so a client can show
  // the line once and keep it.
  const lines = (sources.length > 0 ? sources : ["osm"]).flatMap((source) =>
    ATTRIBUTIONS[source] ? [ATTRIBUTIONS[source]] : [],
  );
  return lines.join("; ");
}

/** The garage as the API shows it. `holes` rides along only when there are some. */
function publicGarage(garage: GarageFootprint) {
  return {
    id: garage.id,
    city: garage.city,
    name: garage.name,
    operator: garage.operator,
    kind: garage.kind,
    fee: garage.fee,
    access: garage.access,
    capacity: garage.capacity,
    website: garage.website,
    polygon: garage.polygon,
    ...(garage.holes.length > 0 ? { holes: garage.holes } : {}),
    entrances: garage.entrances,
    source: garage.source,
    sourceVersion: garage.sourceVersion,
  };
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

export function registerGarages(app: FastifyInstance, deps: AppDeps): void {
  // A PostGIS read per call, like the map's curb layer: same limit.
  const limit = makeRateLimiter({ max: 60, windowMs: 60_000 });

  app.get("/garages/near", { preHandler: limit }, async (req, reply) => {
    if (!deps.garageFootprints) {
      return reply.code(501).send({ error: "garage_footprints_unavailable" });
    }
    const parsed = nearQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: z.treeifyError(parsed.error) });
    }
    const { lat, lng, radius, limit: max } = parsed.data;
    const point: LatLng = { lat, lng };
    const found = await deps.garageFootprints.near({ lat, lng, radiusM: radius, limit: max });
    // Street-side parking is a zone, never a footprint: a row of a kind
    // this build doesn't know is not shown, whatever put it there.
    const garages = found.garages
      .filter((garage) => isGarageKind(garage.kind))
      .map((garage) => {
        const measure = describeFootprint(point, garage);
        return {
          ...publicGarage(garage),
          containsPoint: measure.containsPoint,
          distanceM: roundTenth(measure.distanceM),
          nearestEntranceM:
            measure.nearestEntranceM === null ? null : roundTenth(measure.nearestEntranceM),
        };
      })
      .sort((a, b) => a.distanceM - b.distanceM || compareIds(a.id, b.id));
    return {
      radiusM: radius,
      limit: max,
      // Truncation would read as "nothing more is here", so say it.
      truncated: found.truncated,
      attribution: attributionFor(found.garages),
      garages,
    };
  });

  app.get("/garages/:id", { preHandler: limit }, async (req, reply) => {
    if (!deps.garageFootprints) {
      return reply.code(501).send({ error: "garage_footprints_unavailable" });
    }
    const { id } = req.params as { id: string };
    // An id that couldn't be one never reaches the database.
    if (!GARAGE_ID.test(id)) {
      return reply.code(404).send({ error: "garage_not_found" });
    }
    const garage = await deps.garageFootprints.byId(id);
    if (!garage || !isGarageKind(garage.kind)) {
      return reply.code(404).send({ error: "garage_not_found" });
    }
    return { garage: publicGarage(garage), attribution: attributionFor([garage]) };
  });
}
