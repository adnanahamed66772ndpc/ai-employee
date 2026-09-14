import { describe, expect, it } from "vitest";
import { LoginLimiter, SessionSigner } from "./auth.ts";
import { hashPassword, newAuthFile, verifyPassword } from "./password.ts";

describe("passwords", () => {
  it("verifies the right password only", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(verifyPassword("wrong", stored)).toBe(false);
    expect(verifyPassword("anything", "plain-text")).toBe(false);
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("creates a fresh session secret per password", () => {
    expect(newAuthFile("a-long-password").sessionSecret).not.toBe(newAuthFile("a-long-password").sessionSecret);
  });
});

describe("SessionSigner", () => {
  it("accepts its own tokens until they expire", () => {
    let now = 1_000;
    const signer = new SessionSigner("secret", 500, () => now);
    const token = signer.issue();
    expect(signer.verify(token)).toBe(true);
    now = 1_600;
    expect(signer.verify(token)).toBe(false);
  });

  it("rejects tampered tokens and tokens from another secret", () => {
    const signer = new SessionSigner("secret");
    const token = signer.issue();
    const [expires, nonce, sig] = token.split(".");
    expect(signer.verify(`${Number(expires) + 99999999}.${nonce}.${sig}`)).toBe(false);
    expect(new SessionSigner("other").verify(token)).toBe(false);
    expect(signer.verify(undefined)).toBe(false);
    expect(signer.verify("garbage")).toBe(false);
  });
});

describe("LoginLimiter", () => {
  it("caps failures globally so rotating client addresses does not help", () => {
    const limiter = new LoginLimiter(10, 1000, 3, () => 0);
    limiter.fail("1.1.1.1");
    limiter.fail("2.2.2.2");
    limiter.fail("3.3.3.3");
    expect(limiter.allowed("4.4.4.4")).toBe(false);
  });

  it("blocks after too many failures and forgets them after the window", () => {
    let now = 0;
    const limiter = new LoginLimiter(2, 1000, 100, () => now);
    limiter.fail("ip");
    limiter.fail("ip");
    expect(limiter.allowed("ip")).toBe(false);
    expect(limiter.allowed("other")).toBe(true);
    now = 1500;
    expect(limiter.allowed("ip")).toBe(true);
  });
});
