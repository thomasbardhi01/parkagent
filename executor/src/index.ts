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

import { ParkNycClient } from "./parknyc/client.js";
import { PassportClient } from "./passport/client.js";
import type {
  AccountOps,
  Executor,
  ExecutorResult,
  ExtendSessionArgs,
  StartSessionArgs,
  StopSessionArgs,
  StorageStateValue,
} from "./types.js";

export type {
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
  StartSessionArgs,
  StopSessionArgs,
  StorageStateValue,
  TopupWalletResult,
  VerifyAccountResult,
} from "./types.js";
export { closeWarmBrowser, warmBrowser } from "./browser.js";
export { ParkNycClient } from "./parknyc/client.js";
export type { ParkNycClientOptions } from "./parknyc/client.js";
export { PassportClient } from "./passport/client.js";
export type { PassportClientOptions } from "./passport/client.js";
export {
  normalizeStreet,
  parseZoneEntryHtml,
  parseZoneInfoHtml,
  streetsMatch,
} from "./passport/parse.js";
export type { ZoneEntryScreen, ZonePanel } from "./passport/parse.js";
export type { ZoneResolution } from "./types.js";

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
  async function withClient(fn: (client: ParkNycClient) => Promise<ExecutorResult>) {
    const client = makeClient(options);
    try {
      return await fn(client);
    } finally {
      await client.close();
    }
  }

  return {
    startSession: (args: StartSessionArgs) =>
      withClient((c) =>
        c.startSession(
          args.zoneNumber,
          args.plate ?? options.defaultPlate,
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
  headless?: boolean;
}

function makePassportClient(options: PassportExecutorOptions): PassportClient {
  return new PassportClient({
    ...(options.statePath ? { statePath: options.statePath } : {}),
    ...(options.storageState ? { storageState: options.storageState } : {}),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    sharedBrowser: true,
    headless: options.headless ?? true,
    ...(options.captureDir ? { captureDir: options.captureDir } : {}),
  });
}

export function createPassportExecutor(options: PassportExecutorOptions): Executor {
  async function withClient(fn: (client: PassportClient) => Promise<ExecutorResult>) {
    const client = makePassportClient(options);
    try {
      return await fn(client);
    } finally {
      await client.close();
    }
  }

  return {
    // No map in the ParkBoston web app (2026-09-21 recording): the zone
    // number is required and typed into the Enter Zone screen; car
    // coordinates are ignored here (they only feed ParkNYC's cross-check).
    startSession: (args: StartSessionArgs) =>
      withClient((c) => c.startSession(args.zoneNumber, args.plate, args.minutes)),
    extendSession: (args: ExtendSessionArgs) =>
      withClient((c) => c.extendSession(args.providerSessionId, args.minutes)),
    stopSession: (args: StopSessionArgs) =>
      withClient((c) => c.stopSession(args.providerSessionId)),
  };
}

/** Account operations against a linked Passport account. */
export function createPassportAccountOps(options: PassportExecutorOptions): AccountOps {
  async function withClient<T>(fn: (client: PassportClient) => Promise<T>): Promise<T> {
    const client = makePassportClient(options);
    try {
      return await fn(client);
    } finally {
      await client.close();
    }
  }

  return {
    verifyAccount: () => withClient((c) => c.verifyAccount()),
    setupCard: (card) => withClient((c) => c.setupCard(card)),
    removeCard: (last4) => withClient((c) => c.removeCard(last4)),
    topupWallet: (amountUsd) => withClient((c) => c.topupWallet(amountUsd)),
  };
}

/** Account operations against a linked ParkNYC account (verify cookies,
 * card setup/removal, wallet top-up). Same isolation as the executor. */
export function createParkNycAccountOps(options: ParkNycExecutorOptions): AccountOps {
  async function withClient<T>(fn: (client: ParkNycClient) => Promise<T>): Promise<T> {
    const client = makeClient(options);
    try {
      return await fn(client);
    } finally {
      await client.close();
    }
  }

  return {
    verifyAccount: () => withClient((c) => c.verifyAccount()),
    setupCard: (card) => withClient((c) => c.setupCard(card)),
    removeCard: (last4) => withClient((c) => c.removeCard(last4)),
    topupWallet: (amountUsd) => withClient((c) => c.topupWallet(amountUsd)),
  };
}
