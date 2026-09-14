import { describe, expect, it, vi } from "vitest";
import type { Usage } from "@ai-employee/brain";
import { handleLlmRequest, parsePublicPrices, PriceBook, PublicPriceList, publicPrice, usageCost, type LlmProxyDeps } from "./llm.ts";
import type { GatewayProvider } from "./providers.ts";

const STREAM = [
  'data: {"choices":[{"delta":{"content":"Hi"}}]}',
  "",
  'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":500,"prompt_tokens_details":{"cached_tokens":400}}}',
  "",
  "data: [DONE]",
  "",
  "",
].join("\n");

const ANTHROPIC_STREAM = [
  "event: message_start",
  'data: {"type":"message_start","message":{"usage":{"input_tokens":300,"cache_read_input_tokens":600,"cache_creation_input_tokens":100,"output_tokens":1}}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}',
  "",
  "event: message_delta",
  'data: {"type":"message_delta","usage":{"output_tokens":250}}',
  "",
  "",
].join("\n");

const PROVIDERS: Record<string, GatewayProvider> = {
  cheaperinference: { id: "cheaperinference", name: "CheaperInference", type: "openai", baseUrl: "https://gateway.test/v1", apiKey: "real-key" },
  anthropic: { id: "anthropic", name: "Anthropic", type: "anthropic", baseUrl: "https://api.anthropic.test", apiKey: "anthropic-key" },
  ollama: { id: "ollama", name: "Ollama", type: "openai", baseUrl: "http://127.0.0.1:11434/v1", apiKey: null },
  nokey: { id: "nokey", name: "No Key Inc", type: "openai", baseUrl: "https://api.nokey.test/v1", apiKey: null },
};

function setup(overrides: Partial<LlmProxyDeps> = {}, body = STREAM) {
  const recorded: { runId: string; usage: Usage }[] = [];
  const forwarded: { url: string; init: RequestInit }[] = [];
  const priced: string[] = [];
  const deps: LlmProxyDeps = {
    provider: (id) => PROVIDERS[id] ?? null,
    prices: {
      get: async (providerId, model) => {
        priced.push(`${providerId}/${model}`);
        return { input: 1, cacheRead: 0.1, output: 2 };
      },
    },
    resolveRun: () => ({ runId: "run-1", taskId: "task-1" }),
    refusal: () => null,
    record: (runId, usage) => recorded.push({ runId, usage }),
    log: () => {},
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      forwarded.push({ url: String(url), init: init! });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch,
    ...overrides,
  };
  return { deps, recorded, forwarded, priced };
}

