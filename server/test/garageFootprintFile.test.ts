/**
 * FR-49 — what `pnpm -C server load:garages` will and won't put in the
 * garages table. The file comes from data/fetch_parking_footprints.py, but
 * the loader is the last check before the database: one city per file,
 * known kinds only (street-side parking is a zone, never a garage), and a
 * load that would empty most of a city is refused.
 */

import { describe, expect, test } from "vitest";

import { pair, square } from "./garageFixtures.js";
import {
  loadFootprintFile,
  readFootprintFile,
  shrinkProblem,
} from "../src/services/garage/footprintFile.js";

function feature(overrides: Record<string, unknown> = {}, geometry?: unknown) {
  return {
    type: "Feature",
    properties: {
      garage_id: "bos-fixture-deck-0a1b2c",
      city: "bos",
      name: "Fixture Deck",
      operator: null,
      kind: "multi_storey",
      fee: true,
      access: "customers",
      capacity: 420,
      website: "https://example.com/deck",
      entrances: { type: "MultiPoint", coordinates: [pair(30, 0)] },
      entrance_source: "osm",
      ...overrides,
    },
    geometry: geometry ?? { type: "Polygon", coordinates: [square(0, 0, 30)] },
  };
}

function collection(features: unknown[], metadata: Record<string, unknown> = {}) {
  return {
    type: "FeatureCollection",
    metadata: {
      city: "bos",
      built_at: "2026-10-01T01:00:00Z",
      source: "osm",
      source_version: "2026-09-30T12:00:00Z",
      ...metadata,
    },
    features,
  };
}

function problems(input: unknown): string[] {
  const result = readFootprintFile(input);
  return result.ok ? [] : result.problems;
}

