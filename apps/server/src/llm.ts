import type { Usage } from "@ai-employee/brain";
import { isLocalProvider, type CatalogModel, type GatewayProvider } from "./providers.ts";

/** US dollars per million tokens. */
export interface Pricing {
  input: number;
  cacheRead: number;
  output: number;
}

/** OpenAI-style usage block as returned by chat completions. */
export interface CompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  /** DeepSeek's name for cached prompt tokens. */
  prompt_cache_hit_tokens?: number;
}

/** Anthropic's usage block: input_tokens excludes the tokens read from or written to the prompt cache. */
export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function fromAnthropicUsage(usage: AnthropicUsage): CompletionUsage {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return {
    prompt_tokens: (usage.input_tokens ?? 0) + cacheRead + (usage.cache_creation_input_tokens ?? 0),
    completion_tokens: usage.output_tokens ?? 0,
    prompt_tokens_details: { cached_tokens: cacheRead },
  };
}

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

export type PriceSource = "manual" | "provider" | "public";

export interface PriceBookSources {
  /** A price the owner entered on the Models page. */
  manual(providerId: string, model: string): Pricing | null;
  /** The provider's own model list, when it carries prices (CheaperInference, OpenRouter). */
  catalog(providerId: string): Promise<CatalogModel[]>;
  /** Prices of well-known models from a public list. */
  publicList?: () => Promise<Map<string, Pricing>>;
}

/** Prices a model call: the owner's price first, then the provider's list, then the public list. */
export class PriceBook {
  constructor(private readonly sources: PriceBookSources) {}

  async get(providerId: string, model: string): Promise<Pricing | null> {
    return (await this.resolve(providerId, model)).price;
  }

  async resolve(providerId: string, model: string): Promise<{ price: Pricing | null; source: PriceSource | null }> {
    const manual = this.sources.manual(providerId, model);
    if (manual) return { price: manual, source: "manual" };
    try {
      const listed = (await this.sources.catalog(providerId)).find((m) => m.id === model)?.price;
      if (listed) return { price: listed, source: "provider" };
    } catch {
      // The provider could not list its models; fall back to the public list.
    }
    if (this.sources.publicList) {
      try {
        const known = publicPrice(await this.sources.publicList(), model);
        if (known) return { price: known, source: "public" };
      } catch {
        // No public prices right now.
      }
    }
    return { price: null, source: null };
  }
}

export const PUBLIC_PRICES_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** LiteLLM's community price list, per token, turned into prices per million tokens. */
export function parsePublicPrices(json: unknown): Map<string, Pricing> {
  const prices = new Map<string, Pricing>();
  if (!json || typeof json !== "object") return prices;
  // Per-token prices times a million pick up float noise (2.5e-7 × 1e6 = 0.24999999999999997).
  const perMillion = (perToken: number) => Math.round(perToken * 1e6 * 1e9) / 1e9;
  for (const [name, entry] of Object.entries(json as Record<string, Record<string, unknown>>)) {
    const input = Number(entry?.input_cost_per_token);
    const output = Number(entry?.output_cost_per_token);
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
    const cacheRead = Number(entry?.cache_read_input_token_cost);
    prices.set(name.toLowerCase(), { input: perMillion(input), output: perMillion(output), cacheRead: perMillion(Number.isFinite(cacheRead) ? cacheRead : input) });
  }
  return prices;
}

const PUBLIC_PREFIXES = ["", "anthropic/", "gemini/", "deepseek/", "openrouter/", "xai/", "groq/", "mistral/", "together_ai/"];

export function publicPrice(prices: Map<string, Pricing>, model: string): Pricing | null {
  const id = model.toLowerCase();
  const short = id.split("/").pop()!;
  for (const name of [id, ...PUBLIC_PREFIXES.map((p) => `${p}${short}`)]) {
    const hit = prices.get(name);
    if (hit) return hit;
  }
  return null;
}

