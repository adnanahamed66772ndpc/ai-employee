import { describe, expect, it, vi } from "vitest";
import type { Usage } from "@ai-employee/brain";
import { handleLlmRequest, PriceBook, usageCost, type LlmProxyDeps } from "./llm.ts";

const STREAM = [
  'data: {"choices":[{"delta":{"content":"Hi"}}]}',
  "",
  'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":500,"prompt_tokens_details":{"cached_tokens":400}}}',
  "",
  "data: [DONE]",
  "",
  "",
].join("\n");

function setup(overrides: Partial<LlmProxyDeps> = {}) {
  const recorded: { runId: string; usage: Usage }[] = [];
  const forwarded: { url: string; init: RequestInit }[] = [];
  const deps: LlmProxyDeps = {
    baseUrl: "https://gateway.test/v1",
    apiKey: "real-key",
    prices: { get: async () => ({ input: 1, cacheRead: 0.1, output: 2 }) } as unknown as PriceBook,
    resolveRun: () => ({ runId: "run-1", taskId: "task-1" }),
    refusal: () => null,
    record: (runId, usage) => recorded.push({ runId, usage }),
    log: () => {},
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      forwarded.push({ url: String(url), init: init! });
      return new Response(STREAM, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch,
    ...overrides,
  };
  return { deps, recorded, forwarded };
}

const completion = (body: unknown, method = "POST") =>
  new Request("http://127.0.0.1:7717/llm/v1/chat/completions", {
    method,
    headers: { authorization: "Bearer supplied-by-ai-employee-gateway", "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });

describe("model gateway", () => {
  it("forwards with the server's key, passes the stream through and meters the call", async () => {
    const { deps, recorded, forwarded } = setup();
    const response = await handleLlmRequest(completion({ model: "deepseek-v4-flash", stream: true, messages: [] }), "/chat/completions", deps);

    expect(await response.text()).toBe(STREAM);
    expect(forwarded[0]!.url).toBe("https://gateway.test/v1/chat/completions");
    expect((forwarded[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer real-key");
    expect(JSON.parse(String(forwarded[0]!.init.body))).toMatchObject({ stream_options: { include_usage: true } });

    await vi.waitFor(() => expect(recorded).toHaveLength(1));
    expect(recorded[0]).toMatchObject({ runId: "run-1", usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 400 } });
    // 600 uncached input × $1 + 400 cached × $0.10 + 500 output × $2, per million tokens
    expect(recorded[0]!.usage.costUsd).toBeCloseTo(0.00164, 10);
  });

  it("retries a provider outage before the agent sees it", async () => {
    const logs: string[] = [];
    let calls = 0;
    const { deps, recorded } = setup({
      log: (message) => logs.push(message),
      retryDelaysMs: [1, 1],
      fetch: (async () => {
        calls++;
        if (calls === 1) return new Response("upstream busy, request id abc", { status: 503 });
        return new Response(STREAM, { headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch,
    });
    const response = await handleLlmRequest(completion({ model: "deepseek-v4-flash", stream: true, messages: [] }), "/chat/completions", deps);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(STREAM);
    expect(calls).toBe(2);
    expect(logs[0]).toContain("HTTP 503, retrying: upstream busy, request id abc");
    await vi.waitFor(() => expect(recorded).toHaveLength(1));
  });

  it("passes a client error straight through and logs it", async () => {
    const logs: string[] = [];
    let calls = 0;
    const { deps } = setup({
      log: (message) => logs.push(message),
      retryDelaysMs: [1, 1],
      fetch: (async () => {
        calls++;
        return Response.json({ error: { message: "bad request" } }, { status: 400 });
      }) as typeof fetch,
    });
    const response = await handleLlmRequest(completion({ model: "m", messages: [] }), "/chat/completions", deps);
    expect(response.status).toBe(400);
    expect(calls).toBe(1);
    expect(logs[0]).toContain("returned HTTP 400");
  });

  it("refuses calls for a task whose budget is spent without calling the gateway", async () => {
    const { deps, forwarded } = setup({ refusal: () => "Budget reached" });
    const response = await handleLlmRequest(completion({ model: "m", messages: [] }), "/chat/completions", deps);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { message: "Budget reached", type: "budget_exceeded" } });
    expect(forwarded).toHaveLength(0);
  });

  it("only offers chat completions, and only with a key", async () => {
    const { deps } = setup();
    expect((await handleLlmRequest(completion(null, "GET"), "/models", deps)).status).toBe(404);
    expect((await handleLlmRequest(completion({}), "/chat/completions", { ...deps, apiKey: undefined })).status).toBe(503);
  });

  it("works out cost from DeepSeek's cache field and without a price", () => {
    expect(usageCost({ prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 60 }, { input: 1, cacheRead: 0, output: 1 })).toMatchObject({
      cacheReadTokens: 60,
      costUsd: 50 / 1_000_000,
    });
    expect(usageCost({ prompt_tokens: 100 }, null).costUsd).toBe(0);
  });

  it("loads prices from the catalog once an hour", async () => {
    const fetchModels = vi.fn(async () =>
      Response.json({ data: [{ id: "deepseek-v4-flash", pricing: { input_per_million: "0.04", cache_read_input_per_million: "0.008", output_per_million: "0.08" } }] }),
    );
    let now = 0;
    const book = new PriceBook("https://gateway.test/v1", "key", fetchModels as unknown as typeof fetch, () => now);
    expect(await book.get("deepseek-v4-flash")).toEqual({ input: 0.04, cacheRead: 0.008, output: 0.08 });
    expect(await book.get("unknown")).toBeNull();
    now += 30 * 60_000;
    await book.get("deepseek-v4-flash");
    expect(fetchModels).toHaveBeenCalledTimes(1);
    now += 31 * 60_000;
    await book.get("deepseek-v4-flash");
    expect(fetchModels).toHaveBeenCalledTimes(2);
  });
});
