/**
 * PERSONAL-USE PROTOTYPE — this package drives ParkNYC's own web app with
 * the owner's account, for the owner's own parking only. It is not a
 * shipping integration: automating a consumer app sits outside its intended
 * use and likely its Terms of Service, acceptable only as a personal
 * experiment. Issue #37 tracks moving this package to a private repo; it
 * must move before any customer uses it.
 *
 * Optional LLM recovery hook, DISABLED by default. When ParkNYC shows a
 * screen the happy path doesn't recognize, this may ask a model for the
 * next action given the goal and the page's visible text + screenshot.
 * The happy path stays hardcoded; the model is for recovery only, and the
 * caller treats null as "no recovery — report ui_changed".
 */

export interface RecoveryContext {
  /** What the flow was trying to do, e.g. "start a 90-minute session in zone 110436". */
  goal: string;
  pageText: string;
  screenshotBase64?: string;
}

export type RecoveryAction =
  | { kind: "click"; role: string; name: string }
  | { kind: "fill"; role: string; name: string; value: string }
  | { kind: "abort"; reason: string };

/** Gate: EXECUTOR_LLM_RECOVERY=true turns the hook on. Anything else: off. */
export function llmRecoveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["EXECUTOR_LLM_RECOVERY"] === "true";
}

/**
 * Stubbed call site. TODO: when EXECUTOR_LLM_RECOVERY is true, call the
 * Anthropic API with ctx.goal + ctx.pageText (+ the screenshot), constrain
 * the reply to a RecoveryAction, and let the client attempt at most one
 * such action before re-checking for a known screen. Until implemented it
 * always answers null, so the flow reports ui_changed exactly as it would
 * with the flag off. Never let a recovery action confirm a payment — abort
 * instead if the pay step itself is the unrecognized screen.
 */
export async function suggestRecovery(ctx: RecoveryContext): Promise<RecoveryAction | null> {
  if (!llmRecoveryEnabled()) return null;
  void ctx;
  return null;
}
