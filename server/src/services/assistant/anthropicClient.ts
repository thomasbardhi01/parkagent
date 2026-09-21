/**
 * Real ModelClient over @anthropic-ai/sdk, streaming (text deltas feed
 * the client's SSE). Absent ANTHROPIC_API_KEY → the assistant routes 503
 * (index.ts wires undefined); tests always inject a fake, so nothing in
 * vitest touches the network.
 */

import Anthropic from "@anthropic-ai/sdk";

import { ASSISTANT_MODEL } from "./loop.js";
import type { ModelClient, ModelContentBlock } from "./loop.js";

export function makeAnthropicModelClient(apiKey: string): ModelClient {
  const client = new Anthropic({ apiKey });
  return {
    async create(args, onText) {
      const stream = client.messages.stream({
        model: ASSISTANT_MODEL,
        max_tokens: args.maxTokens,
        system: args.system,
        tools: args.tools as Anthropic.Tool[],
        messages: args.messages as Anthropic.MessageParam[],
      });
      if (onText) {
        stream.on("text", (delta) => onText(delta));
      }
      const message = await stream.finalMessage();
      const content: ModelContentBlock[] = [];
      for (const block of message.content) {
        if (block.type === "text") content.push({ type: "text", text: block.text });
        else if (block.type === "tool_use") {
          content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
        }
      }
      return { content, stopReason: message.stop_reason ?? "end_turn" };
    },
  };
}
