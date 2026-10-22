/**
 * The model transport's shapes and the model ids, a leaf module: tools.ts,
 * anthropicClient.ts and loop.ts all read these, and nothing here imports
 * back (the tools.ts <-> loop.ts cycle ended here).
 */

/** One tool definition as the Messages API takes it (tools.ts holds the
 * eleven); structural, so this module needs nothing from tools.ts. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: object;
  strict?: boolean;
}

/** Overridden by ASSISTANT_MODEL (legacy fallback: ANTHROPIC_MODEL). */
export const DEFAULT_ASSISTANT_MODEL = "claude-sonnet-5";
/** The cheap model that phrases explain_decision output (EXPLAIN_MODEL). */
export const DEFAULT_EXPLAIN_MODEL = "claude-haiku-4-5-20251001";

/** One content block of an assistant message, Messages-API shaped. */
export type ModelContentBlock =
  { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };

export interface ModelTurn {
  role: "user" | "assistant";
  content:
    string | (ModelContentBlock | { type: "tool_result"; tool_use_id: string; content: string })[];
}

export interface ModelResponse {
  content: ModelContentBlock[];
  stopReason: string;
  /** Which model actually answered and what it billed — logged per turn
   * on the assistant_turn decision row. Fakes may omit it. */
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Which model runs where. The loop takes ASSISTANT_MODEL, falling back to
 * the legacy ANTHROPIC_MODEL, then claude-sonnet-5-5; explanations always
 * run on the cheap EXPLAIN_MODEL.
 */
export function resolveAssistantModels(env: {
  ASSISTANT_MODEL?: string | undefined;
  ANTHROPIC_MODEL?: string | undefined;
  EXPLAIN_MODEL?: string | undefined;
}): { assistant: string; explain: string } {
  return {
    assistant: env.ASSISTANT_MODEL ?? env.ANTHROPIC_MODEL ?? DEFAULT_ASSISTANT_MODEL,
    explain: env.EXPLAIN_MODEL ?? DEFAULT_EXPLAIN_MODEL,
  };
}

/** One model call's bill — what the turn's accounting row sums. */
export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** The transport seam: the real one wraps @anthropic-ai/sdk streaming;
 * tests inject a scripted fake. onText receives streamed text deltas. */
export interface ModelClient {
  create(
    args: {
      system: string;
      messages: ModelTurn[];
      /** Omitted for plain phrasing calls (explain_decision). */
      tools?: ToolDefinition[];
      maxTokens: number;
    },
    onText?: (delta: string) => void,
  ): Promise<ModelResponse>;
}
