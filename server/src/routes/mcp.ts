/**
 * The MCP surface (WS-4 PR 3): POST/GET `/mcp`, protocol revision
 * 2026-07-28, served by the MCP TypeScript SDK v2 (`createMcpHandler`,
 * mounted with `toNodeHandler`). 2025-era clients are served statelessly
 * from the same server definition (`legacy: 'stateless'`).
 *
 * It is an agent surface (services/principal.ts AGENT_SURFACES): only an
 * agent key gets in, resolved once in makeAuthenticate and handed to the
 * SDK as `authInfo`; a session or the admin key is 403 before the SDK sees
 * the request. Every tool is one of the agent REST calls
 * (services/agentActions.ts), run as that key's principal, through the
 * same mandate and the one money gate, with the same per-key budget:
 * a refusal is a tool error (`isError`) carrying the REST code.
 * explain_decision is the REST "why" (GET /agent/decisions/{id}/why).
 *
 * Nothing pays. propose_plan hands back the plan id and the one-time
 * confirmToken (the mandate) as ordinary result fields; confirm_plan takes
 * them back as ordinary arguments, once, and answers `garage_handoff` or
 * `pending_arrival` exactly as REST. Arrival comes only from the phone.
 *
 * With MCP_APPS on, propose_plan also points a host at a `ui://` confirm
 * card (MCP Apps); its one button calls confirm_plan through the host.
 */

import type { NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { CallToolResult, ServerContext } from "@modelcontextprotocol/server";
import {
  createMcpHandler,
  McpServer,
  ProtocolError,
  ResourceNotFoundError,
  ResourceTemplate,
} from "@modelcontextprotocol/server";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppDeps } from "../app.js";
import type { AgentActions, AgentAnswer } from "../services/agentActions.js";
import { policyFor } from "../services/limits.js";
import { isBadInputSqlState, sqlStateOf } from "../services/pgErrors.js";
import type { Principal } from "../services/principal.js";
import { currentTraceId, runAs, traceIdFrom } from "../services/principal.js";
import { agentKeyBucket, makeRateLimiter } from "../services/rateLimit.js";
import type { AgentLimit } from "./agent.js";
import { AGENT_TOOLS, confirmSchema, explainSchema } from "./agentSchemas.js";
import { recordId } from "./ids.js";
import { CONFIRM_CARD_HTML, CONFIRM_CARD_MIME, CONFIRM_CARD_URI } from "./mcpConfirmCard.js";

export const MCP_SERVER_INFO = { name: "parkagent", version: "1.0.0" } as const;

/** Every request to /mcp, whatever it asks (initialize, tools/list,
 * discover, ping, GET), per key: a generous ceiling of its own, apart from
 * the per-call budget the tools share with REST, so a key can't hammer the
 * endpoint with calls that cost nothing against that budget. */
export const MCP_REQUESTS_PER_MINUTE = 600;

/** A JSON-RPC server-range code for "over the key's budget", with
 * `{error: "rate_limited", retryAfterS}` as its data. */
export const RATE_LIMITED_CODE = -32029;

/** JSON-RPC's own "internal error": a resource read that threw. */
const INTERNAL_ERROR_CODE = -32603;

/** What a host may cache tools/list for: five minutes, this key only. */
const TOOLS_LIST_CACHE = { ttlMs: 300_000, cacheScope: "private" } as const;

/** Said on the tools that plan and confirm, so an agent can't miss them. */
const RULES =
  " The phone is the only source of arrival: nothing is paid until the user's phone reports the car parked and the user walks away, so a street confirm may answer pending_arrival. Confirming needs the user's own consent for agents (PATCH /me/settings agentsMayAct) and the key's confirm scope; the user's caps and dry run apply.";

/** confirm_plan over MCP: the plan id travels as an argument, not a path. */
const mcpConfirmSchema = z.strictObject({
  planId: recordId.describe("From propose_plan"),
  confirmToken: confirmSchema.shape.confirmToken,
});

/** The six agent tools, then explain_decision: over REST that one is
 * GET /agent/decisions/{decisionId}/why, a read with no body, so it is not
 * one of AGENT_TOOLS (the POST routes OpenAPI and grok-tool.json list). */
