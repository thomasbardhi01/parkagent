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
import type {
  Executor,
  ExecutorResult,
  ExtendSessionArgs,
  StartSessionArgs,
  StopSessionArgs,
} from "./types.js";

export type {
  Executor,
  ExecutorDiagnostics,
  ExecutorError,
  ExecutorErrorCode,
  ExecutorOk,
  ExecutorResult,
  ExtendSessionArgs,
  StartSessionArgs,
  StopSessionArgs,
} from "./types.js";
export { ParkNycClient } from "./parknyc/client.js";
export type { ParkNycClientOptions } from "./parknyc/client.js";

export interface ParkNycExecutorOptions {
  /** Playwright storageState JSON (from `pnpm -C executor login`). */
  statePath: string;
  /** Vehicle used when a call doesn't name a plate (PARKNYC_PLATE). */
  defaultPlate?: string;
  /** Unexpected-screen evidence is also written here as files. */
  captureDir?: string;
  headless?: boolean;
}

export function createParkNycExecutor(options: ParkNycExecutorOptions): Executor {
  async function withClient(fn: (client: ParkNycClient) => Promise<ExecutorResult>) {
    const client = new ParkNycClient({
      statePath: options.statePath,
      headless: options.headless ?? true,
      ...(options.captureDir ? { captureDir: options.captureDir } : {}),
    });
    try {
      return await fn(client);
    } finally {
      await client.close();
    }
  }

  return {
    startSession: (args: StartSessionArgs) =>
      withClient((c) =>
        c.startSession(args.zoneNumber, args.plate ?? options.defaultPlate, args.minutes),
      ),
    extendSession: (args: ExtendSessionArgs) =>
      withClient((c) => c.extendSession(args.providerSessionId, args.minutes)),
    stopSession: (args: StopSessionArgs) =>
      withClient((c) => c.stopSession(args.providerSessionId)),
  };
}
