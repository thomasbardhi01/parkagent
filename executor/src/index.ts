/**
 * PERSONAL-USE PROTOTYPE — this package drives ParkNYC's own web app with
 * the owner's account, for the owner's own parking only. It is not a
 * shipping integration: automating a consumer app sits outside its intended
 * use and likely its Terms of Service, acceptable only as a personal
 * experiment. Issue #37 tracks moving this package to a private repo; it
 * must move before any customer uses it.
 *
 * Public surface. The server's parknycExecutor.ts bridge is the ONLY
 * intended importer (repo non-negotiable: nothing else touches ParkNYC).
 * createParkNycExecutor returns an object matching the server's Executor
 * protocol; each call runs in a fresh browser so a wedged page can't
 * poison the next session.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { warmBrowser } from "./browser.js";
import { withBrowserCrashRetry } from "./retry.js";
import { ParkNycClient } from "./parknyc/client.js";
import { PassportClient } from "./passport/client.js";
import type { PassportClientOptions } from "./passport/client.js";
import type {
  AccountOpOptions,
  AccountOps,
  Executor,
  ExecutorResult,
  ExtendSessionArgs,
  ProviderOpError,
  StartSessionArgs,
  StopSessionArgs,
  StorageStateValue,
} from "./types.js";

export type {
  AccountOpOptions,
  AccountOps,
  CardFormDetails,
  Executor,
  ExecutorDiagnostics,
  ExecutorError,
  ExecutorErrorCode,
  ExecutorOk,
  ExecutorResult,
  ExtendSessionArgs,
  ProviderOpError,
  ProviderOpErrorCode,
  ProviderOpResult,
  ReadSavedCardResult,
  StartSessionArgs,
  StopSessionArgs,
  StorageStateValue,
  TopupWalletResult,
  VerifyAccountResult,
} from "./types.js";
export { closeWarmBrowser, warmBrowser } from "./browser.js";
export { withBrowserCrashRetry } from "./retry.js";
export { gotoWithRetry, isTransientNavigationError } from "./navigate.js";
export { ParkNycClient } from "./parknyc/client.js";
export type { ParkNycClientOptions } from "./parknyc/client.js";
export { PassportClient } from "./passport/client.js";
export type { PassportClientOptions } from "./passport/client.js";
export {
  findVehicleOption,
  isParkingDeniedModal,
  normalizeStreet,
  parsePassportReceipt,
  parseVehicleChooser,
  parseZoneEntryHtml,
  parseZoneInfoHtml,
  parseZoneInfoTerms,
  streetsMatch,
} from "./passport/parse.js";
export type {
  PassportReceipt,
  VehicleChooserScreen,
  VehicleOption,
  ZoneEntryScreen,
  ZonePanel,
} from "./passport/parse.js";
export type { ProviderZoneTerms, ZoneResolution } from "./types.js";

export interface ParkNycExecutorOptions {
  /** Playwright storageState file (from `pnpm -C executor run login`). */
  statePath?: string;
  /** Storage state as a value — the per-user linked cookies, decrypted by
   * the server per call. Exactly one of statePath/storageState. */
  storageState?: StorageStateValue;
  /** Vehicle used when a call doesn't name a plate (PARKNYC_PLATE). */
  defaultPlate?: string;
  /** Unexpected-screen evidence is also written here as files. */
  captureDir?: string;
  headless?: boolean;
}

/** One client per call: fresh context on the warm shared browser, so one
 * user's cookies never leak into the next call's context. */
function makeClient(options: ParkNycExecutorOptions): ParkNycClient {
  return new ParkNycClient({
    ...(options.statePath ? { statePath: options.statePath } : {}),
    ...(options.storageState ? { storageState: options.storageState } : {}),
    sharedBrowser: true,
    headless: options.headless ?? true,
    ...(options.captureDir ? { captureDir: options.captureDir } : {}),
  });
}

