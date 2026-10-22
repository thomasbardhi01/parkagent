/**
 * Tracing (G), through OpenTelemetry. Off unless OTEL_EXPORTER_OTLP_ENDPOINT
 * is set (spans go there over OTLP/HTTP) or, in development, OTEL_CONSOLE
 * is true (spans print). Off, no SDK is started and every span below is
 * the API's no-op: nothing is recorded, and no trace id is made up.
 *
 * The spans: one per request (app.ts), `invoke_agent` around an
 * assistant turn, `chat {model}` around each model call, `execute_tool
 * {name}` around each tool call, and `money_gate` around the gate. They
 * carry ids, counts, token usage, rules and amounts; never what a person
 * wrote or what a model said.
 *
 * The GenAI attribute names follow the OpenTelemetry semantic
 * conventions at GEN_AI_SEMCONV_VERSION. Those are Development status, so
 * the names are pinned here as written in that version rather than read
 * from the package's unstable `incubating` entry.
 */

import { createRequire } from "node:module";

import type { Attributes, Context, Span } from "@opentelemetry/api";
import {
  INVALID_SPAN_CONTEXT,
  SpanKind,
  SpanStatusCode,
  isSpanContextValid,
  trace,
} from "@opentelemetry/api";
import type { SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-node";

import type { ModelResponse } from "./assistant/modelClient.js";

/** The semantic-conventions release the GenAI names below are from. */
export const GEN_AI_SEMCONV_VERSION = "1.43.0";

export const GEN_AI = {
  operation: "gen_ai.operation.name",
  provider: "gen_ai.provider.name",
  requestModel: "gen_ai.request.model",
  responseModel: "gen_ai.response.model",
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
  cacheReadTokens: "gen_ai.usage.cache_read.input_tokens",
  cacheCreationTokens: "gen_ai.usage.cache_creation.input_tokens",
  agentName: "gen_ai.agent.name",
  conversationId: "gen_ai.conversation.id",
  toolName: "gen_ai.tool.name",
} as const;

/** The server's version (server/package.json), on every span's scope. */
const VERSION = (createRequire(import.meta.url)("../../package.json") as { version: string })
  .version;

/** One tracer, from the global provider's proxy: a no-op until an SDK
 * registers, which then serves it. (The provider's own getTracer takes
 * the schema URL; `trace.getTracer` in api 1.9.1 drops it.) */
const TRACER = trace.getTracerProvider().getTracer("parkagent-api", VERSION, {
  schemaUrl: `https://opentelemetry.io/schemas/${GEN_AI_SEMCONV_VERSION}`,
});
const tracer = () => TRACER;

export interface TelemetryConfig {
  /** OTEL_EXPORTER_OTLP_ENDPOINT: the collector's base URL. */
  endpoint?: string | undefined;
  /** OTEL_CONSOLE: print spans (development). */
  console?: boolean;
}

export interface Telemetry {
  /** Flush and stop, giving up after SHUTDOWN_FLUSH_MS. */
  shutdown(): Promise<void>;
}

/** How long shutdown waits on the exporter: a collector that's down
 * otherwise holds it for the export timeout. Unsent spans are dropped. */
export const SHUTDOWN_FLUSH_MS = 2_000;

/**
 * Start tracing when it's on, or return null and load nothing: the SDK
 * and the exporter are imported here, only then, so a server with
 * tracing off never loads them. `testExporter` is for tests: spans land
 * in it synchronously.
 */
export async function startTelemetry(
  config: TelemetryConfig,
  testExporter?: SpanExporter,
): Promise<Telemetry | null> {
  if (!config.endpoint && config.console !== true && !testExporter) return null;
  const sdk = await import("@opentelemetry/sdk-trace-node");
  const { resourceFromAttributes } = await import("@opentelemetry/resources");
  const spanProcessors: SpanProcessor[] = [];
  if (config.endpoint) {
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
    const url = `${config.endpoint.replace(/\/+$/, "")}/v1/traces`;
    spanProcessors.push(
      new sdk.BatchSpanProcessor(new OTLPTraceExporter({ url, timeoutMillis: 10_000 })),
    );
  }
  if (config.console === true) {
    spanProcessors.push(new sdk.SimpleSpanProcessor(new sdk.ConsoleSpanExporter()));
  }
  if (testExporter) spanProcessors.push(new sdk.SimpleSpanProcessor(testExporter));
  const provider = new sdk.NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": "parkagent-api",
      "service.version": VERSION,
    }),
    // Every trace is recorded, the caller's unsampled ones included: an
    // agent's `traceparent` ending -00 must not silence the request's own
    // spans while its decisions still carry that trace's id.
    sampler: new sdk.AlwaysOnSampler(),
    spanProcessors,
  });
  // The async-hooks context manager and the W3C propagator.
  provider.register();
  return {
    shutdown: () =>
      Promise.race([
        provider.shutdown(),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_FLUSH_MS).unref()),
      ]),
  };
}