const MCP_TOOLS = [
  ...AGENT_TOOLS,
  {
    name: "explain_decision",
    route: "/agent/decisions/{decisionId}/why",
    description:
      "Why a decision came out as it did, by the decisionId a confirm or a refusal answered with: the reason as data (what happened, the facts behind it, what the user can do) and a sentence to show. The user's own decisions only. Read-only.",
    schema: explainSchema,
  },
] as const;

type ToolName = (typeof MCP_TOOLS)[number]["name"];

/** The tools, in the declared order (MCP_TOOLS): tools/list answers them
 * in exactly this order. */
const TOOLS: {
  name: ToolName;
  schema: z.ZodType;
  run: (actions: AgentActions, principal: Principal, args: never) => Promise<AgentAnswer>;
}[] = MCP_TOOLS.map((tool) => ({
  name: tool.name,
  schema: tool.name === "confirm_plan" ? mcpConfirmSchema : tool.schema,
  run: (actions, principal, args) => {
    switch (tool.name) {
      case "geocode_place":
        return actions.geocode(principal, args);
      case "quote_street":
        return actions.quoteStreet(principal, args);
      case "search_garages":
        return actions.searchGarages(principal, args);
      case "build_itinerary":
        return actions.itinerary(principal, args);
      case "propose_plan":
        return actions.plan(principal, args);
      case "confirm_plan": {
        const { planId, confirmToken } = args as z.infer<typeof mcpConfirmSchema>;
        return actions.confirm(principal, planId, confirmToken);
      }
      case "explain_decision": {
        const { decisionId } = args as z.infer<typeof explainSchema>;
        return actions.why(principal, decisionId);
      }
    }
  },
}));

const describe = (name: ToolName): string => {
  const base = MCP_TOOLS.find((t) => t.name === name)!.description;
  return name === "propose_plan" || name === "confirm_plan" ? base + RULES : base;
};

/** An answer as a tool result: the REST body, as text and structured; a
 * refusal is a tool error carrying its REST code in `error`. */
function resultOf(answer: AgentAnswer): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(answer.body) }],
    structuredContent: answer.body,
    ...(answer.status === 200 ? {} : { isError: true }),
  };
}

/** The principal the transport resolved, as handed to the SDK. */
function principalOf(extra: Record<string, unknown> | undefined): Principal {
  const principal = extra?.["principal"] as Principal | undefined;
  if (!principal) throw new Error("mcp: no principal on the request");
  return principal;
}

/** The trace a call carries in `_meta.traceparent` (2026-07-28), else the
 * HTTP request's own header. */
function traceOf(ctx: ServerContext): string | null {
  return traceIdFrom(ctx.mcpReq._meta?.["traceparent"]) ?? currentTraceId();
}

