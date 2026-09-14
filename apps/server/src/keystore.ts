import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/*
 * Encrypts provider API keys before they reach the brain (AES-256-GCM, a fresh IV per key). The 32-byte secret lives
 * outside the brain: AI_EMPLOYEE_SECRET_KEY, or data/secret.key created on first start with mode 600. Brain backups
 * therefore never hold usable keys, and losing the secret only means entering the keys again.
 */

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class KeyStore {
  private constructor(private readonly secret: Buffer) {}

  static fromSecret(secret: Buffer): KeyStore {
    if (secret.length !== 32) throw new Error("The key encryption secret must be 32 bytes");
    return new KeyStore(secret);
  }

  /** The secret from AI_EMPLOYEE_SECRET_KEY (base64 or hex), else `<dataDir>/secret.key`, created when missing. */
  static load(dataDir: string, fromEnv = process.env.AI_EMPLOYEE_SECRET_KEY): KeyStore {
    if (fromEnv?.trim()) return KeyStore.fromSecret(decodeSecret(fromEnv.trim()));
    const path = join(dataDir, "secret.key");
    if (!existsSync(path)) {
      writeFileSync(path, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600, flag: "wx" });
    }
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows has no Unix modes.
    }
    return KeyStore.fromSecret(decodeSecret(readFileSync(path, "utf8").trim()));
  }

  encrypt(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.secret, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64")}`;
  }

  decrypt(stored: string): string {
    const [version, payload] = stored.split(":", 2);
    if (version !== VERSION || !payload) throw new Error("Unknown key format");
    const raw = Buffer.from(payload, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.secret, raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
  }
}

function decodeSecret(text: string): Buffer {
  const secret = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, "hex") : Buffer.from(text, "base64");
  if (secret.length !== 32) throw new Error("AI_EMPLOYEE_SECRET_KEY must be 32 bytes, as base64 or hex");
  return secret;
}

/** The last four characters to show in the UI, or null when the key is too short to reveal any of it. */
export function keyLast4(key: string): string | null {
  return key.length >= 12 ? key.slice(-4) : null;
}
