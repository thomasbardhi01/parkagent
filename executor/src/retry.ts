/**
 * One retry on a dead browser. The warm Chromium can die between or
 * during calls (crash, OOM); warmBrowser relaunches lazily on the next
 * use, so a single retry against a fresh client/context very likely
 * succeeds. Anything that fails twice — or fails for any other reason —
 * surfaces unchanged. Never retries provider-side failures: paying a
 * meter twice is worse than failing loudly.
 */

import { isBrowserCrash } from "./parknyc/classify.js";
import type { ExecutorResult } from "./types.js";

function crashed(result: ExecutorResult): boolean {
  return !result.ok && result.code === "browser_crashed";
}

/**
 * Run `attempt` (which must build a FRESH client per invocation); if the
 * browser died — typed `browser_crashed`, or thrown from outside the
 * client's own catch (open/newContext) — run it once more.
 */
export async function withBrowserCrashRetry(
  attempt: () => Promise<ExecutorResult>,
): Promise<ExecutorResult> {
  const once = async (): Promise<ExecutorResult> => {
    try {
      return await attempt();
    } catch (err) {
      if (!isBrowserCrash(err)) throw err;
      const message = err instanceof Error ? err.message.split("\n")[0]! : String(err);
      return { ok: false, code: "browser_crashed", message };
    }
  };
  const first = await once();
  if (!crashed(first)) return first;
  const second = await once();
  return second;
}
