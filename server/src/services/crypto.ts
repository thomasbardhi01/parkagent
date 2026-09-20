/**
 * Sealing for provider session state (provider_accounts.state_encrypted):
 * AES-256-GCM under PROVIDER_STATE_KEY, a 32-byte base64 secret.
 *
 * Generate a key:      openssl rand -base64 32
 * Set it on Fly:       fly secrets set -a parkagent-api PROVIDER_STATE_KEY="$(openssl rand -base64 32)"
 *
 * The sealed format is base64(iv[12] | tag[16] | ciphertext). Rotating the
 * key invalidates every stored state — accounts then verify as expired and
 * users re-link; nothing is lost but a login.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export interface StateCrypto {
  seal(plaintext: string): string;
  /** Throws on tampering or a wrong key. */
  open(sealed: string): string;
}

/** Parse and check the key eagerly so a bad secret fails at boot, not on
 * the first link. */
export function makeStateCrypto(keyBase64: string): StateCrypto {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) {
    throw new Error(
      `PROVIDER_STATE_KEY must be 32 bytes of base64 (openssl rand -base64 32); got ${key.length} bytes`,
    );
  }
  return {
    seal(plaintext) {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
    },
    open(sealed) {
      const raw = Buffer.from(sealed, "base64");
      const iv = raw.subarray(0, IV_LENGTH);
      const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
      const ciphertext = raw.subarray(IV_LENGTH + TAG_LENGTH);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    },
  };
}
