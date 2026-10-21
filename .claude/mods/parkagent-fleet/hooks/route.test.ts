import { expect, test } from "claude-code/testing";

import { decideRoute } from "./route";

// Pure routing decisions. `~` is explicit and always routes; the never-route
// list vetoes only the automatic, intent-based path.

test("a leading ~ always routes and is stripped", () => {
  expect(decideRoute("~ what is this", false)).toEqual({
    route: true,
    cleaned: "what is this",
    reason: "tilde",
  });
  expect(decideRoute("  ~do the thing", false).route).toBe(true);
  // Even naming a money file: the user asked for it explicitly.
  expect(decideRoute("~ explain server/src/services/wallet.ts", false).route).toBe(true);
});

test("read-only intents route when nothing vetoes them", () => {
  expect(decideRoute("what does build_zones.py do", false).reason).toBe("intent");
  expect(decideRoute("where is the zone number typed", false).reason).toBe("intent");
  expect(decideRoute("explain the detector fusion", false).reason).toBe("intent");
  expect(decideRoute("summarize docs/reliability.md", false).reason).toBe("intent");
  // "why is this failing" needs a pasted log (a newline) to count as read-only.
  expect(decideRoute("why is this failing", false).route).toBe(false);
  expect(decideRoute("why is this failing\n  at foo (bar.ts:3)", false).reason).toBe("intent");
});

test("the never-route list vetoes the automatic path", () => {
  expect(decideRoute("explain server/src/services/wallet.ts", false).reason).toBe("vetoed");
  expect(decideRoute("what does server/src/services/sessions.ts do", false).reason).toBe("vetoed");
  expect(decideRoute("where is server/src/routes/parked.ts", false).reason).toBe("vetoed");
  expect(decideRoute("explain prisma/schema.prisma", false).reason).toBe("vetoed");
  expect(decideRoute("what does the deploy step do", false).reason).toBe("vetoed");
  expect(decideRoute("summarize how we migrate the db", false).reason).toBe("vetoed");
  expect(decideRoute("what does the daily cap mean", false).reason).toBe("vetoed");
});

test("ordinary prompts and /route off do not route", () => {
  expect(decideRoute("implement the new wallet endpoint", false).route).toBe(false);
  expect(decideRoute("fix the failing test in zones.test.ts", false).route).toBe(false);
  expect(decideRoute("~ anything", true)).toEqual({ route: false, cleaned: null, reason: "off" });
  expect(decideRoute("what does this do", true).reason).toBe("off");
});
