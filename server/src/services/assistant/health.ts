/**
 * The assistant's provider health, as this process last saw it: whether a
 * model call failed on billing or auth since the last turn that completed.
 * /health reads it, so a billing or auth outage shows in `degraded`
 * without /health ever calling the model.
 *
 * No time window: neither fixes itself, and on a quiet day the nightly's
 * turn may be the only call, so the failure stays listed until a turn
 * succeeds (or the process restarts).
 */

import type { ModelErrorKind } from "./anthropicClient.js";

export interface AssistantHealth {
  failed(kind: ModelErrorKind): void;
  succeeded(): void;
  /** A call failed on billing or auth, and no turn has completed since. */
  degraded(): boolean;
}

export function makeAssistantHealth(): AssistantHealth {
  let blocked = false;
  return {
    failed(kind) {
      // A rate limit or overload after it says nothing about billing or auth.
      if (kind === "billing" || kind === "auth") blocked = true;
    },
    succeeded() {
      blocked = false;
    },
    degraded() {
      return blocked;
    },
  };
}
