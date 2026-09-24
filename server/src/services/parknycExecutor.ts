/**
 * Bridge to the real executors — the Playwright package in executor/
 * (ParkNYC/Flowbird and ParkBoston/Passport clients). Per the repo rule,
 * this file is that package's ONLY importer; nothing else in the server may
 * touch it.
 *
 * The package is loaded lazily, on the first real (non-dry-run) call:
 * server boot, tests, and vitest runs never need executor/dist to exist or
 * Playwright's browser to be installed. Only `pnpm -C server build` (tsc)
 * needs `pnpm -C executor run build` to have run first, for the .d.ts.
 *
 * Auth is per user now: makeUserExecutorProvider loads the caller's linked
 * provider account, decrypts its cookie state, and runs the call in a
 * fresh Playwright context on the package's warm shared browser. The old
 * single-secret PARKNYC_STATE_PATH/JSON plumbing is gone. An auth_expired
 * result marks the account expired and pushes a re-link request.
 */

import type { AppDb } from "../db.js";
import { cityForZone, providerForCity, providerStatusUsable } from "../providers/registry.js";
import type { ProviderId } from "../providers/registry.js";
import { providerRelinkPush } from "./apns.js";
import type { PushSender } from "./apns.js";
import type { StateCrypto } from "./crypto.js";
import type { Executor, ExecutorContext, ExecutorProvider, ExecutorResult } from "./executor.js";
import type {
  ProviderAccountOps,
  ProviderOpsFactory,
  ProviderStorageState,
} from "./providerOps.js";

export interface ParkNycOptions {
  /** Vehicle used when a call doesn't name a plate (PARKNYC_PLATE). */
  defaultPlate?: string;
  /** Unexpected-screen evidence is also written here (EXECUTOR_CAPTURE_DIR). */
  captureDir?: string;
  /** Every step of every real Passport flow saved as fixture screens here
   * (EXECUTOR_STEP_CAPTURE_DIR) — for verification runs; off by default. */
  stepCaptureDir?: string;
}

/** One line of an arbitrary error — multi-line Playwright call logs can
 * embed resolved-element HTML, which has no business in a decisions row. */
function firstLine(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.split("\n")[0] ?? text;
}

/** Lazily-loaded executor over a decrypted per-user storage state. */
function makeLazyExecutor(provider: ProviderId, load: () => Promise<Executor>): Executor {
  let real: Promise<Executor> | null = null;
  const call = async (
    fn: (executor: Executor) => Promise<ExecutorResult>,
  ): Promise<ExecutorResult> => {
    try {
      real ??= load();
      return await fn(await real);
    } catch (err) {
      // A missing build or browser must fail the session loudly and typed,
      // not crash the request handler.
      return {
        ok: false,
        code: "unknown",
        // First line only: a multi-line Playwright call log can embed page
        // state; the capture on the decisions row is the full story.
        message: `${provider} executor failed to load or crashed: ${firstLine(err)}`,
      };
    }
  };
  return {
    startSession: (args) => call((e) => e.startSession(args)),
    extendSession: (args) => call((e) => e.extendSession(args)),
    stopSession: (args) => call((e) => e.stopSession(args)),
  };
}

/** ParkNYC session executor over a decrypted per-user storage state. */
/** Graceful-shutdown hook: close the package's warm shared Chromium so a
 * deploy never leaks the browser process. Loads the package the same lazy
 * way as everything else here — a server that never ran a real call skips
 * the import entirely (dynamic import of an already-loaded module is a
 * cache hit, so this never launches anything). */
export async function closeExecutorBrowser(): Promise<void> {
  try {
    const mod = await import("executor");
    await mod.closeWarmBrowser();
  } catch {
    // No executor build (dev, tests) — nothing to close.
  }
}

export function makeParkNycExecutor(
  state: ProviderStorageState,
  options: ParkNycOptions,
): Executor {
  return makeLazyExecutor("parknyc", () =>
    import("executor").then((mod) =>
      mod.createParkNycExecutor({
        storageState: state,
        ...(options.defaultPlate ? { defaultPlate: options.defaultPlate } : {}),
        ...(options.captureDir ? { captureDir: options.captureDir } : {}),
      }),
    ),
  );
}

/** ParkBoston (Passport) session executor — same shape, second provider. */
export function makePassportExecutor(
  state: ProviderStorageState,
  options: ParkNycOptions,
): Executor {
  return makeLazyExecutor("passport", () =>
    import("executor").then((mod) =>
      mod.createPassportExecutor({
        storageState: state,
        ...(options.captureDir ? { captureDir: options.captureDir } : {}),
        ...(options.stepCaptureDir ? { stepCaptureDir: options.stepCaptureDir } : {}),
      }),
    ),
  );
}

/** The real per-provider executor factory; injectable so unit tests can
 * stop at this seam instead of importing the Playwright package. */
export type RealExecutorFactory = (
  provider: ProviderId,
  state: ProviderStorageState,
  options: ParkNycOptions,
) => Executor;

export const defaultRealExecutorFactory: RealExecutorFactory = (provider, state, options) =>
  provider === "passport"
    ? makePassportExecutor(state, options)
    : makeParkNycExecutor(state, options);

/**
 * Account-ops factory for the link/setup-card/wallet endpoints. Both
 * registry providers have executors now (ParkNYC and Passport); the routes
 * still turn a thrown factory into provider_not_supported for any future
 * placeholder.
 */
