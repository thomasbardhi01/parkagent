/**
 * API keys at rest are SHA-256(pepper:key) — the pepper is the
 * API_KEY_PEPPER env secret, so neither a DB dump nor a backup yields
 * usable credentials on its own. The plaintext key exists exactly twice:
 * on the phone (Config.xcconfig → x-api-key header) and once on the
 * terminal when create:user mints it.
 */

import { createHash, randomBytes } from "node:crypto";

/** Length of the identification prefix kept alongside the hash. */
export const API_KEY_PREFIX_LENGTH = 8;

export function hashApiKey(pepper: string, key: string): string {
  return createHash("sha256").update(`${pepper}:${key}`).digest("hex");
}

/** For logs and support ("which key is this?") — never for auth. */
export function apiKeyPrefix(key: string): string {
  return key.slice(0, API_KEY_PREFIX_LENGTH);
}

/** 192 bits from the CSPRNG, URL-safe — same shape keys always had. */
export function generateApiKey(): string {
  return randomBytes(24).toString("base64url");
}
