import type { Usage } from "@ai-employee/brain";

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

const HOUR = 60 * 60_000;

/** Model prices from the gateway's `/models` catalog, refreshed hourly. */
export class PriceBook {
  private prices = new Map<string, Pricing>();
  private loadedAt = -Infinity;
  private loading: Promise<void> | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async get(model: string): Promise<Pricing | null> {
    if (this.now() - this.loadedAt > HOUR) {
      this.loading ??= this.load().finally(() => (this.loading = undefined));
      await this.loading;
    }
    return this.prices.get(model) ?? null;
  }

  private async load(): Promise<void> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/models`, {
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data?: { id: string; pricing?: Record<string, unknown> | null }[] };
      const next = new Map<string, Pricing>();
      for (const model of body.data ?? []) {
        const p = model.pricing;
        const input = Number(p?.input_per_million);
        const output = Number(p?.output_per_million);
        if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
        const cacheRead = Number(p?.cache_read_input_per_million);
        next.set(model.id, { input, output, cacheRead: Number.isFinite(cacheRead) ? cacheRead : input });
      }
      this.prices = next;
      this.loadedAt = this.now();
    } catch {
      // Keep the old prices and try again in five minutes.
      this.loadedAt = this.now() - HOUR + 5 * 60_000;
    }
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
  baseUrl: string;
  apiKey: string | undefined;
  prices: PriceBook;
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
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [1_000, 4_000];

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

const errorResponse = (status: number, message: string, type = "ai_employee_proxy") =>
  Response.json({ error: { message, type } }, { status });

/** Finds the last `usage` object in a server-sent event stream as it passes through. */
class UsageScanner {
  usage: CompletionUsage | null = null;
  private buffer = "";
  private readonly decoder = new TextDecoder();

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
      const usage = (JSON.parse(trimmed.slice(5)) as { usage?: CompletionUsage | null }).usage;
      if (usage && typeof usage === "object") this.usage = usage;
    } catch {
      // not a JSON event
    }
  }
}

/**
 * Model gateway for the agents: forwards chat completions to CheaperInference with the server's key (the agent user
 * never holds it), meters tokens and cost per agent run, and refuses calls once a task's budget is spent.
 */
export async function handleLlmRequest(request: Request, subpath: string, deps: LlmProxyDeps): Promise<Response> {
  if (request.method !== "POST" || subpath !== "/chat/completions") return errorResponse(404, "Only POST /chat/completions is available");
  if (!deps.apiKey) return errorResponse(503, "CHEAPERINFERENCE_API_KEY is not set on the AI Employee server");

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
  if (body.stream === true) body.stream_options = { ...(body.stream_options as object | undefined), include_usage: true };

  const model = String(body.model ?? "");
  const finish = async (usage: CompletionUsage | null) => {
    if (!usage) return;
    const metered = usageCost(usage, await deps.prices.get(model));
    if (run) deps.record(run.runId, metered);
    else deps.log(`model call to ${model} could not be matched to a task (${metered.inputTokens + metered.outputTokens} tokens)`);
  };

  // Retry before anything reaches the agent, so a brief provider outage does not fail a whole task.
  const delays = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
  let upstream: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      upstream = await (deps.fetch ?? fetch)(`${deps.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: request.headers.get("accept") ?? "application/json",
          authorization: `Bearer ${deps.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted || attempt >= delays.length) return errorResponse(502, `Could not reach the model gateway: ${(error as Error).message}`);
      deps.log(`model gateway: ${model} could not be reached (${(error as Error).message}), retrying`);
      await wait(delays[attempt]!, request.signal);
      continue;
    }
    if (upstream.ok || !RETRYABLE.has(upstream.status) || attempt >= delays.length) break;
    const detail = (await upstream.text().catch(() => "")).slice(0, 300);
    deps.log(`model gateway: ${model} returned HTTP ${upstream.status}, retrying: ${detail}`);
    await wait(delays[attempt]!, request.signal);
  }

  const contentType = upstream.headers.get("content-type") ?? "application/json";
  const headers = { "content-type": contentType, "cache-control": "no-cache" };
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    deps.log(`model gateway: ${model} returned HTTP ${upstream.status}: ${detail.slice(0, 300)}`);
    return new Response(detail, { status: upstream.status, headers });
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
    return new Response(metered, { status: upstream.status, headers });
  }

  const reply = await upstream.text();
  try {
    await finish((JSON.parse(reply) as { usage?: CompletionUsage }).usage ?? null);
  } catch (error) {
    deps.log(`could not record model usage: ${(error as Error).message}`);
  }
  return new Response(reply, { status: upstream.status, headers });
}
