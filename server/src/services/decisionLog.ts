/**
 * One structured log line per decisions row, whoever writes it (routes,
 * extension worker, card janitor): wraps AppDb.decision.create once, in
 * index.ts, so no call site can forget. Logs identifiers and the rule —
 * never inputs or outcome, which can carry ui_changed screenshots.
 */

import type { AppDb } from "../db.js";

export interface DecisionLogger {
  info(payload: Record<string, unknown>, message: string): void;
}

export function withDecisionLogging(db: AppDb, log: DecisionLogger): AppDb {
  return {
    ...db,
    decision: {
      ...db.decision,
      create: async (args) => {
        const row = await db.decision.create(args);
        log.info(
          {
            decision: {
              id: row.id,
              kind: args.data.kind,
              rule: args.data.rule,
              userId: args.data.userId ?? null,
              sessionId: args.data.sessionId ?? null,
              parkedEventId: args.data.parkedEventId ?? null,
            },
          },
          "decision",
        );
        return row;
      },
    },
  };
}
