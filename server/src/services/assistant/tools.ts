/**
 * The assistant's tools. The MODEL plans and phrases; THESE enforce
 * policy: caps and quotes come from the same services the rest of the
 * server uses, and the two consequential tools (book_garage,
 * start_session) refuse without a live confirmation token — which only
 * POST /assistant/confirm (the user's tap on a plan card) can mint.
 * Every call writes a decisions row (kind "assistant_tool").
 */

import { z } from "zod";

import { coveredCitiesSentence } from "../../providers/registry.js";
import { explainDecision } from "../capabilities/explainDecision.js";
import { STAY_QUESTION, STAY_SUGGESTIONS, asksAboutStay } from "./clarify.js";
import { intentOf, toolAllowed, toolOffInstruction } from "./intentRouter.js";
import {
  MAX_REQUEST_EDITS_PER_TURN,
  UPDATE_REQUEST_INPUT_SCHEMA,
  applyPatch,
  emptyState,
  parsePatch,
  setsNothing,
  stateForModel,
} from "./requestState.js";
import type { ModelClient, ModelUsage } from "./modelClient.js";
import { principalFor } from "../principal.js";
import { currentTimeLine } from "./replyText.js";
import { MODEL_PLAN_JSON_SCHEMA } from "./plans.js";
import type { EditedItineraryStop } from "./plans.js";
import { DEFAULT_STREET_RADIUS_M, walkMinutesFor } from "./streetOptions.js";
import { buildItinerary, repriceStops } from "../capabilities/buildItinerary.js";
import type { PreviousStop, PricedStop, RepriceResult } from "../capabilities/buildItinerary.js";
import { bookGarage, startSession } from "../capabilities/confirmPlan.js";
import { geocodePlace } from "../capabilities/geocodePlace.js";
import { proposePlan } from "../capabilities/proposePlan.js";
import { quoteStreet, searchGarages } from "../capabilities/search.js";
import { TIME_FORMAT_HINT, num, stateOf } from "../capabilities/turn.js";
import type {
  Ask,
  CapabilityDeps,
  Suggestion,
  ToolOutcome,
  TurnState,
} from "../capabilities/turn.js";

export type { Ask, Suggestion, ToolOutcome, PreviousStop, PricedStop, RepriceResult };
export {
  NAMED_PLACE_GARAGE_RADIUS_M,
  MAX_WALK_TIMED,
  MAX_WALK_REQUESTS,
} from "../capabilities/turn.js";

export interface AssistantDeps extends CapabilityDeps {
  /** The cheap EXPLAIN_MODEL transport. Absent → explain_decision returns
   * the plain template sentence unphrased. */
  explainModel?: ModelClient | undefined;
}

/** The model's view of a turn: the capabilities' TurnState plus who is
 * calling, and where a tool's own model calls report their usage. */
export interface ToolContext extends TurnState {
  userId: string;
  /** Model calls a tool makes on its own (explain_decision's phrasing)
   * report here, so the turn's accounting row — and the daily spend cap
   * that reads it — counts them too. */
  onModelUsage?: ((usage: ModelUsage) => void) | undefined;
}

const askSchema = z.object({
  question: z.string().min(1).max(300),
  suggestions: z
    .array(z.object({ label: z.string().min(1).max(60), reply: z.string().min(1).max(200) }))
    .min(2)
    .max(4),
});

export const CONFIRMATION_TTL_MS = 10 * 60_000;

/**
 * What quote_street and search_garages take: nothing but an optional note
 * (FR-43). The place, the window, the limits, and the ranking are read
 * from the conversation's request, so there is no argument to drop a
 * constraint from. Strict, so the API holds the model to it.
 */
const SEARCH_INPUT_SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  required: [] as string[],
  properties: {
    note: {
      type: "string",
      description: "Optional, a few words on why you're searching. It changes nothing.",
    },
  },
};

/** Anthropic tool definitions (Messages API shape). Kept in one place so
 * the schema tests pin exactly what the model sees. */