export function createParkNycExecutor(options: ParkNycExecutorOptions): Executor {
  // Each attempt gets a fresh client/context; withBrowserCrashRetry runs a
  // second attempt if the shared Chromium died under the first (warmBrowser
  // relaunches lazily). Caveat, accepted: a crash after the pay click but
  // before the receipt parse would retry a paid session — that window is
  // milliseconds against seconds of navigation, and the alternative is
  // every crash costing an unpaid meter.
  function withClient(fn: (client: ParkNycClient) => Promise<ExecutorResult>) {
    return withBrowserCrashRetry(async () => {
      const client = makeClient(options);
      try {
        return await fn(client);
      } finally {
        await client.close();
      }
    });
  }

  return {
    startSession: (args: StartSessionArgs) =>
      withClient((c) =>
        c.startSession(
          args.zoneNumber,
          args.vehicle?.plate ?? args.plate ?? options.defaultPlate,
          args.minutes,
          // Car coordinates enable the non-fatal map cross-check; the
          // expected street rides along as decision evidence.
          args.carLat !== undefined && args.carLng !== undefined
            ? {
                carLat: args.carLat,
                carLng: args.carLng,
                expectedStreet: args.expectedStreet ?? null,
              }
            : undefined,
        ),
      ),
    extendSession: (args: ExtendSessionArgs) =>
      withClient((c) => c.extendSession(args.providerSessionId, args.minutes)),
    stopSession: (args: StopSessionArgs) =>
      withClient((c) => c.stopSession(args.providerSessionId)),
  };
}

// ---------------------------------------------------------------------------
// Passport (ParkBoston) — same protocol, second provider. Passport runs the
// same white-label web app for many cities; baseUrl swaps the city.

export interface PassportExecutorOptions {
  /** Playwright storageState file (from `pnpm -C executor run login -- --provider passport`). */
  statePath?: string;
  /** Storage state as a value — the per-user linked cookies. */
  storageState?: StorageStateValue;
  /** Passport city base URL; defaults to ParkBoston (see passport/selectors.ts). */
  baseUrl?: string;
  captureDir?: string;
  /** When set, EVERY step of every flow is saved as NN-<step>.html/.png
   * under a per-call subdirectory here (like `run record` does) — how a
   * server-driven real run captures fixture screens. Off by default. */
  stepCaptureDir?: string;
  headless?: boolean;
}

function makePassportClient(options: PassportExecutorOptions): PassportClient {
  let stepCapture: Pick<PassportClientOptions, "onStep" | "tracePath" | "log"> = {};
  if (options.stepCaptureDir) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outDir = join(options.stepCaptureDir, `passport-${stamp}`);
    mkdirSync(outDir, { recursive: true });
    let stepIndex = 0;
    stepCapture = {
      tracePath: join(outDir, "trace.zip"),
      log: (message) => {
        appendFileSync(join(outDir, "clicks.log"), `${message}\n`);
      },
      onStep: async (name, page) => {
        stepIndex += 1;
        const prefix = join(outDir, `${String(stepIndex).padStart(2, "0")}-${name}`);
        writeFileSync(`${prefix}.html`, await page.content());
        await page.screenshot({ path: `${prefix}.png`, fullPage: true }).catch(() => {});
      },
    };
  }
  return new PassportClient({
    ...(options.statePath ? { statePath: options.statePath } : {}),
    ...(options.storageState ? { storageState: options.storageState } : {}),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    sharedBrowser: true,
    headless: options.headless ?? true,
    ...(options.captureDir ? { captureDir: options.captureDir } : {}),
    ...stepCapture,
  });
}

