import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { verifyPassword, type AuthFile } from "./password.ts";

const COOKIE = "aie_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Stateless signed session tokens: `<expiresMs>.<nonce>.<hmac>`. */
export class SessionSigner {
  constructor(
    private readonly secret: string,
    private readonly ttlMs = SESSION_TTL_MS,
    private readonly now = () => Date.now(),
  ) {}

  issue(): string {
    const body = `${this.now() + this.ttlMs}.${randomBytes(12).toString("base64url")}`;
    return `${body}.${this.sign(body)}`;
  }

  verify(token: string | undefined): boolean {
    if (!token) return false;
    const cut = token.lastIndexOf(".");
    if (cut <= 0) return false;
    const body = token.slice(0, cut);
    const given = Buffer.from(token.slice(cut + 1));
    const expected = Buffer.from(this.sign(body));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
    const expires = Number(body.split(".")[0]);
    return Number.isFinite(expires) && expires > this.now();
  }

  private sign(body: string): string {
    return createHmac("sha256", this.secret).update(body).digest("base64url");
  }
}

const GLOBAL = "*";

/**
 * Allows `max` failed logins per client and `globalMax` failed logins in total within `windowMs`.
 * The global cap bounds guessing even if a client can vary the address it is keyed on; while it is hit,
 * new logins wait for the window to pass (existing sessions keep working).
 */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly max = 10,
    private readonly windowMs = 15 * 60_000,
    private readonly globalMax = 30,
    private readonly now = () => Date.now(),
  ) {}

  private recent(key: string): number[] {
    const t = this.now();
    const recent = (this.failures.get(key) ?? []).filter((at) => t - at < this.windowMs);
    this.failures.set(key, recent);
    return recent;
  }

  allowed(key: string): boolean {
    return this.recent(key).length < this.max && this.recent(GLOBAL).length < this.globalMax;
  }

  fail(key: string): void {
    for (const k of [key, GLOBAL]) this.failures.set(k, [...this.recent(k), this.now()]);
  }

  succeed(key: string): void {
    this.failures.delete(key);
  }
}

export function loadAuthFile(path: string): AuthFile | null {
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, "utf8")) as Partial<AuthFile>;
  if (!data.passwordHash || !data.sessionSecret) throw new Error(`${path} is incomplete; run npm run set-password`);
  return data as AuthFile;
}

/**
 * The address the local reverse proxy saw. deploy/nginx overwrites X-Forwarded-For with $remote_addr, and the
 * last entry is the one a proxy appended, so client-supplied values are ignored. (Behind Cloudflare this is an
 * edge address; the limiter's global cap still bounds guessing.)
 */
export function clientKey(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",").pop()?.trim() || "local";
}

/**
 * Mounts /api/auth/* and returns middleware that requires a valid session for the rest of /api.
 * With no auth file the dashboard stays open (local development on 127.0.0.1 only).
 */
export function setupAuth(app: Hono, auth: AuthFile | null, options: { secureCookie: boolean }): MiddlewareHandler {
  const signer = auth ? new SessionSigner(`${auth.sessionSecret}:${auth.passwordHash}`) : null;
  const limiter = new LoginLimiter();
  const authenticated = (c: Context) => !signer || signer.verify(getCookie(c, COOKIE));

  app.get("/api/auth/status", (c) => c.json({ required: Boolean(signer), authenticated: authenticated(c) }));

  app.post("/api/auth/login", async (c) => {
    if (!auth || !signer) return c.json({ ok: true });
    const key = clientKey(c);
    if (!limiter.allowed(key)) return c.json({ error: "Too many attempts. Try again in 15 minutes." }, 429);
    const { password } = z.object({ password: z.string().min(1).max(1024) }).parse(await c.req.json());
    if (!verifyPassword(password, auth.passwordHash)) {
      limiter.fail(key);
      return c.json({ error: "Wrong password" }, 401);
    }
    limiter.succeed(key);
    setCookie(c, COOKIE, signer.issue(), {
      httpOnly: true,
      sameSite: "Strict",
      secure: options.secureCookie,
      path: "/",
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    return c.json({ ok: true });
  });

  app.post("/api/auth/logout", (c) => {
    deleteCookie(c, COOKIE, { path: "/", secure: options.secureCookie });
    return c.json({ ok: true });
  });

  return async (c, next) => {
    if (c.req.path.startsWith("/api/auth/") || authenticated(c)) return next();
    return c.json({ error: "Login required" }, 401);
  };
}
