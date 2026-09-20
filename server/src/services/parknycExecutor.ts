/**
 * Stub for the real ParkNYC executor. Phase 5 replaces this with a bridge
 * to the Playwright package in executor/ (per the repo rule, that package
 * is the only module allowed to touch ParkNYC; this file will be its sole
 * importer). Until then every call answers with a typed not_implemented
 * error, so a session attempted outside dry run fails loudly instead of
 * pretending money moved.
 */

import type { Executor, ExecutorResult } from "./executor.js";

const NOT_IMPLEMENTED: ExecutorResult = {
  ok: false,
  code: "not_implemented",
  message: "real ParkNYC executor lands in Phase 5; run with dry run on",
};

export class ParkNycExecutorStub implements Executor {
  async startSession(): Promise<ExecutorResult> {
    return NOT_IMPLEMENTED;
  }

  async extendSession(): Promise<ExecutorResult> {
    return NOT_IMPLEMENTED;
  }

  async stopSession(): Promise<ExecutorResult> {
    return NOT_IMPLEMENTED;
  }
}