export function createPassportExecutor(options: PassportExecutorOptions): Executor {
  // Same one-retry-on-dead-browser semantics as the ParkNYC executor.
  function withClient(fn: (client: PassportClient) => Promise<ExecutorResult>) {
    return withBrowserCrashRetry(async () => {
      const client = makePassportClient(options);
      try {
        return await fn(client);
      } finally {
        await client.close();
      }
    });
  }

  return {
    // No map in the ParkBoston web app (2026-09-21 recording): the zone
    // number is required and typed into the Enter Zone screen; car
    // coordinates are ignored here (they only feed ParkNYC's cross-check).
    // The vehicle (plate + state) picks the button on the Vehicles chooser.
    startSession: (args: StartSessionArgs) =>
      withClient((c) =>
        c.startSession(
          args.zoneNumber,
          args.vehicle ?? (args.plate !== undefined ? { plate: args.plate } : undefined),
          args.minutes,
        ),
      ),
    extendSession: (args: ExtendSessionArgs) =>
      withClient((c) => c.extendSession(args.providerSessionId, args.minutes)),
    stopSession: (args: StopSessionArgs) =>
      withClient((c) => c.stopSession(args.providerSessionId)),
  };
}

/** Account operations against a linked Passport account. */
export function createPassportAccountOps(options: PassportExecutorOptions): AccountOps {
  const withClient = <T extends { ok: boolean }>(
    fn: (client: PassportClient) => Promise<T>,
    budget?: AccountOpOptions,
  ) => withBudget(makePassportClient(options), fn, budget);

  return {
    verifyAccount: (budget) => withClient((c) => c.verifyAccount(budget), budget),
    setupCard: (card) => withClient((c) => c.setupCard(card)),
    removeCard: (last4) => withClient((c) => c.removeCard(last4)),
    topupWallet: (amountUsd) => withClient((c) => c.topupWallet(amountUsd)),
    readSavedCard: (budget) => withClient((c) => c.readSavedCard(budget), budget),
  };
}

/** Account operations against a linked ParkNYC account (verify cookies,
 * card setup/removal, wallet top-up). Same isolation as the executor. */
export function createParkNycAccountOps(options: ParkNycExecutorOptions): AccountOps {
  const withClient = <T extends { ok: boolean }>(
    fn: (client: ParkNycClient) => Promise<T>,
    budget?: AccountOpOptions,
  ) => withBudget(makeClient(options), fn, budget);

  return {
    verifyAccount: (budget) => withClient((c) => c.verifyAccount(budget), budget),
    setupCard: (card) => withClient((c) => c.setupCard(card)),
    removeCard: (last4) => withClient((c) => c.removeCard(last4)),
    topupWallet: (amountUsd) => withClient((c) => c.topupWallet(amountUsd)),
    readSavedCard: (budget) => withClient((c) => c.readSavedCard(budget), budget),
  };
}

/**
 * Run one account op on its own client, under the caller's budget. When
 * the budget runs out (or the caller aborts) the client's context is
 * closed, so the browser work stops rather than running on unseen, and the
 * answer is a typed "timeout".
 */
export async function withBudget<C extends { close(): Promise<void> }, T extends { ok: boolean }>(
  client: C,
  fn: (client: C) => Promise<T>,
  budget?: AccountOpOptions,
): Promise<T> {
  let expired = false;
  const expire = () => {
    expired = true;
    void client.close();
  };
  const timer = budget?.budgetMs !== undefined ? setTimeout(expire, budget.budgetMs) : null;
  if (budget?.signal?.aborted) expire();
  budget?.signal?.addEventListener("abort", expire, { once: true });
  try {
    const result = await fn(client);
    if (expired) return timedOut(budget) as unknown as T;
    return result;
  } catch (err) {
    if (expired) return timedOut(budget) as unknown as T;
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    budget?.signal?.removeEventListener("abort", expire);
    await client.close();
  }
}

function timedOut(budget?: AccountOpOptions): ProviderOpError {
  return {
    ok: false,
    code: "timeout",
    message:
      budget?.budgetMs !== undefined
        ? `provider did not answer within ${Math.round(budget.budgetMs / 1000)}s`
        : "stopped by the caller",
  };
}

/**
 * Launch the shared Chromium ahead of the first call (server boot), and
 * open and close one context so the first real call doesn't pay for that
 * either. Returns how long it took; throws when Chromium can't start.
 */
export async function warmUpBrowser(): Promise<number> {
  const started = Date.now();
  const browser = await warmBrowser(true);
  const context = await browser.newContext();
  await context.close();
  return Date.now() - started;
}
