/**
 * Bridge to the real ParkNYC executor — the Playwright package in
 * executor/. Per the repo rule, this file is that package's ONLY importer;
 * nothing else in the server may touch it.
 *
 * The package is loaded lazily, on the first real (non-dry-run) call:
 * server boot, tests, and vitest runs never need executor/dist to exist or
 * Playwright's browser to be installed. Only `pnpm -C server build` (tsc)
 * needs `pnpm -C executor build` to have run first, for the .d.ts.
 *
 * makeExecutorProvider is the seam index.ts wires: the real executor is
 * used only when the env DRY_RUN is false AND PARKNYC_STATE_PATH is set;
 * everything else — including every per-call effective-dry-run flip via
 * PUT /policy — gets the DryRunExecutor.
 */

import type { Executor, ExecutorProvider, ExecutorResult } from "./executor.js";

export interface ParkNycExecutorConfig {
  /** Path to the Playwright storageState JSON (PARKNYC_STATE_PATH). */
  statePath: string;
  /** Vehicle used when a call doesn't name a plate (PARKNYC_PLATE). */
  defaultPlate?: string;
  /** Unexpected-screen evidence is also written here (EXECUTOR_CAPTURE_DIR). */
  captureDir?: string;
}

/** Lazily-loading wrapper around executor/'s createParkNycExecutor. */
export function makeParkNycExecutor(config: ParkNycExecutorConfig): Executor {
  let real: Promise<Executor> | null = null;
  const load = (): Promise<Executor> => {
    real ??= import("executor").then((mod) =>
      mod.createParkNycExecutor({
        statePath: config.statePath,
        ...(config.defaultPlate ? { defaultPlate: config.defaultPlate } : {}),
        ...(config.captureDir ? { captureDir: config.captureDir } : {}),
      }),
    );
    return real;
  };
  const call = async (
    fn: (executor: Executor) => Promise<ExecutorResult>,
  ): Promise<ExecutorResult> => {
    try {
      return await fn(await load());
    } catch (err) {
      // A missing build or browser must fail the session loudly and typed,
      // not crash the request handler.
      return {
        ok: false,
        code: "unknown",
        message: `parknyc executor failed to load or crashed: ${String(err)}`,
      };
    }
  };
  return {
    startSession: (args) => call((e) => e.startSession(args)),
    extendSession: (args) => call((e) => e.extendSession(args)),
    stopSession: (args) => call((e) => e.stopSession(args)),
  };
}

export interface ExecutorProviderConfig {
  /** The env DRY_RUN switch (not the per-call effective flag). */
  envDryRun: boolean;
  /** PARKNYC_STATE_PATH; without it there is no way to reach ParkNYC. */
  statePath?: string;
  defaultPlate?: string;
  captureDir?: string;
  dryRunExecutor: Executor;
  warn: (msg: string) => void;
}

/**
 * The executorFor seam. The real ParkNYC executor is eligible only when
 * env DRY_RUN is false and a storage-state path is configured; the per-call
 * dryRun flag (env || policy.json, re-read every call) then still picks the
 * DryRunExecutor whenever it is true. env DRY_RUN=true wins over everything
 * — belt and braces on the money path.
 */
export function makeExecutorProvider(config: ExecutorProviderConfig): ExecutorProvider {
  if (config.envDryRun || !config.statePath) {
    // Warn lazily (once, on first use): the provider is built before the
    // logger exists at boot.
    let warned = false;
    return () => {
      if (!config.envDryRun && !warned) {
        warned = true;
        config.warn(
          "DRY_RUN=false but PARKNYC_STATE_PATH is not set — falling back to the " +
            "dry-run executor. Sessions will be recorded as real without moving money; " +
            "run `pnpm -C executor login` and set PARKNYC_STATE_PATH to go live.",
        );
      }
      return config.dryRunExecutor;
    };
  }
  const real = makeParkNycExecutor({
    statePath: config.statePath,
    ...(config.defaultPlate ? { defaultPlate: config.defaultPlate } : {}),
    ...(config.captureDir ? { captureDir: config.captureDir } : {}),
  });
  return (dryRun) => (dryRun ? config.dryRunExecutor : real);
}
