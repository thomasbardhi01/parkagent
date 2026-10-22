/**
 * Tracing off (G): with neither OTEL_EXPORTER_OTLP_ENDPOINT nor
 * OTEL_CONSOLE, no SDK starts and no exporter is built, and a decision's
 * trace_id is still the caller's traceparent (D's behavior) or null —
 * never an id made up without the SDK. With an endpoint, exactly one OTLP
 * exporter is built. (Its own file: the SDK, once started, is global.)
 */

import { expect, test, vi } from "vitest";

import { SHUTDOWN_FLUSH_MS, startTelemetry } from "../src/services/telemetry.js";
import { API_KEY, STEINWAY_A, makeTestApp, parkedBody } from "./helpers.js";

const built = vi.hoisted(() => ({ exporters: [] as unknown[], sdkLoaded: 0, hang: false }));
// Counted when first imported: off, the SDK is never loaded at all.
vi.mock("@opentelemetry/sdk-trace-node", async (importOriginal) => {
  built.sdkLoaded += 1;
  return importOriginal();
});
vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: class {
    constructor(config: unknown) {
      built.exporters.push(config);
    }
    export(_spans: unknown, done: (result: { code: number }) => void) {
      done({ code: 0 });
    }
    shutdown() {
      // A collector that never answers.
      return built.hang ? new Promise<void>(() => {}) : Promise.resolve();
    }
    forceFlush() {
      return Promise.resolve();
    }
  },
}));

const HEADERS = { "x-api-key": API_KEY, "content-type": "application/json" };
const traceIds = (t: ReturnType<typeof makeTestApp>, from = 0) =>
  t.state.decisions.slice(from).map((d) => (d as { traceId?: string | null }).traceId ?? null);

test("off: nothing starts, no exporter is built, and no trace id is made up", async () => {
  expect(await startTelemetry({})).toBeNull();
  expect(await startTelemetry({ console: false })).toBeNull();
  expect(built.exporters).toEqual([]);
  expect(built.sdkLoaded).toBe(0);

  const t = makeTestApp({ candidates: [STEINWAY_A] });
  await t.app.inject({ method: "POST", url: "/parked", headers: HEADERS, payload: parkedBody() });
  expect(traceIds(t).length).toBeGreaterThan(0);
  expect(new Set(traceIds(t))).toEqual(new Set([null]));

  // The caller's traceparent still lands on its decisions, as before.
  const before = t.state.decisions.length;
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  await t.app.inject({
    method: "POST",
    url: "/parked",
    headers: { ...HEADERS, traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
    payload: parkedBody(),
  });
  expect(new Set(traceIds(t, before))).toEqual(new Set([traceId]));
  // A request makes spans through the API only: still nothing loaded.
  expect(built.sdkLoaded).toBe(0);
});

test("an endpoint builds exactly one OTLP exporter, pointed at its traces path", async () => {
  const telemetry = await startTelemetry({ endpoint: "https://otel.example.com/" });
  expect(built.sdkLoaded).toBe(1);
  expect(telemetry).not.toBeNull();
  expect(built.exporters).toEqual([
    expect.objectContaining({ url: "https://otel.example.com/v1/traces" }),
  ]);
  await telemetry!.shutdown();
});

test("a collector that never answers holds shutdown for SHUTDOWN_FLUSH_MS, no longer", async () => {
  const telemetry = await startTelemetry({ endpoint: "https://otel.example.com/" });
  built.hang = true;
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  try {
    let done = false;
    const flushing = telemetry!.shutdown().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(SHUTDOWN_FLUSH_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flushing;
    expect(done).toBe(true);
  } finally {
    vi.useRealTimers();
    built.hang = false;
  }
});