export function makeProviderOpsFactory(options: ParkNycOptions): ProviderOpsFactory {
  return (provider: ProviderId, state: ProviderStorageState): ProviderAccountOps => {
    let real: Promise<ProviderAccountOps> | null = null;
    const load = (): Promise<ProviderAccountOps> => {
      real ??= import("executor").then((mod) => {
        const opts = {
          storageState: state,
          ...(options.captureDir ? { captureDir: options.captureDir } : {}),
        };
        return provider === "passport"
          ? mod.createPassportAccountOps(opts)
          : mod.createParkNycAccountOps(opts);
      });
      return real;
    };
    const guard = async <T>(fn: (ops: ProviderAccountOps) => Promise<T>): Promise<T> => {
      try {
        return await fn(await load());
      } catch (err) {
        return {
          ok: false,
          code: "unknown",
          message: `parknyc account ops failed to load or crashed: ${firstLine(err)}`,
        } as T;
      }
    };
    return {
      verifyAccount: () => guard((ops) => ops.verifyAccount()),
      setupCard: (card) => guard((ops) => ops.setupCard(card)),
      removeCard: (last4) => guard((ops) => ops.removeCard(last4)),
      topupWallet: (amountUsd) => guard((ops) => ops.topupWallet(amountUsd)),
      readSavedCard: () => guard((ops) => ops.readSavedCard()),
    };
  };
}

export interface UserExecutorProviderConfig {
  db: AppDb;
  /** Absent when PROVIDER_STATE_KEY isn't set; real calls then fail typed. */
  stateCrypto?: StateCrypto;
  dryRunExecutor: Executor;
  sendPush: PushSender;
  defaultPlate?: string;
  captureDir?: string;
  stepCaptureDir?: string;
  warn: (msg: string) => void;
  /** Injectable for tests; defaults to the real Playwright-backed factory. */
  makeRealExecutor?: RealExecutorFactory;
}

/** An executor whose every call fails the same typed way. */
function failingExecutor(code: "auth_expired" | "unknown", message: string): Executor {
  const result = async (): Promise<ExecutorResult> => ({ ok: false, code, message });
  return { startSession: result, extendSession: result, stopSession: result };
}

/**
 * The executorFor seam, per user and city. Dry-run calls get the
 * DryRunExecutor and never touch a provider account. Real calls resolve
 * city → provider → the user's linked account, decrypt its cookie state,
 * and run on a fresh context. auth_expired flips the account to expired
 * and pushes a re-link request — the session failure itself still flows
 * back through the normal typed-error path.
 */
export function makeUserExecutorProvider(config: UserExecutorProviderConfig): ExecutorProvider {
  return (ctx: ExecutorContext): Executor => {
    if (ctx.dryRun) return config.dryRunExecutor;

    const provider = providerForCity(ctx.city);
    if (!provider) {
      return failingExecutor("unknown", `no parking provider for city "${ctx.city ?? "?"}"`);
    }
    if (!config.stateCrypto) {
      return failingExecutor(
        "unknown",
        "PROVIDER_STATE_KEY is not set — cannot decrypt linked provider accounts",
      );
    }
    const crypto = config.stateCrypto;

    const wrap = (fn: (executor: Executor) => Promise<ExecutorResult>) => {
      return async (): Promise<ExecutorResult> => {
        const account = await config.db.providerAccount.findUnique({
          where: { userId_provider: { userId: ctx.userId, provider: provider.id } },
        });
        if (!account || !providerStatusUsable(account.status) || !account.stateEncrypted) {
          return {
            ok: false,
            code: "auth_expired",
            message: `${provider.displayName} account is not linked`,
          };
        }
        let state: ProviderStorageState;
        try {
          state = JSON.parse(crypto.open(account.stateEncrypted)) as ProviderStorageState;
        } catch {
          return {
            ok: false,
            code: "auth_expired",
            message: "stored provider state could not be decrypted (key rotated?)",
          };
        }
        const executor = (config.makeRealExecutor ?? defaultRealExecutorFactory)(
          provider.id,
          state,
          {
            ...(config.defaultPlate ? { defaultPlate: config.defaultPlate } : {}),
            ...(config.captureDir ? { captureDir: config.captureDir } : {}),
            ...(config.stepCaptureDir ? { stepCaptureDir: config.stepCaptureDir } : {}),
          },
        );
        const result = await fn(executor);
        if (!result.ok && result.code === "auth_expired") {
          // The cookies died. Mark the account and ask the user to re-link;
          // failures here must not mask the executor result.
          try {
            await config.db.providerAccount.update({
              where: { userId_provider: { userId: ctx.userId, provider: provider.id } },
              data: { status: "expired" },
            });
            await config.sendPush(
              ctx.userId,
              providerRelinkPush({ provider: provider.id, displayName: provider.displayName }),
            );
          } catch (err) {
            config.warn(`failed to mark ${provider.id} account expired: ${String(err)}`);
          }
        }
        return result;
      };
    };

    return {
      startSession: (args) => wrap((e) => e.startSession(args))(),
      extendSession: (args) => wrap((e) => e.extendSession(args))(),
      stopSession: (args) => wrap((e) => e.stopSession(args))(),
    };
  };
}

export { cityForZone };