/** The active span's trace id, or null when none is recording (tracing
 * off, or outside a request). */
export function activeTraceId(): string | null {
  const context = trace.getActiveSpan()?.spanContext();
  return context && isSpanContextValid(context) ? context.traceId : null;
}

/** What code inside a span may do to it: add attributes, which never
 * throws. */
export interface SpanAttributes {
  setAttributes(attributes: Attributes): void;
}

/**
 * One call into tracing, which can't throw into its caller. Spans are
 * evidence: a failing tracer must never cost a request, a gate's answer,
 * or the decision row a turn's spend cap reads.
 */
export function quietly(call: () => void): void {
  try {
    call();
  } catch {
    // Dropped: the span loses an attribute, the caller loses nothing.
  }
}

/** Run `fn` inside a span. A throw marks the span an error by its type
 * only: an error's message can carry what someone wrote. No tracing
 * call here can throw into `fn`'s caller, and `fn` runs exactly once,
 * with no span if the tracer itself fails. */
export function inSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: SpanAttributes) => Promise<T>,
  kind: SpanKind = SpanKind.INTERNAL,
): Promise<T> {
  let run: Promise<T> | undefined;
  const body = async (span: Span): Promise<T> => {
    try {
      return await fn({ setAttributes: (more) => quietly(() => span.setAttributes(more)) });
    } catch (err) {
      quietly(() => span.setStatus({ code: SpanStatusCode.ERROR }));
      quietly(() => span.setAttribute("error.type", err instanceof Error ? err.name : typeof err));
      throw err;
    } finally {
      quietly(() => span.end());
    }
  };
  try {
    return tracer().startActiveSpan(name, { attributes, kind }, (span) => (run = body(span)));
  } catch {
    // Once `fn` has started it is never started again (it may be paying).
    return run ?? fn({ setAttributes() {} });
  }
}

/** A span for a request (app.ts), started outside the handler: the
 * API's non-recording span if the tracer fails. */
export function startRequestSpan(name: string, attributes: Attributes, parent: Context): Span {
  try {
    return tracer().startSpan(name, { attributes, kind: SpanKind.SERVER }, parent);
  } catch {
    return trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
  }
}

/** One model call as a `chat {model}` span, with the usage it reported. */
export function inChatSpan(
  model: string | undefined,
  call: () => Promise<ModelResponse>,
): Promise<ModelResponse> {
  const requested = model ?? "unknown";
  return inSpan(
    `chat ${requested}`,
    {
      [GEN_AI.operation]: "chat",
      [GEN_AI.provider]: "anthropic",
      [GEN_AI.requestModel]: requested,
    },
    async (span) => {
      const response = await call();
      span.setAttributes(usageAttributes(response));
      return response;
    },
    SpanKind.CLIENT,
  );
}

/** `gen_ai.usage.input_tokens` counts every input token, cached ones
 * included (semantic conventions 1.43.0); Anthropic's `input_tokens`
 * leaves out the cache reads and writes, so they are added back here.
 * Cost reads the provider's own counts, never this one. */
export function allInputTokens(usage: NonNullable<ModelResponse["usage"]>): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0);
}

function usageAttributes(response: ModelResponse): Attributes {
  const usage = response.usage;
  return {
    ...(response.model ? { [GEN_AI.responseModel]: response.model } : {}),
    ...(usage
      ? {
          [GEN_AI.inputTokens]: allInputTokens(usage),
          [GEN_AI.outputTokens]: usage.outputTokens,
          ...(usage.cacheReadTokens !== undefined
            ? { [GEN_AI.cacheReadTokens]: usage.cacheReadTokens }
            : {}),
          ...(usage.cacheCreationTokens !== undefined
            ? { [GEN_AI.cacheCreationTokens]: usage.cacheCreationTokens }
            : {}),
        }
      : {}),
  };
}