/** Downloads the public price list once a day; after a failed download it tries again in an hour. */
export class PublicPriceList {
  private cached: { at: number; ttl: number; prices: Promise<Map<string, Pricing>> } | null = null;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly url = PUBLIC_PRICES_URL,
  ) {}

  get(): Promise<Map<string, Pricing>> {
    if (this.cached && this.now() - this.cached.at < this.cached.ttl) return this.cached.prices;
    const entry = { at: this.now(), ttl: DAY, prices: Promise.resolve(new Map<string, Pricing>()) };
    entry.prices = this.fetchImpl(this.url, { signal: AbortSignal.timeout(30_000) })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return parsePublicPrices(await res.json());
      })
      .catch(() => {
        entry.ttl = HOUR;
        return new Map<string, Pricing>();
      });
    this.cached = entry;
    return entry.prices;
  }
}

export function usageCost(usage: CompletionUsage, price: Pricing | null): Usage {
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  const cacheReadTokens = Math.min(inputTokens, usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0);
  const costUsd = price
    ? ((inputTokens - cacheReadTokens) * price.input + cacheReadTokens * price.cacheRead + outputTokens * price.output) / 1_000_000
    : 0;
  return { inputTokens, outputTokens, cacheReadTokens, costUsd };
}

export interface LlmProxyDeps {
  /** The provider with its decrypted key, or null when it does not exist; throws when the key cannot be read. */
  provider(id: string): GatewayProvider | null;
  prices: Pick<PriceBook, "get">;
  /** The agent run a model call belongs to, found from the request; null when it cannot be told. */
  resolveRun(requestBody: string): { runId: string; taskId: string } | null;
  /** A reason to refuse calls for this task (its budget is spent), or null. */
  refusal(taskId: string): string | null;
  record(runId: string, usage: Usage): void;
  log(message: string): void;
  fetch?: typeof fetch;
  /** Waits before each retry of a failed gateway call; tests shorten it. */
  retryDelaysMs?: number[];
}

/** Statuses worth trying again: rate limits and gateway or provider outages. */
const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);
const RETRY_DELAYS_MS = [1_000, 4_000];

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

const errorResponse = (status: number, message: string, type = "ai_employee_proxy") =>
  Response.json({ error: { message, type } }, { status });

/** Finds the usage in a server-sent event stream as it passes through: OpenAI's last chunk, or Anthropic's events. */
class UsageScanner {
  private openai: CompletionUsage | null = null;
  private anthropic: AnthropicUsage | null = null;
  private buffer = "";
  private readonly decoder = new TextDecoder();

  get usage(): CompletionUsage | null {
    return this.anthropic ? fromAnthropicUsage(this.anthropic) : this.openai;
  }

  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.scan(line);
  }

  end(): void {
    this.scan(this.buffer);
    this.buffer = "";
  }

  private scan(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:") || !trimmed.includes('"usage"')) return;
    try {
      const event = JSON.parse(trimmed.slice(5)) as { type?: string; usage?: unknown; message?: { usage?: AnthropicUsage } };
      if (event.type === "message_start" && event.message?.usage) this.anthropic = { ...event.message.usage };
      else if (event.type === "message_delta" && event.usage && typeof event.usage === "object") this.anthropic = { ...this.anthropic, ...(event.usage as AnthropicUsage) };
      else if (event.usage && typeof event.usage === "object") this.openai = event.usage as CompletionUsage;
    } catch {
      // not a JSON event
    }
  }
}

/**
 * Model gateway for the agents: forwards a call to its provider with the provider's real key (the agent user never
 * holds one), meters tokens and cost per agent run, and refuses calls once a task's budget is spent.
 * OpenAI-compatible and Gemini providers take `/v1/chat/completions`; Anthropic providers take `/v1/messages`.
 */
