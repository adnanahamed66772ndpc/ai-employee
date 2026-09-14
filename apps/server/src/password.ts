import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Returns `scrypt$<salt>$<hash>` (base64url). */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, SCRYPT);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = scryptSync(password, Buffer.from(salt, "base64url"), expected.length, SCRYPT);
  return timingSafeEqual(actual, expected);
}

export interface AuthFile {
  passwordHash: string;
  /** Random per-password secret; setting a new password signs everyone out. */
  sessionSecret: string;
}

export function newAuthFile(password: string): AuthFile {
  return { passwordHash: hashPassword(password), sessionSecret: randomBytes(32).toString("base64url") };
}