export function buildMcpServer(
  deps: AppDeps,
  limit: AgentLimit,
  actions: AgentActions,
  principal: Principal,
  log: FastifyBaseLogger,
): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, {
    cacheHints: { "tools/list": TOOLS_LIST_CACHE },
  });

  /** One call against the key's budget (shared with REST), as the key's
   * principal, under the call's trace. */
  const call = (ctx: ServerContext, work: () => Promise<AgentAnswer>): Promise<AgentAnswer> => {
    const retryAfterS = limit.buckets.take(
      agentKeyBucket(principal.agentKeyId ?? principal.userId),
    );
    if (retryAfterS !== null) {
      return Promise.resolve({ status: 429, body: { error: "rate_limited", retryAfterS } });
    }
    return runAs(principal, work, traceOf(ctx));
  };

  /** A call that threw (a Prisma error, say): logged here, answered as
   * REST's 500. The SDK would hand the agent the error's own text, which
   * names the query and the build's paths, and log nothing. */
  const failed = (err: unknown, what: string): AgentAnswer => {
    // A NUL byte that reached a query: the call's fault, as REST answers it.
    if (isBadInputSqlState(err)) {
      log.warn({ sqlState: sqlStateOf(err), mcp: what }, "mcp: input the database refused");
      return { status: 400, body: { error: "bad_request" } };
    }
    log.error({ err, mcp: what }, "mcp: call failed");
    return { status: 500, body: { error: "internal" } };
  };

  for (const tool of TOOLS) {
    const cardMeta = tool.name === "propose_plan" && deps.mcpApps;
    server.registerTool(
      tool.name,
      {
        description: describe(tool.name),
        inputSchema: tool.schema as z.ZodObject,
        ...(cardMeta ? { _meta: { ui: { resourceUri: CONFIRM_CARD_URI } } } : {}),
      },
      async (args: unknown, ctx: ServerContext) => {
        try {
          const answer = await call(ctx, () => tool.run(actions, principal, args as never));
          const result = resultOf(answer);
          if (!cardMeta || answer.status !== 200 || !answer.body["confirmToken"]) return result;
          // The card shows the caps the confirm is checked against.
          const policy = await policyFor(deps, principal.userId);
          return {
            ...result,
            _meta: {
              ui: { resourceUri: CONFIRM_CARD_URI },
              "io.parkagent/caps": {
                sessionCapUsd: policy.session_cap_usd,
                dailyCapUsd: policy.daily_cap_usd,
              },
            },
          };
        } catch (err) {
          return resultOf(failed(err, tool.name));
        }
      },
    );
  }

  // The person's own plans and parks, by id; anyone else's is not found.
  for (const [name, template, read] of [
    ["plan", "parkagent://plans/{id}", actions.getPlan],
    ["park", "parkagent://parks/{id}", actions.getPark],
  ] as const) {
    server.registerResource(
      name,
      new ResourceTemplate(template, { list: undefined }),
      { mimeType: "application/json" },
      async (uri, variables, ctx) => {
        const id = String(variables["id"] ?? "");
        let answer: AgentAnswer;
        try {
          answer = await call(ctx, () => read(principal, id));
        } catch (err) {
          failed(err, name);
          throw new ProtocolError(INTERNAL_ERROR_CODE, "internal");
        }
        if (answer.status === 429) {
          // Over the key's budget: said as such, not as a missing resource.
          throw new ProtocolError(RATE_LIMITED_CODE, "rate_limited", answer.body);
        }
        if (answer.status !== 200) throw new ResourceNotFoundError(uri.href);
        return {
          contents: [
            { uri: uri.href, mimeType: "application/json", text: JSON.stringify(answer.body) },
          ],
        };
      },
    );
  }

  if (deps.mcpApps) {
    server.registerResource(
      "confirm-card",
      CONFIRM_CARD_URI,
      {
        mimeType: CONFIRM_CARD_MIME,
        description: "Confirm a proposed spot: price, caps, arrival rule",
      },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: CONFIRM_CARD_MIME, text: CONFIRM_CARD_HTML }],
      }),
    );
  }
  return server;
}

export function registerMcp(
  app: FastifyInstance,
  deps: AppDeps,
  limit: AgentLimit,
  actions: AgentActions,
): void {
  const handler = createMcpHandler(
    ({ authInfo }) => buildMcpServer(deps, limit, actions, principalOf(authInfo?.extra), app.log),
    {
      legacy: "stateless",
      // subscriptions/listen is refused before the SDK (below); this only
      // bounds what a slip could hold open.
      maxSubscriptions: 1,
      onerror: (error) => app.log.warn({ err: error }, "mcp: request rejected"),
    },
  );
  const node = toNodeHandler(handler, {
    onerror: (error) => app.log.error({ err: error }, "mcp: handler failed"),
  });

  const ceiling = makeRateLimiter({
    max: MCP_REQUESTS_PER_MINUTE,
    windowMs: 60_000,
    ...(deps.now ? { now: () => deps.now!().getTime() } : {}),
  });

  // makeAuthenticate has already admitted only an agent key here (an agent
  // surface); the SDK gets its principal, never a header to re-read.
  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    preHandler: ceiling,
    handler: async (req, reply) => {
      // The tool and resource lists never change while the server runs:
      // nothing to listen to, and no change stream held open per key.
      const message = req.body as { method?: unknown; id?: unknown } | undefined;
      if (message && !Array.isArray(message) && message.method === "subscriptions/listen") {
        return reply.code(200).send({
          jsonrpc: "2.0",
          id: message.id ?? null,
          error: { code: -32601, message: "Method not found: subscriptions/listen" },
        });
      }
      const principal = req.principal!;
      const raw = req.raw as unknown as NodeIncomingMessageLike;
      raw.auth = {
        token: "agent-key",
        clientId: principal.agentKeyId ?? principal.userId,
        scopes: [...principal.scopes].sort(),
        extra: { principal },
      };
      reply.hijack();
      await node(raw, reply.raw, req.body);
    },
  });
}