describe("readFootprintFile", () => {
  test("a built file becomes rows, one per feature", () => {
    const lot = feature({
      garage_id: "bos-surface-3d4e5f",
      name: null,
      kind: "surface",
      fee: null,
      access: null,
      capacity: null,
      website: null,
      entrances: { type: "MultiPoint", coordinates: [] },
    });
    const result = readFootprintFile(collection([feature(), lot]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file).toMatchObject({
      city: "bos",
      source: "osm",
      sourceVersion: "2026-09-30T12:00:00Z",
    });
    expect(result.file.rows).toHaveLength(2);
    expect(result.file.rows[0]).toEqual({
      id: "bos-fixture-deck-0a1b2c",
      city: "bos",
      name: "Fixture Deck",
      operator: null,
      kind: "multi_storey",
      fee: true,
      access: "customers",
      capacity: 420,
      website: "https://example.com/deck",
      geomJson: JSON.stringify({ type: "Polygon", coordinates: [square(0, 0, 30)] }),
      entrancesJson: JSON.stringify({ type: "MultiPoint", coordinates: [pair(30, 0)] }),
    });
    expect(result.file.rows[1]).toMatchObject({ id: "bos-surface-3d4e5f", fee: null });
    expect(JSON.parse(result.file.rows[1]!.entrancesJson)).toEqual({
      type: "MultiPoint",
      coordinates: [],
    });
  });

  test("street-side parking is refused: those are zones", () => {
    for (const kind of ["street_side", "lane", "multi-storey", "", null]) {
      const found = problems(collection([feature({ kind })]));
      expect(found.join("\n"), String(kind)).toMatch(/kind/);
    }
  });

  test("a file spanning cities is refused, and so is a feature outside the file's city", () => {
    const other = feature({ garage_id: "nyc-other-9a8b7c", city: "nyc" });
    expect(problems(collection([feature(), other])).join("\n")).toMatch(/city/);
    // The id's prefix is the city too.
    const mislabeled = feature({ garage_id: "nyc-fixture-deck-0a1b2c" });
    expect(problems(collection([mislabeled])).join("\n")).toMatch(/garage_id/);
  });

  test("a duplicate id is refused rather than silently merged", () => {
    expect(problems(collection([feature(), feature()])).join("\n")).toMatch(/duplicate/);
  });

  test("an id that isn't <city>-<slug>-<hash6> is refused", () => {
    for (const id of ["bos-deck", "bos-Deck-0a1b2c", "bos--0a1b2c", "bos-deck-0a1b2", "", 7]) {
      expect(problems(collection([feature({ garage_id: id })])).join("\n"), String(id)).toMatch(
        /garage_id/,
      );
    }
    // A hash widened past six to break a collision is still an id.
    expect(problems(collection([feature({ garage_id: "bos-deck-0a1b2c3d" })]))).toEqual([]);
  });

  test("a website that isn't http(s) is refused: the app may open it", () => {
    for (const website of ["javascript:alert(1)", "ftp://example.com", "example.com", "http://"]) {
      expect(problems(collection([feature({ website })])).join("\n"), website).toMatch(/website/);
    }
    expect(problems(collection([feature({ website: "http://example.com/a?b=c" })]))).toEqual([]);
  });

  test("an outline must be a closed polygon of real coordinates", () => {
    const open = [pair(0, 0), pair(10, 0), pair(10, 10), pair(0, 10)];
    const cases: [string, unknown][] = [
      ["open ring", { type: "Polygon", coordinates: [open] }],
      ["two points", { type: "Polygon", coordinates: [[pair(0, 0), pair(0, 0)]] }],
      ["no rings", { type: "Polygon", coordinates: [] }],
      ["multipolygon", { type: "MultiPolygon", coordinates: [[square(0, 0, 30)]] }],
      ["a point", { type: "Point", coordinates: pair(0, 0) }],
      [
        "off the earth",
        {
          type: "Polygon",
          coordinates: [
            [
              [-71, 95],
              [-71, 96],
              [-70, 96],
              [-71, 95],
            ],
          ],
        },
      ],
      ["not numbers", { type: "Polygon", coordinates: [[["a", "b"]]] }],
      ["missing", null],
    ];
    for (const [label, geometry] of cases) {
      expect(problems(collection([{ ...feature(), geometry }])).join("\n"), label).toMatch(
        /geometry/,
      );
    }
    // A hole is fine.
    const holed = { type: "Polygon", coordinates: [square(0, 0, 30), square(0, 0, 5)] };
    expect(problems(collection([feature({}, holed)]))).toEqual([]);
  });

  test("entrances must be a MultiPoint of real coordinates", () => {
    for (const entrances of [
      null,
      { type: "Point", coordinates: pair(0, 0) },
      { type: "MultiPoint", coordinates: [[200, 0]] },
      { type: "MultiPoint", coordinates: "nope" },
    ]) {
      expect(problems(collection([feature({ entrances })])).join("\n")).toMatch(/entrances/);
    }
  });

  test("fields of the wrong type are refused, not coerced", () => {
    expect(problems(collection([feature({ fee: "yes" })])).join("\n")).toMatch(/fee/);
    expect(problems(collection([feature({ capacity: "120" })])).join("\n")).toMatch(/capacity/);
    expect(problems(collection([feature({ capacity: -1 })])).join("\n")).toMatch(/capacity/);
    expect(problems(collection([feature({ capacity: 12.5 })])).join("\n")).toMatch(/capacity/);
    expect(problems(collection([feature({ name: 7 })])).join("\n")).toMatch(/name/);
    expect(problems(collection([feature({ name: "x".repeat(400) })])).join("\n")).toMatch(/name/);
  });

  test("an empty file, or one that doesn't say where it came from, is refused", () => {
    expect(problems(collection([])).join("\n")).toMatch(/no features/);
    expect(problems(collection([feature()], { source: "" })).join("\n")).toMatch(/source/);
    expect(problems(collection([feature()], { source_version: undefined })).join("\n")).toMatch(
      /source_version/,
    );
    expect(problems(collection([feature()], { city: "Bos" })).join("\n")).toMatch(/city/);
    expect(problems({ type: "FeatureCollection" }).join("\n")).toMatch(/metadata/);
    expect(problems("not a collection").length).toBeGreaterThan(0);
  });

  test("a bad file lists a few problems, not thousands", () => {
    const bad = Array.from({ length: 500 }, (_, i) =>
      feature({ garage_id: `bos-deck-${i.toString(16).padStart(6, "0")}`, kind: "street_side" }),
    );
    const found = problems(collection(bad));
    expect(found.length).toBeGreaterThan(0);
    expect(found.length).toBeLessThanOrEqual(11);
    expect(found.at(-1)).toMatch(/more/);
  });
});

describe("shrinkProblem", () => {
  test("a first load, a steady load, and a modest drop all pass", () => {
    expect(shrinkProblem(0, 5_000)).toBeNull();
    expect(shrinkProblem(5_000, 5_100)).toBeNull();
    expect(shrinkProblem(5_000, 2_500)).toBeNull();
  });

  test("a load under half the city's rows is refused: a cut-short fetch must not empty the table", () => {
    expect(shrinkProblem(5_000, 2_499)).toMatch(/--allow-shrink/);
    expect(shrinkProblem(5_000, 1)).toMatch(/5000/);
  });
});

/** A scripted pg client: records every statement, answers the counts. */
function fakeClient(script: {
  existing?: number;
  landed?: number;
  invalid?: number;
  stale?: number;
}) {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    statements: () => calls.map((c) => c.text.trim().split(/\s+/).slice(0, 3).join(" ")),
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (/NOT ST_IsValid/.test(text))
        return { rows: [{ count: String(script.invalid ?? 0) }], rowCount: 1 };
      if (/id = ANY\(\$3::text\[\]\)/.test(text) && /^SELECT/.test(text.trim())) {
        const ids = values[2] as string[];
        return { rows: [{ count: String(script.landed ?? ids.length) }], rowCount: 1 };
      }
      if (/^SELECT COUNT/.test(text.trim())) {
        return { rows: [{ count: String(script.existing ?? 0) }], rowCount: 1 };
      }
      if (/^DELETE/.test(text.trim())) return { rows: [], rowCount: script.stale ?? 0 };
      return { rows: [], rowCount: 0 };
    },
  };
}