export const TOOL_DEFINITIONS = [
  {
    name: "update_request",
    description:
      'Record a change to the user\'s parking request — the server-owned state shown as "Current request". Put each change in its own field and send ONLY what changed, never the whole request — e.g. {placeQuery: "Fenway", startsAt: "2026-09-26T19:00:00-04:00", durationMinutes: 120, maxPriceUsd: 20}. A value you send replaces the old one, `clear` removes one, and unmentioned fields keep their values; `reason` is only a note and changes nothing. Call it before searching whenever the user states or changes the place, the time, the stay, a limit (price, walk, garage or street, valet, covered), or a preference (cheapest, closest). The server derives the intent from the time and the kinds; yours is advisory. The result is the full new request, what changed, and any intent the server overrode. At most two calls per turn.',
    strict: true,
    input_schema: UPDATE_REQUEST_INPUT_SCHEMA,
  },
  {
    name: "geocode_place",
    description: `Look up a NAMED place — a restaurant, bar, venue, business, hotel, landmark, street, or neighborhood — and make it the request's place, biased to the phone's city among the cities ParkAgent covers (${coveredCitiesSentence()}). Call this FIRST whenever the user names a place instead of relying on their current location, passing their words including any area they named (e.g. 'Lola 42 Seaport'); quote_street and search_garages then search there. Answers: found with match "exact" → the request's place is set; match "closest" → the NAME wasn't found, only the nearest thing (tell the user); ambiguous with choices → call ask_user with those choices; found:false → couldn't find it. Every answer carries the server's \`resolution\` (found, closest_only, ambiguous, or none) and its 0–1 \`confidence\`: act on the resolution as given — it isn't yours to upgrade.`,
    strict: true,
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description:
            "The named place in the user's words, with any area they named: e.g. 'Lola 42 Seaport', 'Moo steakhouse Seaport', 'Newbury Street', 'SoHo'",
        },
        city: {
          type: "string",
          enum: ["nyc", "bos"],
          description:
            "Bias toward this city when you know it (e.g. the user's current city). Omit to search both.",
        },
      },
    },
  },
  {
    name: "search_garages",
    description:
      "Off-street garages for the CURRENT REQUEST. Takes no arguments: it reads the place, the time, the stay, the limits, and the ranking from the request — to search another place, time, stay, or budget, change the request first (update_request, geocode_place). Sources: SpotHero and ParkWhiz, merged; each option names its provider, and checkout is a deep link to that site (the user finishes the purchase there). Returns {stateVersion, verdict, satisfying, nearMisses, relaxSuggestions?}: `satisfying` options meet every limit and are already ranked (keep the order); each of `nearMisses` breaks a limit, and its `violates` says which and by how much; the result covers street too once quote_street has run for this request. A garage-only request is answered with garages; the server may add ONE street option to `nearMisses` — a cheaper meter — which is never an option that meets the request. Propose options by `id`.",
    strict: true,
    input_schema: SEARCH_INPUT_SCHEMA,
  },
  {
    name: "quote_street",
    description: `Street parking for the CURRENT REQUEST: every metered block within a walk of the request's place (${DEFAULT_STREET_RADIUS_M} m, about a ${walkMinutesFor(DEFAULT_STREET_RADIUS_M)}-minute walk; wider when that holds none), each priced for the request's window and described for THAT window — free (e.g. "Free after 6 PM"), metered then free, or metered with its rate and max stay. Takes no arguments: it reads the place, the time, the stay, the limits, and the ranking from the request — to search another place, time, stay, or budget, change the request first (update_request, geocode_place). Uses the same zone data and pricing as automatic payments. Not available for a garage-only request. Returns {stateVersion, verdict, satisfying, nearMisses, relaxSuggestions?}: \`satisfying\` options meet every limit and are already ranked (keep the order); each of \`nearMisses\` breaks a limit, and its \`violates\` says which and by how much; the result covers garages too once search_garages has run for this request. Propose options by \`id\`.`,
    strict: true,
    input_schema: SEARCH_INPUT_SCHEMA,
  },
  {
    name: "build_itinerary",
    description:
      "Price a multi-stop day: for each stop, quote street parking AND the best garage, and check the day total against the user's daily cap. Use the result to decide street vs garage per stop before proposing the plan. Available for a request that starts later: put the day's first arrival on the request first (update_request startsAt). One to twelve stops.",
    strict: true,
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      required: ["stops"],
      properties: {
        stops: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label", "lat", "lng", "arrival", "duration_minutes"],
            properties: {
              label: { type: "string" },
              address: { type: "string" },
              lat: { type: "number" },
              lng: { type: "number" },
              arrival: { type: "string", description: "ISO arrival time" },
              duration_minutes: { type: "integer", description: "1 to 720" },
            },
          },
        },
      },
    },
  },
  {
    name: "propose_plan",
    description:
      'Present the final plan to the user as a card and END your turn. Single-spot: up to 3 options from the LATEST search, each named by its `id` exactly as the search returned it — the server attaches the price, walk, time, and link, puts the options in the search\'s order, and recommends the first. An option from `nearMisses` may ride along only with nearMiss: true. When the search\'s verdict is not "meets", send {kind: "none_meets"} instead: the server fills in what came closest and what relaxing a limit would yield. Itinerary: the per-stop choices with costs and the day total. Nothing is booked or paid by this tool — the user must tap Confirm/Sign off.',
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      required: ["plan"],
      properties: {
        plan: {
          ...MODEL_PLAN_JSON_SCHEMA,
          description:
            "The plan: a single_spot plan (1–3 options by id), an itinerary (1–12 stops), or none_meets",
        },
      },
    },
  },
  {
    name: "ask_user",
    description:
      "Ask the user ONE short clarifying question with 2–4 tappable suggestions, and END your turn. Use it whenever you must ask something instead of asking in prose: which of several matching places (use geocode_place's choices: their label and reply exactly), what time, how long, or which city (only when there's no phone location). In the question, state what you already assumed.",
    strict: true,
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      required: ["question", "suggestions"],
      properties: {
        question: { type: "string", description: "One short question" },
        suggestions: {
          type: "array",
          description: "Two to four",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label", "reply"],
            properties: {
              label: { type: "string", description: "The chip's text, a few words" },
              reply: {
                type: "string",
                description: "The message sent when the user taps it, in their voice",
              },
            },
          },
        },
      },
    },
  },
  {
    name: "book_garage",
    description:
      "Book (or hand off) a garage option. REQUIRES a confirmation_token minted by the user's explicit Confirm tap on a proposed plan — calls without one are refused. Propose a plan instead if you have no token.",
    strict: true,
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      required: ["option_id"],
      properties: {
        option_id: { type: "string" },
        confirmation_token: { type: "string" },
      },
    },
  },
  {
    name: "start_session",
    description:
      "Start a paid street-meter session. REQUIRES a confirmation_token minted by the user's explicit Confirm tap — calls without one are refused. Propose a plan instead if you have no token.",
    strict: true,
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      required: ["zone", "duration_minutes"],
      properties: {
        zone: { type: "string", description: "Zone id, as returned by quote_street" },
        duration_minutes: { type: "integer", description: "1 to 720" },
        confirmation_token: { type: "string" },
      },
    },
  },
  {
    name: "get_history",
    description: "The user's recent parking sessions (zone, city, cost, when), newest first.",
    strict: true,
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      required: [] as string[],
      properties: {
        days: {
          type: "integer",
          description: "Look-back window in days, 1 to 90, default 14",
        },
      },
    },
  },
  {
    name: "explain_decision",
    description: "Plain-language explanation of one recorded decision by its id.",
    strict: true,
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      required: ["decision_id"],
      properties: { decision_id: { type: "string" } },
    },
  },
];

