import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { KeyStore, keyLast4 } from "./keystore.ts";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("key store", () => {
  it("encrypts with a fresh IV each time and decrypts back", () => {
    const store = KeyStore.fromSecret(randomBytes(32));
    const a = store.encrypt("sk-live-1234567890");
    const b = store.encrypt("sk-live-1234567890");
    expect(a).toMatch(/^v1:/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("1234567890");
    expect(store.decrypt(a)).toBe("sk-live-1234567890");
  });

  it("refuses a key encrypted with another secret or changed on disk", () => {
    const cipher = KeyStore.fromSecret(randomBytes(32)).encrypt("secret-key-value");
    expect(() => KeyStore.fromSecret(randomBytes(32)).decrypt(cipher)).toThrow();
    const store = KeyStore.fromSecret(randomBytes(32));
    const tampered = store.encrypt("secret-key-value").slice(0, -2) + "AA";
    expect(() => store.decrypt(tampered)).toThrow();
  });

  it("creates the secret file once and reuses it, or takes the secret from the environment", () => {
    dir = mkdtempSync(join(tmpdir(), "ai-employee-keys-"));
    const cipher = KeyStore.load(dir, "").encrypt("abc-provider-key");
    expect(readFileSync(join(dir, "secret.key"), "utf8").trim()).toHaveLength(44);
    if (process.platform !== "win32") expect(statSync(join(dir, "secret.key")).mode & 0o777).toBe(0o600);
    expect(KeyStore.load(dir, "").decrypt(cipher)).toBe("abc-provider-key");

    const hex = randomBytes(32).toString("hex");
    expect(KeyStore.load(dir, hex).decrypt(KeyStore.load(dir, hex).encrypt("x"))).toBe("x");
    expect(() => KeyStore.load(dir!, "too-short")).toThrow(/32 bytes/);
  });

  it("shows only the end of long keys", () => {
    expect(keyLast4("sk-proj-abcdefgh1234")).toBe("1234");
    expect(keyLast4("short-key")).toBeNull();
  });
});
