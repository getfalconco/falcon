/**
 * Application-level encryption for the SnapTrade user secret kept in
 * `public.snaptrade_secrets.user_secret`.
 *
 * AES-256-GCM with a 96-bit random nonce per write. The Supabase user id is
 * bound in as additional authenticated data, so a ciphertext copied onto
 * another account's row does not decrypt there. The stored value is one
 * self-describing string in the existing column, so no schema change is
 * needed and a plaintext row from before this change is still recognised:
 *
 *   enc:v1:<nonce b64url>:<tag b64url>:<ciphertext b64url>
 *
 * The key comes from SNAPTRADE_SECRET_KEY: 32 bytes, as 64 hex characters or
 * base64 (`openssl rand -base64 32`).
 *
 * COPY of apps/research-worker/src/secret-box.ts: the desktop main process
 * reads and writes the same rows in development builds that hold the
 * service-role key (packaged builds go through the worker). KEEP IN SYNC;
 * both test files pin the same vector. Set the same SNAPTRADE_SECRET_KEY in
 * apps/desktop/.env.local as on the worker, or this process cannot open the
 * rows the worker sealed.
 *
 * Pure: no env, no network.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const SEALED_PREFIX = "enc:v1:";

export class SecretKeyError extends Error {}

/** A 32-byte key from hex or base64, or null when the value is missing or the wrong size. */
export function parseSecretKey(raw: string | null | undefined): Buffer | null {
  const value = raw?.trim() ?? "";
  if (!value) return null;
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, "hex");
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    const bytes = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (bytes.length === 32) return bytes;
  }
  return null;
}

export function isSealed(stored: string): boolean {
  return stored.startsWith(SEALED_PREFIX);
}

export function sealSecret(plaintext: string, key: Buffer, aad: string, nonce: Buffer = randomBytes(12)): string {
  if (key.length !== 32) throw new SecretKeyError("SNAPTRADE_SECRET_KEY must be 32 bytes.");
  if (nonce.length !== 12) throw new Error("nonce must be 12 bytes");
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SEALED_PREFIX}${nonce.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

/** The plaintext of a sealed value. Throws when the key, the account or the bytes do not match. */
export function openSecret(stored: string, key: Buffer, aad: string): string {
  if (!isSealed(stored)) throw new Error("value is not sealed");
  const parts = stored.slice(SEALED_PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("sealed value is malformed");
  const [nonce, tag, ciphertext] = parts.map((p) => Buffer.from(p, "base64url")) as [Buffer, Buffer, Buffer];
  if (nonce.length !== 12 || tag.length !== 16) throw new Error("sealed value is malformed");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