function builtFile(count: number) {
  const features = Array.from({ length: count }, (_, i) =>
    feature({ garage_id: `bos-deck-${i.toString(16).padStart(6, "0")}` }),
  );
  const result = readFootprintFile(collection(features));
  if (!result.ok) throw new Error(result.problems.join("\n"));
  return result.file;
}

describe("loadFootprintFile", () => {
  test("one transaction: upsert, check, mirror, check, commit", async () => {
    const client = fakeClient({ existing: 2, stale: 1 });
    const result = await loadFootprintFile(client, builtFile(3));
    expect(result).toEqual({ ok: true, upserted: 3, deleted: 1 });
    expect(client.statements()).toEqual([
      "BEGIN",
      "SELECT COUNT(*) AS",
      "INSERT INTO garages",
      "SELECT COUNT(*) AS",
      "DELETE FROM garages",
      "SELECT COUNT(*) AS",
      "COMMIT",
    ]);
  });

  test("every statement that reads or deletes is scoped to the file's city AND source", async () => {
    const client = fakeClient({});
    const file = builtFile(2);
    await loadFootprintFile(client, file);
    const ids = file.rows.map((row) => row.id);
    const scoped = client.calls.filter((c) => /^(SELECT|DELETE)/.test(c.text.trim()));
    expect(scoped).toHaveLength(4);
    for (const call of scoped) {
      expect(call.text).toMatch(/WHERE city = \$1 AND source = \$2/);
      expect(call.values.slice(0, 2)).toEqual(["bos", "osm"]);
    }
    const del = client.calls.find((c) => /^DELETE/.test(c.text.trim()))!;
    // Only rows the file no longer carries, and only this city's and source's.
    expect(del.text).toMatch(/AND NOT \(id = ANY\(\$3::text\[\]\)\)/);
    expect(del.values).toEqual(["bos", "osm", ids]);
    // The upsert can't take over a row another city or source holds.
    const upsert = client.calls.find((c) => /^INSERT/.test(c.text.trim()))!;
    expect(upsert.text).toMatch(
      /WHERE garages\.city = EXCLUDED\.city AND garages\.source = EXCLUDED\.source/,
    );
    expect(upsert.text).not.toMatch(/\bcity = EXCLUDED\.city,/);
    expect(upsert.values).toHaveLength(2 * 13);
    expect(upsert.values.slice(0, 2)).toEqual([ids[0], "bos"]);
    expect(upsert.values.slice(11, 13)).toEqual(["osm", "2026-09-30T12:00:00Z"]);
  });

  test("rows go in 400 at a time", async () => {
    const client = fakeClient({});
    await loadFootprintFile(client, builtFile(950));
    const upserts = client.calls.filter((c) => /^INSERT/.test(c.text.trim()));
    expect(upserts.map((c) => c.values.length / 13)).toEqual([400, 400, 150]);
  });

  test("a file that would empty most of the city is refused before anything is written", async () => {
    const client = fakeClient({ existing: 5_000 });
    const result = await loadFootprintFile(client, builtFile(3));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toMatch(/--allow-shrink/);
    expect(client.statements()).toEqual(["BEGIN", "SELECT COUNT(*) AS", "ROLLBACK"]);

    // The operator can say the drop is real.
    const allowed = fakeClient({ existing: 5_000, stale: 4_997 });
    expect(await loadFootprintFile(allowed, builtFile(3), { allowShrink: true })).toEqual({
      ok: true,
      upserted: 3,
      deleted: 4_997,
    });
  });

  test("an id another city or source already holds rolls the whole load back", async () => {
    const client = fakeClient({ landed: 2 });
    await expect(loadFootprintFile(client, builtFile(3))).rejects.toThrow(
      /1 ids in the file already belong to another city or source/,
    );
    expect(client.statements().at(-1)).toBe("ROLLBACK");
    expect(client.statements()).not.toContain("DELETE FROM garages");
    expect(client.statements()).not.toContain("COMMIT");
  });

  test("an outline PostGIS calls invalid rolls the whole load back", async () => {
    const client = fakeClient({ invalid: 2 });
    await expect(loadFootprintFile(client, builtFile(3))).rejects.toThrow(
      /2 outlines are not valid/,
    );
    expect(client.statements().at(-1)).toBe("ROLLBACK");
    expect(client.statements()).not.toContain("COMMIT");
  });
});
