/**
 * GET /agent/openapi.json: the agent surface as an OpenAPI 3.1 document,
 * generated from the same zod schemas the routes parse with
 * (agentSchemas.ts), so it can't drift. No generator dependency: zod's
 * own z.toJSONSchema emits JSON Schema 2020-12, which OpenAPI 3.1 takes
 * as-is. Public, like any API description: it carries no data.
 */

import { AGENT_TOOLS, jsonSchemaOf } from "./agentSchemas.js";
import { recordId } from "./ids.js";

/** A path id as the routes parse it (routes/ids.ts). */
const idSchema = jsonSchemaOf(recordId);

const errorBody = {
  type: "object",
  properties: { error: { type: "string" }, decisionId: { type: "string" } },
  required: ["error"],
};

const json = (schema: Record<string, unknown>) => ({ "application/json": { schema } });

const refusals = {
  "400": { description: "The body didn't parse", content: json(errorBody) },
  "401": { description: "An unknown or revoked agent key", content: json(errorBody) },
  "403": {
    description:
      "No agent key (agent_surface_needs_agent_key), the key lacks the scope, or the person hasn't let agents act (agents_not_allowed)",
    content: json(errorBody),
  },
  "429": { description: "60 calls a minute per key", content: json(errorBody) },
};

const reads: Record<string, { summary: string; param?: string }> = {
  "/agent/me": { summary: "Who the key acts for, its scopes, and the person's consent" },
  "/agent/plans/{planId}": { summary: "A plan the key proposed", param: "planId" },
  "/agent/parks/{parkId}": { summary: "A park the phone reported: its status", param: "parkId" },
  "/agent/decisions/{decisionId}/why": {
    summary:
      "Why a decision came out as it did: {reason: {subject, what, because: [{name, label, value}], youCan}, text, phrased}",
    param: "decisionId",
  },
};

export function agentOpenApi(): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const tool of AGENT_TOOLS) {
    const param = tool.route.includes("{planId}")
      ? [{ name: "planId", in: "path", required: true, schema: idSchema }]
      : [];
    paths[tool.route] = {
      post: {
        operationId: tool.name,
        summary: tool.description,
        ...(param.length > 0 ? { parameters: param } : {}),
        requestBody: { required: true, content: json(jsonSchemaOf(tool.schema)) },
        responses: {
          "200": { description: "The capability's answer", content: json({ type: "object" }) },
          ...refusals,
          ...(tool.name === "confirm_plan"
            ? {
                "404": { description: "No such plan or mandate", content: json(errorBody) },
                "409": {
                  description:
                    "mandate_used, plan_hash_mismatch, nothing_to_confirm, dry_run_changed, a cap (policy_violation), garage_option_expired, or garage_book_failed",
                  content: json(errorBody),
                },
                "410": {
                  description: "The mandate expired (10 minutes)",
                  content: json(errorBody),
                },
              }
            : {}),
        },
      },
    };
  }
  for (const [route, read] of Object.entries(reads)) {
    paths[route] = {
      get: {
        summary: read.summary,
        ...(read.param
          ? {
              parameters: [{ name: read.param, in: "path", required: true, schema: idSchema }],
            }
          : {}),
        responses: {
          "200": { description: "The record", content: json({ type: "object" }) },
          ...refusals,
          ...(read.param
            ? { "404": { description: "Not this person's", content: json(errorBody) } }
            : {}),
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "ParkAgent agent API",
      version: "1",
      description:
        "Search, plan and confirm parking for one person, as their agent. Nothing here pays: a confirmed street spot waits for the person's phone to report the car there.",
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        agentKey: { type: "http", scheme: "bearer", description: "pak_<prefix>_<secret>" },
      },
    },
    security: [{ agentKey: [] }],
    paths,
  };
}

/** The six tools as OpenAI-style function definitions (examples/grok-tool.json). */
export function agentFunctionTools(): Record<string, unknown>[] {
  return AGENT_TOOLS.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: `${tool.description} (POST ${tool.route})`,
      parameters: jsonSchemaOf(tool.schema),
    },
  }));
}
