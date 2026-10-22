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

/** An external agent's key: `pak_<8-char prefix>_<secret>`. The prefix is
 * what logs and the key list show; the whole string is what is hashed. */
export const AGENT_KEY_PREFIX = "pak_";

export function generateAgentKey(): { key: string; prefix: string } {
  const prefix = randomBytes(6).toString("base64url").slice(0, API_KEY_PREFIX_LENGTH);
  const secret = randomBytes(24).toString("base64url");
  return { key: `${AGENT_KEY_PREFIX}${prefix}_${secret}`, prefix };
}

/** The prefix a presented agent key carries, or null for a string that
 * isn't one (a JWT, the admin key). */
export function agentKeyPrefixOf(key: string): string | null {
  if (!key.startsWith(AGENT_KEY_PREFIX)) return null;
  const rest = key.slice(AGENT_KEY_PREFIX.length);
  const prefix = rest.slice(0, API_KEY_PREFIX_LENGTH);
  return rest.length > API_KEY_PREFIX_LENGTH + 1 && rest[API_KEY_PREFIX_LENGTH] === "_"
    ? prefix
    : null;
}
