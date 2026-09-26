import { describe, expect, it, vi } from "vitest";
import { buildBody, buildSecurityBody, chooseCoderModel, JevScorer, parseResult, scoreFrom, type TriageResult } from "./triage.ts";
import type { ModelRef } from "./spending.ts";

const cheap: ModelRef = { provider: "cheaperinference", model: "deepseek-v4-flash" };
const strong: ModelRef = { provider: "cheaperinference", model: "deepseek-v4-pro" };

const jsonResponse = (data: unknown, ok = true, status = 200): Response =>
  ({ ok, status, json: async () => data }) as unknown as Response;

describe("chooseCoderModel", () => {
  it("routes a hard task to the stronger model", () => {
    expect(chooseCoderModel({ complexity: 0.9 }, cheap, strong).model).toEqual(strong);
    expect(chooseCoderModel({ complexity: 0.66 }, cheap, strong).model).toEqual(strong);
  });

  it("keeps the cheap model for an easy or medium task", () => {
    expect(chooseCoderModel({ complexity: 0.65 }, cheap, strong).model).toEqual(cheap);
    expect(chooseCoderModel({ complexity: 0 }, cheap, strong).model).toEqual(cheap);
  });

  it("keeps the cheap model when there is no distinct stronger model", () => {
    expect(chooseCoderModel({ complexity: 1 }, cheap, cheap).model).toEqual(cheap);
  });

  it("clamps a nonsensical score instead of trusting it", () => {
    expect(chooseCoderModel({ complexity: 5 }, cheap, strong).model).toEqual(strong);
    expect(chooseCoderModel({ complexity: -1 }, cheap, strong).model).toEqual(cheap);
    expect(chooseCoderModel({ complexity: Number.NaN }, cheap, strong).model).toEqual(cheap);
  });

  it("respects a custom threshold", () => {
    expect(chooseCoderModel({ complexity: 0.4 }, cheap, strong, 0.3).model).toEqual(strong);
  });
});

describe("parseResult", () => {
  it("reads a bare number, and common answer wrappers", () => {
    expect(parseResult({ complexity: 0.8 })).toEqual({ complexity: 0.8 });
    expect(parseResult({ answers: { complexity: { value: 0.8 }, intent: { value: "security" } } })).toEqual({ complexity: 0.8, intent: "security" });
    expect(parseResult({ data: { complexity: { score: 0.42, probability: 0.9 } } })).toEqual({ complexity: 0.42 });
    expect(parseResult({ answers: { complexity: { probability: 0.7 }, intent: "coding" } })).toEqual({ complexity: 0.7, intent: "coding" });
  });

  it("throws when no complexity number is present", () => {
    expect(() => parseResult({ answers: { intent: "coding" } })).toThrow();
    expect(() => parseResult("nope")).toThrow();
  });
});

describe("buildBody", () => {
  it("sends only the task and plan text, both bounded", () => {
    const body = buildBody({ prompt: "x".repeat(9_000), planSummary: "do the thing" });
    const state = (body.state as { task: string; plan: string });
    expect(state.task.length).toBe(4_000);
    expect(state.plan).toBe("do the thing");
    expect(Object.keys(body.questions as object)).toEqual(["complexity", "intent"]);
  });
});

describe("JevScorer", () => {
  it("posts to the configured URL with a bearer key and parses the answer", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init?: RequestInit) => jsonResponse({ complexity: 0.77, intent: "coding" }));
    const scorer = new JevScorer({ apiKey: "secret", baseUrl: "https://jev.example", path: "/score", fetchImpl: fetchImpl as unknown as typeof fetch });
    const result: TriageResult = await scorer.score({ prompt: "add a flag", planSummary: "one file" });

    expect(result).toEqual({ complexity: 0.77, intent: "coding" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://jev.example/score");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ authorization: "Bearer secret" });
  });

  it("throws on a non-2xx response so the caller keeps the default model", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, false, 500));
    const scorer = new JevScorer({ apiKey: "k", fetchImpl });
    await expect(scorer.score({ prompt: "p", planSummary: "s" })).rejects.toThrow(/500/);
  });

  it("aborts the request when the caller's signal aborts", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as unknown as typeof fetch;
    const scorer = new JevScorer({ apiKey: "k", fetchImpl });
    const controller = new AbortController();
    const pending = scorer.score({ prompt: "p", planSummary: "s" }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});

describe("buildSecurityBody", () => {
  it("sends the files and a bounded diff with a single security question", () => {
    const body = buildSecurityBody({ files: ["a.ts", "b.ts"], diff: "x".repeat(50_000) });
    const state = body.state as { files: string; diff: string };
    expect(state.files).toBe("a.ts\nb.ts");
    expect(state.diff.length).toBe(40_000);
    expect(Object.keys(body.questions as object)).toEqual(["security"]);
  });
});

describe("scoreFrom", () => {
  it("reads a named score from the shapes a score answer can take", () => {
    expect(scoreFrom({ security: 0.9 }, "security")).toBe(0.9);
    expect(scoreFrom({ answers: { security: { value: 0.4 } } }, "security")).toBe(0.4);
    expect(scoreFrom({ data: { security: { probability: 0.7 } } }, "security")).toBe(0.7);
    expect(() => scoreFrom({ answers: {} }, "security")).toThrow();
  });
});

describe("JevScorer.securityScore", () => {
  it("posts with a bearer key and returns the security score", async () => {
    const fetchImpl = vi.fn(async (_u: string | URL, _i?: RequestInit) => jsonResponse({ security: 0.82 }));
    const scorer = new JevScorer({ apiKey: "k", baseUrl: "https://jev.example", path: "/s", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(scorer.securityScore({ files: ["auth.ts"], diff: "+ token" })).resolves.toBe(0.82);
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init?.headers).toMatchObject({ authorization: "Bearer k" });
  });

  it("throws on a non-2xx response so the caller adds nothing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, false, 502));
    const scorer = new JevScorer({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(scorer.securityScore({ files: ["a.ts"], diff: "d" })).rejects.toThrow(/502/);
  });
});