const call = (path: string, body: unknown, method = "POST", headers: Record<string, string> = {}) =>
  new Request(`http://127.0.0.1:7717${path}`, {
    method,
    headers: { authorization: "Bearer supplied-by-ai-employee-gateway", "content-type": "application/json", ...headers },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
const completion = (body: unknown, method = "POST") => call("/llm/p/cheaperinference/v1/chat/completions", body, method);

describe("model gateway", () => {
  it("forwards with the provider's key, passes the stream through and meters the call", async () => {
    const { deps, recorded, forwarded, priced } = setup();
    const response = await handleLlmRequest(completion({ model: "deepseek-v4-flash", stream: true, messages: [] }), "cheaperinference", "/v1/chat/completions", deps);

    expect(await response.text()).toBe(STREAM);
    expect(forwarded[0]!.url).toBe("https://gateway.test/v1/chat/completions");
    expect((forwarded[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer real-key");
    expect(JSON.parse(String(forwarded[0]!.init.body))).toMatchObject({ stream_options: { include_usage: true } });

    await vi.waitFor(() => expect(recorded).toHaveLength(1));
    expect(priced).toEqual(["cheaperinference/deepseek-v4-flash"]);
    expect(recorded[0]).toMatchObject({ runId: "run-1", usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 400 } });
    // 600 uncached input × $1 + 400 cached × $0.10 + 500 output × $2, per million tokens
    expect(recorded[0]!.usage.costUsd).toBeCloseTo(0.00164, 10);
  });

  it("forwards Anthropic messages with the x-api-key header and meters Anthropic's stream events", async () => {
    const { deps, recorded, forwarded } = setup({}, ANTHROPIC_STREAM);
    const request = call("/llm/p/anthropic/v1/messages?beta=true", { model: "claude-sonnet-5", stream: true, messages: [] }, "POST", {
      "x-api-key": "supplied-by-ai-employee-gateway",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
    });
    const response = await handleLlmRequest(request, "anthropic", "/v1/messages", deps);

    expect(await response.text()).toBe(ANTHROPIC_STREAM);
    expect(forwarded[0]!.url).toBe("https://api.anthropic.test/v1/messages?beta=true");
    const headers = forwarded[0]!.init.headers as Record<string, string>;
    expect(headers).toMatchObject({ "x-api-key": "anthropic-key", "anthropic-version": "2023-06-01", "anthropic-beta": "fine-grained-tool-streaming-2025-05-14" });
    expect(headers.authorization).toBeUndefined();
    expect(JSON.parse(String(forwarded[0]!.init.body)).stream_options).toBeUndefined();

    await vi.waitFor(() => expect(recorded).toHaveLength(1));
    // 300 plain + 600 cache read + 100 cache write input tokens, 250 output tokens
    expect(recorded[0]!.usage).toMatchObject({ inputTokens: 1000, cacheReadTokens: 600, outputTokens: 250 });
  });

  it("meters a non-streaming Anthropic reply", async () => {
    const reply = JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90 } });
    const { deps, recorded } = setup({
      fetch: (async () => new Response(reply, { headers: { "content-type": "application/json" } })) as typeof fetch,
    });
    const response = await handleLlmRequest(call("/llm/p/anthropic/v1/messages", { model: "claude-haiku-4.5", messages: [] }), "anthropic", "/v1/messages", deps);
    expect(await response.text()).toBe(reply);
    expect(recorded[0]!.usage).toMatchObject({ inputTokens: 100, cacheReadTokens: 90, outputTokens: 5 });
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
    const response = await handleLlmRequest(completion({ model: "deepseek-v4-flash", stream: true, messages: [] }), "cheaperinference", "/v1/chat/completions", deps);
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
    const response = await handleLlmRequest(completion({ model: "m", messages: [] }), "cheaperinference", "/v1/chat/completions", deps);
    expect(response.status).toBe(400);
    expect(calls).toBe(1);
    expect(logs[0]).toContain("returned HTTP 400");
  });

  it("refuses calls for a task whose budget is spent without calling the provider", async () => {
    const { deps, forwarded } = setup({ refusal: () => "Budget reached" });
    const response = await handleLlmRequest(completion({ model: "m", messages: [] }), "cheaperinference", "/v1/chat/completions", deps);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { message: "Budget reached", type: "budget_exceeded" } });
    expect(forwarded).toHaveLength(0);
  });

  it("offers only each type's endpoint, needs a key except for a local provider, and explains an unknown provider", async () => {
    const { deps, forwarded } = setup();
    expect((await handleLlmRequest(completion(null, "GET"), "cheaperinference", "/v1/models", deps)).status).toBe(404);
    expect((await handleLlmRequest(completion({}), "anthropic", "/v1/chat/completions", deps)).status).toBe(404);
    const noKey = await handleLlmRequest(completion({ model: "m" }), "nokey", "/v1/chat/completions", deps);
    expect(noKey.status).toBe(503);
    expect(await noKey.json()).toMatchObject({ error: { message: "No API key is set for No Key Inc. Add one on the Models page." } });
    expect((await handleLlmRequest(completion({ model: "m" }), "missing", "/v1/chat/completions", deps)).status).toBe(404);

    await handleLlmRequest(completion({ model: "llama3.1:8b", messages: [] }), "ollama", "/v1/chat/completions", deps);
    expect(forwarded.at(-1)!.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect((forwarded.at(-1)!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("reports a key that cannot be decrypted instead of calling the provider", async () => {
    const { deps, forwarded } = setup({
      provider: () => {
        throw new Error("The saved API key for OpenAI cannot be read with this server's secret.");
      },
    });
    const response = await handleLlmRequest(completion({ model: "m" }), "openai", "/v1/chat/completions", deps);
    expect(response.status).toBe(503);
    expect(forwarded).toHaveLength(0);
  });

  it("works out cost from DeepSeek's cache field and without a price", () => {
    expect(usageCost({ prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 60 }, { input: 1, cacheRead: 0, output: 1 })).toMatchObject({
      cacheReadTokens: 60,
      costUsd: 50 / 1_000_000,
    });
    expect(usageCost({ prompt_tokens: 100 }, null).costUsd).toBe(0);
  });
});

describe("prices", () => {
  it("takes the owner's price first, then the provider's list, then the public list", async () => {
    const book = new PriceBook({
      manual: (provider, model) => (provider === "openai" && model === "gpt-5.4" ? { input: 9, output: 9, cacheRead: 9 } : null),
      catalog: async (provider) => {
        if (provider === "broken") throw new Error("HTTP 401");
        return [{ id: "deepseek-v4-flash", price: { input: 0.04, output: 0.08, cacheRead: 0.008 } }, { id: "gpt-5.4", price: null }];
      },
      publicList: async () => new Map([["gpt-5.4-mini", { input: 0.25, output: 2, cacheRead: 0.025 }]]),
    });
    expect(await book.resolve("openai", "gpt-5.4")).toMatchObject({ source: "manual", price: { input: 9 } });
    expect(await book.resolve("cheaperinference", "deepseek-v4-flash")).toMatchObject({ source: "provider", price: { input: 0.04 } });
    expect(await book.resolve("broken", "gpt-5.4-mini")).toMatchObject({ source: "public", price: { output: 2 } });
    expect(await book.resolve("openai", "unknown-model")).toEqual({ price: null, source: null });
  });

  it("reads the public list per million tokens and finds models under provider prefixes", () => {
    const prices = parsePublicPrices({
      "gpt-5.4-mini": { input_cost_per_token: 2.5e-7, output_cost_per_token: 2e-6, cache_read_input_token_cost: 2.5e-8 },
      "anthropic/claude-sonnet-5": { input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5 },
      sample_spec: { max_tokens: 1 },
    });
    expect(publicPrice(prices, "gpt-5.4-mini")).toEqual({ input: 0.25, output: 2, cacheRead: 0.025 });
    expect(publicPrice(prices, "claude-sonnet-5")).toMatchObject({ input: 3, output: 15, cacheRead: 3 });
    expect(publicPrice(prices, "openrouter-style/claude-sonnet-5")).toMatchObject({ input: 3 });
    expect(publicPrice(prices, "nothing")).toBeNull();
  });

  it("downloads the public list once a day and retries a failed download after an hour", async () => {
    let now = 0;
    let fail = true;
    const fetchList = vi.fn(async () => (fail ? new Response("down", { status: 503 }) : Response.json({ m: { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } })));
    const list = new PublicPriceList(fetchList as unknown as typeof fetch, () => now, "https://prices.test/list.json");
    expect((await list.get()).size).toBe(0);
    now += 30 * 60_000;
    await list.get();
    expect(fetchList).toHaveBeenCalledTimes(1);
    now += 31 * 60_000;
    fail = false;
    expect((await list.get()).get("m")).toMatchObject({ input: 1, output: 2 });
    now += 23 * 60 * 60_000;
    await list.get();
    expect(fetchList).toHaveBeenCalledTimes(2);
  });
});
