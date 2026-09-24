/**
 * Provider account operations — the non-session executor surface a linked
 * account needs: verify cookies, set our Issuing card as the payment
 * method, remove it, top up the provider wallet. Types structurally mirror
 * the executor package (like services/executor.ts does for sessions); the
 * only importer of the package remains parknycExecutor.ts, and tests fake
 * this seam.
 */

import type { ProviderId } from "../providers/registry.js";
import type { ExecutorDiagnostics, ExecutorErrorCode } from "./executor.js";

/** Account ops can additionally fail on a card brand the form can't take. */
export type ProviderOpErrorCode = ExecutorErrorCode | "unsupported_card_brand";

export interface ProviderOpError {
  ok: false;
  code: ProviderOpErrorCode;
  message: string;
  diagnostics?: ExecutorDiagnostics;
}

export type ProviderOpResult = { ok: true } | ProviderOpError;

export type VerifyAccountResult = { ok: true; walletBalanceCents: number | null } | ProviderOpError;

export type TopupWalletResult = { ok: true; walletBalanceCents: number | null } | ProviderOpError;

/** Brand + last4 of the card the PROVIDER account already has on file
 * (provider_card users), read from its Your Cards screen for display.
 * Nulls mean the screen showed no card (or hid the details) — that is a
 * success, not an error. Never the PAN. */
export type ReadSavedCardResult =
  { ok: true; brand: string | null; last4: string | null } | ProviderOpError;

/**
 * Sensitive card fields for the provider's payment form, fetched from
 * Stripe (expand number/cvc) immediately before the call. NEVER log these,
 * never put them in decisions inputs; the executor blanks them after the
 * form is submitted.
 */
export interface CardFormDetails {
  number: string;
  expMonth: number;
  expYear: number;
  cvc: string;
  /** Stripe Issuing brand, e.g. "Visa" — drives the form's card-type radio. */
  brand: string;
}

/** A Playwright storage state as a value: what the link endpoint builds
 * from the app's captured cookies and what provider_accounts stores sealed. */
export interface ProviderStorageState {
  cookies: {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }[];
  origins: [];
}

export interface ProviderAccountOps {
  verifyAccount(): Promise<VerifyAccountResult>;
  setupCard(card: CardFormDetails): Promise<ProviderOpResult>;
  removeCard(last4: string): Promise<ProviderOpResult>;
  topupWallet(amountUsd: number): Promise<TopupWalletResult>;
  readSavedCard(): Promise<ReadSavedCardResult>;
}

/** Injectable seam: real factory in parknycExecutor.ts, fakes in tests.
 * Throws for a provider with no executor (the Boston placeholder). */
export type ProviderOpsFactory = (
  provider: ProviderId,
  state: ProviderStorageState,
) => ProviderAccountOps;
