/**
 * Real ModelClient over @anthropic-ai/sdk, streaming (text deltas feed
 * the client's SSE). Absent ANTHROPIC_API_KEY → the assistant routes 503
 * (index.ts wires undefined); tests always inject a fake, so nothing in
 * vitest touches the network.
 */

import Anthropic from "@anthropic-ai/sdk";

import { DEFAULT_ASSISTANT_MODEL } from "./modelClient.js";
import type { ModelClient, ModelContentBlock, ModelResponse } from "./modelClient.js";

/** What went wrong at the provider, in the few kinds a caller acts on. */
export type ModelErrorKind =
  "billing" | "auth" | "rate_limit" | "overloaded" | "bad_request" | "unknown";

export interface ModelError {
  kind: ModelErrorKind;
  /** HTTP status; null for an error event mid-stream or a lost connection. */
  status: number | null;
  /** Anthropic's request id (the `request-id` header), for support. */
  requestId: string | null;
}

/** An exhausted prepaid balance arrives as a 400 invalid_request_error
 * ("Your credit balance is too low to access the Anthropic API…"), not as
 * a billing_error, so its message is the only tell. The one place that
 * decides "this is billing". */
export function isBillingError(type: string | null, status: number | null, message: string) {
  if (type === "billing_error" || status === 402) return true;
  return (type === "invalid_request_error" || status === 400) && /credit balance/i.test(message);
}

/** The SDK's error (thrown by the request, or by an `error` event
 * mid-stream, which has a type but no status) as a ModelError; null for
 * anything that isn't the SDK's — a bug of ours stays a bug. */
export function classifyModelError(err: unknown): ModelError | null {
  if (!(err instanceof Anthropic.APIError)) return null;
  const status = typeof err.status === "number" ? err.status : null;
  const type: string | null = err.type;
  return { kind: kindOf(type, status, err.message), status, requestId: err.requestID ?? null };
}

function kindOf(type: string | null, status: number | null, message: string): ModelErrorKind {
  if (isBillingError(type, status, message)) return "billing";
  if (type === "authentication_error" || type === "permission_error") return "auth";
  if (status === 401 || status === 403) return "auth";
  if (type === "rate_limit_error" || status === 429) return "rate_limit";
  if (type === "overloaded_error" || status === 529) return "overloaded";
  if (status !== null && status >= 400 && status < 500) return "bad_request";
  return "unknown";
}

export function makeAnthropicModelClient(
  apiKey: string,
  model: string = DEFAULT_ASSISTANT_MODEL,
): ModelClient {
  const client = new Anthropic({ apiKey });
  return {
    model,
    async create(args, onText) {
      const stream = client.messages.stream({
        model,
        max_tokens: args.maxTokens,
        system: args.system,
        ...(args.tools ? { tools: args.tools as Anthropic.Tool[] } : {}),
        ...(args.outputSchema || args.effort
          ? {
              output_config: {
                ...(args.outputSchema
                  ? { format: { type: "json_schema" as const, schema: args.outputSchema } }
                  : {}),
                ...(args.effort ? { effort: args.effort } : {}),
              },
            }
          : {}),
        messages: args.messages as Anthropic.MessageParam[],
      });
      if (onText) {
        stream.on("text", (delta) => onText(delta));
      }
      return toModelResponse(await stream.finalMessage());
    },
  };
}

/** The SDK's message as the loop's response: text and tool calls as
 * before, and the model's thinking blocks carried through untouched so
 * the next call gets them back (the API checks their signatures; a block
 * dropped or edited is a 400 on Claude Sonnet 5.5 and Claude Haiku 5.5). */
export function toModelResponse(message: Anthropic.Message): ModelResponse {
  const content: ModelContentBlock[] = [];
  for (const block of message.content) {
    if (block.type === "text") content.push({ type: "text", text: block.text });
    else if (block.type === "tool_use") {
      content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
    } else if (block.type === "thinking") {
      content.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
    } else if (block.type === "redacted_thinking") {
      content.push({ type: "redacted_thinking", data: block.data });
    }
  }
  const details = message.stop_reason === "refusal" ? message.stop_details : null;
  return {
    content,
    stopReason: message.stop_reason ?? "end_turn",
    ...(details
      ? {
          stopDetails: {
            category: details.category ?? null,
            ...(details.explanation ? { explanation: details.explanation } : {}),
          },
        }
      : {}),
    model: message.model,
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      ...(typeof message.usage.cache_read_input_tokens === "number"
        ? { cacheReadTokens: message.usage.cache_read_input_tokens }
        : {}),
      ...(typeof message.usage.cache_creation_input_tokens === "number"
        ? { cacheCreationTokens: message.usage.cache_creation_input_tokens }
        : {}),
    },
  };
}