export async function handleLlmRequest(request: Request, providerId: string, subpath: string, deps: LlmProxyDeps): Promise<Response> {
  let provider: GatewayProvider | null;
  try {
    provider = deps.provider(providerId);
  } catch (error) {
    return errorResponse(503, (error as Error).message);
  }
  if (!provider) return errorResponse(404, `There is no provider "${providerId}". Set up providers on the Models page.`);
  const anthropic = provider.type === "anthropic";
  const route = anthropic ? /^\/(v1\/)?messages$/ : /^\/(v1\/)?chat\/completions$/;
  if (request.method !== "POST" || !route.test(subpath)) {
    return errorResponse(404, anthropic ? "Only POST /v1/messages is available for this provider" : "Only POST /chat/completions is available for this provider");
  }
  if (!provider.apiKey && !isLocalProvider(provider.baseUrl)) return errorResponse(503, `No API key is set for ${provider.name}. Add one on the Models page.`);

  const text = await request.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return errorResponse(400, "The request body is not JSON");
  }
  const run = deps.resolveRun(text);
  const refusal = run && deps.refusal(run.taskId);
  // 403 rather than 429 so the agent does not retry.
  if (refusal) return errorResponse(403, refusal, "budget_exceeded");
  // Gemini's OpenAI endpoint reports usage on its own; OpenAI-style APIs need to be asked for it when streaming.
  if (body.stream === true && provider.type === "openai") body.stream_options = { ...(body.stream_options as object | undefined), include_usage: true };

  const model = String(body.model ?? "");
  const target = provider;
  const finish = async (usage: CompletionUsage | null) => {
    if (!usage) return;
    const metered = usageCost(usage, await deps.prices.get(target.id, model));
    if (run) deps.record(run.runId, metered);
    else deps.log(`model call to ${target.id}/${model} could not be matched to a task (${metered.inputTokens + metered.outputTokens} tokens)`);
  };

  const url = anthropic ? `${provider.baseUrl}/v1/messages${new URL(request.url).search}` : `${provider.baseUrl}/chat/completions`;
  const headers: Record<string, string> = { "content-type": "application/json", accept: request.headers.get("accept") ?? "application/json" };
  if (anthropic) {
    headers["anthropic-version"] = request.headers.get("anthropic-version") ?? "2023-06-01";
    const beta = request.headers.get("anthropic-beta");
    if (beta) headers["anthropic-beta"] = beta;
    if (provider.apiKey) headers["x-api-key"] = provider.apiKey;
  } else if (provider.apiKey) {
    headers.authorization = `Bearer ${provider.apiKey}`;
  }

  // Retry before anything reaches the agent, so a brief provider outage does not fail a whole task.
  const delays = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
  let upstream: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      upstream = await (deps.fetch ?? fetch)(url, { method: "POST", headers, body: JSON.stringify(body), signal: request.signal });
    } catch (error) {
      if (request.signal.aborted || attempt >= delays.length) return errorResponse(502, `Could not reach ${provider.name}: ${(error as Error).message}`);
      deps.log(`model gateway: ${provider.id}/${model} could not be reached (${(error as Error).message}), retrying`);
      await wait(delays[attempt]!, request.signal);
      continue;
    }
    if (upstream.ok || !RETRYABLE.has(upstream.status) || attempt >= delays.length) break;
    const detail = (await upstream.text().catch(() => "")).slice(0, 300);
    deps.log(`model gateway: ${provider.id}/${model} returned HTTP ${upstream.status}, retrying: ${detail}`);
    await wait(delays[attempt]!, request.signal);
  }

  const contentType = upstream.headers.get("content-type") ?? "application/json";
  const responseHeaders = { "content-type": contentType, "cache-control": "no-cache" };
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    deps.log(`model gateway: ${provider.id}/${model} returned HTTP ${upstream.status}: ${detail.slice(0, 300)}`);
    return new Response(detail, { status: upstream.status, headers: responseHeaders });
  }

  if (contentType.includes("text/event-stream")) {
    const scanner = new UsageScanner();
    const metered = upstream.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          scanner.push(chunk);
        },
        flush() {
          scanner.end();
          void finish(scanner.usage).catch((error: Error) => deps.log(`could not record model usage: ${error.message}`));
        },
      }),
    );
    return new Response(metered, { status: upstream.status, headers: responseHeaders });
  }

  const reply = await upstream.text();
  let usage: (CompletionUsage & AnthropicUsage) | undefined;
  try {
    usage = (JSON.parse(reply) as { usage?: CompletionUsage & AnthropicUsage }).usage;
  } catch (error) {
    deps.log(`could not read model usage: ${(error as Error).message}`);
  }
  // Pricing may need the provider's model list; never make the agent wait for it.
  void finish(usage ? (anthropic ? fromAnthropicUsage(usage) : usage) : null).catch((error: Error) => deps.log(`could not record model usage: ${error.message}`));
  return new Response(reply, { status: upstream.status, headers: responseHeaders });
}
