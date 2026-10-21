/**
 * The one decision writer. Wraps AppDb.decision.create once, in index.ts,
 * so no call site can forget two things: the row says who acted (`actor`
 * and `agentKeyId`, from the principal the request or job pass runs as,
 * services/principal.ts), and one structured log line goes out per row,
 * whoever writes it (routes, extension worker, card janitor). Logs
 * identifiers and the rule — never inputs or outcome, which can carry
 * ui_changed screenshots. A script writing through bare Prisma gets the
 * column's default (`user`) instead.
 */

import type { AppDb } from "../db.js";
import { currentPrincipal } from "./principal.js";

export interface DecisionLogger {
  info(payload: Record<string, unknown>, message: string): void;
}

export function withDecisionLogging(db: AppDb, log: DecisionLogger): AppDb {
  return {
    ...db,
    decision: {
      ...db.decision,
      create: async (args) => {
        const principal = currentPrincipal();
        const data = {
          ...args.data,
          actor: args.data.actor ?? principal?.actor ?? "user",
          ...(args.data.agentKeyId === undefined && principal?.agentKeyId !== undefined
            ? { agentKeyId: principal.agentKeyId }
            : {}),
        };
        const row = await db.decision.create({ ...args, data });
        log.info(
          {
            decision: {
              id: row.id,
              kind: data.kind,
              rule: data.rule,
              actor: data.actor,
              userId: data.userId ?? null,
              sessionId: data.sessionId ?? null,
              parkedEventId: data.parkedEventId ?? null,
            },
          },
          "decision",
        );
        return row;
      },
    },
  };
}
