/**
 * The assistant's provider health, as this process last saw it: the kind
 * of the last failed model call and when, cleared by the next turn that
 * completes. /health reads it, so a billing or auth outage shows in
 * `degraded` without /health ever calling the model.
 */

import type { ModelErrorKind } from "./anthropicClient.js";

/** How long a billing or auth failure keeps "assistant" in /health. */
export const ASSISTANT_FAILURE_WINDOW_MS = 15 * 60_000;

export interface AssistantHealth {
  failed(kind: ModelErrorKind, at: Date): void;
  succeeded(): void;
  /** The last call failed on billing or auth, within the window. */
  degraded(at: Date): boolean;
}

export function makeAssistantHealth(): AssistantHealth {
  let last: { kind: ModelErrorKind; atMs: number } | null = null;
  return {
    failed(kind, at) {
      last = { kind, atMs: at.getTime() };
    },
    succeeded() {
      last = null;
    },
    degraded(at) {
      if (!last || (last.kind !== "billing" && last.kind !== "auth")) return false;
      return at.getTime() - last.atMs < ASSISTANT_FAILURE_WINDOW_MS;
    },
  };
}