export class AssistantTools {
  constructor(private readonly deps: AssistantDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async audit(
    ctx: ToolContext,
    tool: string,
    input: unknown,
    rule: string,
    outcome: Record<string, unknown>,
  ): Promise<string> {
    const { id } = await this.deps.db.decision.create({
      data: {
        kind: "assistant_tool",
        inputs: { tool, input, conversationId: ctx.conversationId },
        rule,
        outcome,
        userId: ctx.userId,
      },
    });
    return id;
  }

  /** An edited itinerary re-priced on the server (routes/assistant.ts). */
  repriceStops(
    edited: EditedItineraryStop[],
    previous: ReadonlyMap<string, PreviousStop>,
  ): Promise<RepriceResult> {
    return repriceStops(this.deps, edited, previous);
  }

  /** Dispatch one model tool call. Unknown tools come back as errors the
   * model can read, never as throws that kill the turn. */
  async execute(ctx: ToolContext, name: string, input: unknown): Promise<ToolOutcome> {
    try {
      // The request's intent decides which tools are on (intentRouter.ts).
      // The loop only offers the model those; one called anyway is refused
      // here, before it runs, and the refusal is on the record.
      const intent = intentOf(stateOf(ctx));
      if (!toolAllowed(intent, name)) {
        await this.audit(ctx, name, input, "tool_not_available_for_intent", { intent });
        return {
          result: {
            error: "tool_not_available_for_intent",
            intent,
            instruction: toolOffInstruction(intent, name),
          },
        };
      }
      switch (name) {
        case "update_request":
          return await this.updateRequest(ctx, input);
        case "geocode_place":
          return await geocodePlace(
            this.deps,
            principalFor(ctx.userId),
            ctx,
            input as Record<string, unknown>,
          );
        case "search_garages":
          return await searchGarages(this.deps, principalFor(ctx.userId), ctx, input);
        case "quote_street":
          return await quoteStreet(this.deps, principalFor(ctx.userId), ctx, input);
        case "build_itinerary":
          return await buildItinerary(
            this.deps,
            principalFor(ctx.userId),
            ctx,
            input as Record<string, unknown>,
          );
        case "propose_plan":
          return await proposePlan(
            this.deps,
            principalFor(ctx.userId),
            ctx,
            input as Record<string, unknown>,
          );
        case "ask_user":
          return await this.askUser(ctx, input);
        case "book_garage":
          return await bookGarage(
            this.deps,
            principalFor(ctx.userId),
            ctx,
            input as Record<string, unknown>,
          );
        case "start_session":
          return await startSession(
            this.deps,
            principalFor(ctx.userId),
            ctx,
            input as Record<string, unknown>,
          );
        case "get_history":
          return await this.getHistory(ctx, input as Record<string, unknown>);
        case "explain_decision":
          return await this.explain(ctx, input as Record<string, unknown>);
        default:
          return { result: { error: `unknown tool ${name}` } };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
      await this.audit(ctx, name, input, "tool_error", { error: message });
      return { result: { error: message } };
    }
  }

  /**
   * update_request: apply the model's patch to the conversation's request
   * (requestState.ts decides what it means). Every call is audited with
   * the patch it sent and what came of it, refusals included, and counts
   * toward the per-turn limit — a malformed call is a call.
   */
  private async updateRequest(ctx: ToolContext, input: unknown): Promise<ToolOutcome> {
    const before = ctx.requestState ?? emptyState();
    const audit = (rule: string, outcome: Record<string, unknown>) =>
      this.deps.db.decision.create({
        data: {
          kind: "assistant_tool",
          inputs: { tool: "update_request", patch: input, conversationId: ctx.conversationId },
          rule,
          outcome,
          userId: ctx.userId,
        },
      });
    // This turn's message was a relax chip, and the server applied it: the
    // user changed exactly that. An edit on top of it could only be the
    // chip's words read as some other field.
    if (ctx.requestLock) {
      await audit("request_already_updated", {
        error: "request_already_updated",
        version: before.version,
        changed: ctx.requestLock.changed,
      });
      return {
        result: {
          error: "request_already_updated",
          changed: ctx.requestLock.changed,
          state: stateForModel(before),
          instruction:
            "The user's tap already changed the request this turn (`changed`), and nothing else about it changed. " +
            "Don't edit it: search the request as it stands.",
        },
      };
    }
    ctx.requestEdits = (ctx.requestEdits ?? 0) + 1;
    if (ctx.requestEdits > MAX_REQUEST_EDITS_PER_TURN) {
      await audit("too_many_edits", { error: "too_many_edits", version: before.version });
      return {
        result: {
          error: "too_many_edits",
          instruction:
            `The request was already edited ${MAX_REQUEST_EDITS_PER_TURN} times this turn. Don't edit it again: ` +
            "go on with the request as it stands (the last update_request result), or ask the user with ask_user.",
        },
      };
    }
    const parsed = parsePatch(input);
    if (!parsed.ok) {
      await audit("invalid_patch", { error: "invalid_patch", issues: parsed.issues });
      return {
        result: {
          error: "invalid_patch",
          issues: parsed.issues,
          instruction:
            'Send only what changed, flat, e.g. {"maxPriceUsd": 20, "reason": "under $20"}. ' +
            "Settable: intent, placeQuery, startsAt, durationMinutes, maxPriceUsd, maxWalkMinutes, kinds, entryType, covered, rank, prefer. " +
            "To remove one, name it in clear.",
        },
      };
    }
    const at = this.now();
    const applied = applyPatch(before, parsed.patch, ctx.utterance ?? "", at);
    if (!applied.ok) {
      if (applied.error === "unreadable_time") {
        await audit("unreadable_time", { error: "unreadable_time", value: applied.value });
        return {
          result: {
            error: "unreadable_time",
            value: applied.value,
            instruction: `Couldn't read that time. ${TIME_FORMAT_HINT} ${currentTimeLine(at)}`,
          },
        };
      }
      await audit("conflicting_patch", { error: "conflicting_patch", fields: applied.fields });
      return {
        result: {
          error: "invalid_patch",
          issues: applied.fields.map((f) => `${f} is both set and cleared`),
          instruction: "Set a field or clear it, not both.",
        },
      };
    }
    ctx.requestState = applied.state;
    const outcome = {
      version: applied.state.version,
      changed: applied.changed,
      overrides: applied.overrides,
    };
    // A note with no field is the live failure mode (the request written
    // into reason): say exactly that, so the next call puts it in fields.
    const empty = applied.changed.length === 0 && setsNothing(parsed.patch);
    await audit(
      applied.changed.length > 0 ? "request_updated" : empty ? "empty_patch" : "request_unchanged",
      outcome,
    );
    return {
      result: {
        ...outcome,
        state: stateForModel(applied.state),
        ...(empty
          ? {
              instruction:
                "This patch set no field, so nothing changed: reason is only a note. Put each change in its own field, " +
                'e.g. {"placeQuery": "Newbury Street", "startsAt": "2026-10-06T14:00:00-04:00", "durationMinutes": 120}.',
            }
          : applied.changed.length === 0
            ? { instruction: "Nothing changed: the request already says that." }
            : {}),
        ...(applied.overrides.length > 0
          ? {
              note: `The intent is ${applied.state.intent}: ${applied.overrides[0]!.why}. The server derives it; change startsAt or kinds to change it.`,
            }
          : {}),
      },
    };
  }

  /** A clarifying question with tappable answers; ends the turn like
   * propose_plan. */
  private async askUser(ctx: ToolContext, input: unknown): Promise<ToolOutcome> {
    const parsed = askSchema.safeParse(input);
    if (!parsed.success) {
      return {
        result: {
          error: "invalid ask",
          issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 6),
        },
      };
    }
    // "How long?" has one wording and one set of answers, whoever asks
    // (FR-45): a model that asks it itself — instead of searching and
    // letting the search ask — still gets the server's question and its
    // four chips, not answers of its own.
    if (asksAboutStay(parsed.data.question)) {
      await this.audit(ctx, "ask_user", input, "asked", {
        suggestions: STAY_SUGGESTIONS.length,
        stay: true,
      });
      return {
        result: { presented: true },
        ask: { question: STAY_QUESTION, suggestions: [...STAY_SUGGESTIONS], server: true },
      };
    }
    await this.audit(ctx, "ask_user", input, "asked", {
      suggestions: parsed.data.suggestions.length,
    });
    return { result: { presented: true }, ask: parsed.data };
  }

  private async getHistory(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutcome> {
    // The schema can't bound a strict tool's integer: clamp here.
    const days = Math.min(90, Math.max(1, input["days"] !== undefined ? num(input["days"]) : 14));
    const since = new Date(this.now().getTime() - days * 24 * 60 * 60_000);
    const sessions = await this.deps.db.session.findMany({
      where: { userId: ctx.userId, createdAt: { gte: since } },
    });
    const rows = sessions
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 30)
      .map((s) => ({
        when: s.createdAt.toISOString(),
        city: s.city,
        zoneId: s.zoneId,
        status: s.status,
        totalUsd: Math.round((Number(s.amountUsd ?? 0) + Number(s.feeUsd ?? 0)) * 100) / 100,
        minutes: s.purchasedMinutes,
        paymentSource: s.paymentSource ?? "provider_card",
      }));
    await this.audit(ctx, "get_history", { days }, "ok", { count: rows.length });
    return { result: { sessions: rows } };
  }

  private async explain(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutcome> {
    const id = String(input["decision_id"]);
    const found = await explainDecision(this.deps, principalFor(ctx.userId), { decisionId: id });
    if (!found.ok) {
      await this.audit(ctx, "explain_decision", input, "not_found", {});
      return { result: { error: "no such decision (or it belongs to another user)" } };
    }
    const { template } = found;
    // Phrasing runs on the cheap EXPLAIN_MODEL; the template is the
    // factual floor — a phrasing failure falls back to it, and the model
    // is told to add nothing the template doesn't say.
    let text = template;
    if (this.deps.explainModel) {
      try {
        const phrased = await this.deps.explainModel.create({
          system:
            "Rewrite the given parking-decision record as one or two friendly plain-English sentences. State only facts present in the input — never add, guess, or soften facts. No preamble.",
          messages: [{ role: "user", content: template }],
          // Room for the model's thinking (on by default on Claude Haiku
          // 5.5) before its one or two sentences.
          maxTokens: 1024,
        });
        // A paid call like any other: it counts toward this turn's spend.
        ctx.onModelUsage?.({
          model: phrased.model ?? "unknown",
          inputTokens: phrased.usage?.inputTokens ?? 0,
          outputTokens: phrased.usage?.outputTokens ?? 0,
        });
        const joined = phrased.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join(" ")
          .trim();
        if (joined.length > 0) text = joined;
      } catch {
        // Fall back to the template — an explanation must never fail the turn.
      }
    }
    await this.audit(ctx, "explain_decision", input, "ok", {
      phrased: text !== template,
    });
    return { result: { explanation: text } };
  }
}
