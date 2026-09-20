/**
 * Bridge to the real ParkNYC executor — the Playwright package in
 * executor/. Per the repo rule, this file is that package's ONLY importer;
 * nothing else in the server may touch it.
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
import { cityForZone, providerForCity } from "../providers/registry.js";
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
}

/** Session executor over a decrypted per-user storage state. */
export function makeParkNycExecutor(
  state: ProviderStorageState,
  options: ParkNycOptions,
): Executor {
  let real: Promise<Executor> | null = null;
  const load = (): Promise<Executor> => {
    real ??= import("executor").then((mod) =>
      mod.createParkNycExecutor({
        storageState: state,
        ...(options.defaultPlate ? { defaultPlate: options.defaultPlate } : {}),
        ...(options.captureDir ? { captureDir: options.captureDir } : {}),
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

/**
 * Account-ops factory for the link/setup-card/wallet endpoints. Throws for
 * providers without an executor (the Boston placeholder) — the routes turn
 * that into provider_not_supported.
 */
export function makeProviderOpsFactory(options: ParkNycOptions): ProviderOpsFactory {
  return (provider: ProviderId, state: ProviderStorageState): ProviderAccountOps => {
    if (provider !== "parknyc") {
      throw new Error(`no executor for provider "${provider}"`);
    }
    let real: Promise<ProviderAccountOps> | null = null;
    const load = (): Promise<ProviderAccountOps> => {
      real ??= import("executor").then((mod) =>
        mod.createParkNycAccountOps({
          storageState: state,
          ...(options.captureDir ? { captureDir: options.captureDir } : {}),
        }),
      );
      return real;
    };
    const guard = async <T>(fn: (ops: ProviderAccountOps) => Promise<T>): Promise<T> => {
      try {
        return await fn(await load());
      } catch (err) {
        return {
          ok: false,
          code: "unknown",
          message: `parknyc account ops failed to load or crashed: ${String(err)}`,
        } as T;
      }
    };
    return {
      verifyAccount: () => guard((ops) => ops.verifyAccount()),
      setupCard: (card) => guard((ops) => ops.setupCard(card)),
      removeCard: (last4) => guard((ops) => ops.removeCard(last4)),
      topupWallet: (amountUsd) => guard((ops) => ops.topupWallet(amountUsd)),
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
  warn: (msg: string) => void;
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
    if (provider.id !== "parknyc") {
      return failingExecutor("unknown", `no executor for provider "${provider.id}"`);
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
        if (!account || account.status !== "linked" || !account.stateEncrypted) {
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
        const executor = makeParkNycExecutor(state, {
          ...(config.defaultPlate ? { defaultPlate: config.defaultPlate } : {}),
          ...(config.captureDir ? { captureDir: config.captureDir } : {}),
        });
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
