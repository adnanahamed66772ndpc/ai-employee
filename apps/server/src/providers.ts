import type { Brain, Provider, ProviderType } from "@ai-employee/brain";
import { keyLast4, type KeyStore } from "./keystore.ts";
import type { Pricing } from "./llm.ts";
import { spendingSettings, type ModelRef } from "./spending.ts";

/*
 * Model providers: presets for the Models page, the server-side registry that decrypts keys only for the gateway,
 * and each provider's model catalog (with prices when the provider publishes them).
 */

export const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const PROVIDER_TYPES: readonly ProviderType[] = ["openai", "anthropic", "gemini"];

export interface ProviderPreset {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: "openai", name: "OpenAI", type: "openai", baseUrl: "https://api.openai.com/v1" },
  { id: "anthropic", name: "Anthropic", type: "anthropic", baseUrl: "https://api.anthropic.com" },
  { id: "gemini", name: "Google Gemini", type: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { id: "deepseek", name: "DeepSeek", type: "openai", baseUrl: "https://api.deepseek.com/v1" },
  { id: "openrouter", name: "OpenRouter", type: "openai", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "cheaperinference", name: "CheaperInference", type: "openai", baseUrl: "https://api.cheaperinference.com/v1" },
  { id: "groq", name: "Groq", type: "openai", baseUrl: "https://api.groq.com/openai/v1" },
  { id: "mistral", name: "Mistral", type: "openai", baseUrl: "https://api.mistral.ai/v1" },
  { id: "xai", name: "xAI", type: "openai", baseUrl: "https://api.x.ai/v1" },
  { id: "together", name: "Together AI", type: "openai", baseUrl: "https://api.together.xyz/v1" },
  { id: "ollama", name: "Ollama (on this server)", type: "openai", baseUrl: "http://127.0.0.1:11434/v1" },
];

/** An http(s) URL without a trailing slash; anything else is refused. */
export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("The base URL must be a full address such as https://api.openai.com/v1");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("The base URL must start with https:// or http://");
  if (url.username || url.password) throw new Error("Put the key in the API key field, not in the base URL");
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

/** A provider on this machine (for example Ollama) works without a key. */
export function isLocalProvider(baseUrl: string): boolean {
  const host = new URL(baseUrl).hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/** A new provider id from its name, unique among `taken`. */
export function providerIdFrom(name: string, taken: ReadonlySet<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "provider";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** What the gateway needs to call a provider, with the key decrypted. */
export interface GatewayProvider {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string | null;
}

export interface CatalogModel {
  id: string;
  price: Pricing | null;
}

/** Prices a provider lists with its models: CheaperInference per million tokens, OpenRouter per token. */
export function catalogPrice(entry: { pricing?: unknown }): Pricing | null {
  const p = entry.pricing as Record<string, unknown> | null | undefined;
  if (!p || typeof p !== "object") return null;
  const perMillion = (value: unknown) => (value === undefined || value === null || value === "" ? NaN : Number(value));
  const input = perMillion(p.input_per_million);
  const output = perMillion(p.output_per_million);
  if (Number.isFinite(input) && Number.isFinite(output)) {
    const cacheRead = perMillion(p.cache_read_input_per_million);
    return { input, output, cacheRead: Number.isFinite(cacheRead) ? cacheRead : input };
  }
  const prompt = perMillion(p.prompt) * 1_000_000;
  const completion = perMillion(p.completion) * 1_000_000;
  if (Number.isFinite(prompt) && Number.isFinite(completion) && prompt >= 0 && completion >= 0) {
    const cacheRead = perMillion(p.input_cache_read) * 1_000_000;
    return { input: prompt, output: completion, cacheRead: Number.isFinite(cacheRead) ? cacheRead : prompt };
  }
  return null;
}

/** Lists a provider's models: `GET /models` for OpenAI-style APIs, `GET /v1/models` for Anthropic. */
export async function fetchModelCatalog(provider: Pick<GatewayProvider, "type" | "baseUrl" | "apiKey">, fetchImpl: typeof fetch = fetch): Promise<CatalogModel[]> {
  const anthropic = provider.type === "anthropic";
  const url = anthropic ? `${provider.baseUrl}/v1/models?limit=1000` : `${provider.baseUrl}/models`;
  const headers: Record<string, string> = anthropic
    ? { "anthropic-version": "2023-06-01", ...(provider.apiKey ? { "x-api-key": provider.apiKey } : {}) }
    : provider.apiKey
      ? { authorization: `Bearer ${provider.apiKey}` }
      : {};
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200).replace(/\s+/g, " ");
    throw new Error(`The provider answered HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  const body = (await res.json()) as { data?: { id?: unknown; pricing?: unknown }[]; models?: { id?: unknown; name?: unknown }[] };
  const list = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
  const models: CatalogModel[] = [];
  for (const entry of list) {
    const rawId = typeof entry.id === "string" ? entry.id : typeof (entry as { name?: unknown }).name === "string" ? String((entry as { name: string }).name) : "";
    // Gemini names models "models/gemini-…"; the chat endpoint takes the short id.
    const id = rawId.replace(/^models\//, "");
    if (id) models.push({ id, price: catalogPrice(entry as { pricing?: unknown }) });
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

const CATALOG_MS = 60 * 60_000;
const CATALOG_RETRY_MS = 5 * 60_000;

export interface ProviderInput {
  name: string;
  type: ProviderType;
  baseUrl: string;
  /** Undefined keeps the current key, null removes it. */
  apiKey?: string | null;
}

/** Providers with their encrypted keys: the only place keys are decrypted, and only for the gateway and catalogs. */
export class ProviderRegistry {
  private readonly catalogs = new Map<string, { at: number; ttl: number; models: Promise<CatalogModel[]> }>();

  constructor(
    private readonly brain: Brain,
    private readonly keys: KeyStore,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  list(): Provider[] {
    return this.brain.listProviders();
  }

  gateway(id: string): GatewayProvider | null {
    const provider = this.brain.getProvider(id);
    if (!provider) return null;
    const cipher = this.brain.providerKeyCipher(id);
    let apiKey: string | null = null;
    if (cipher) {
      try {
        apiKey = this.keys.decrypt(cipher);
      } catch {
        throw new Error(`The saved API key for ${provider.name} cannot be read with this server's secret. Enter the key again on the Models page.`);
      }
    }
    return { id: provider.id, name: provider.name, type: provider.type, baseUrl: provider.baseUrl, apiKey };
  }

  create(input: ProviderInput & { id?: string }): Provider {
    const taken = new Set(this.brain.listProviders().map((p) => p.id));
    const id = input.id ?? providerIdFrom(input.name, taken);
    if (!PROVIDER_ID.test(id)) throw new Error("A provider id uses lowercase letters, digits and dashes");
    if (taken.has(id)) throw new Error(`A provider with the id ${id} already exists`);
    this.brain.createProvider({ id, name: input.name.trim(), type: input.type, baseUrl: normalizeBaseUrl(input.baseUrl) });
    if (input.apiKey) this.setKey(id, input.apiKey);
    return this.brain.getProvider(id)!;
  }

  update(id: string, input: Partial<ProviderInput>): Provider {
    if (!this.brain.getProvider(id)) throw new Error("Provider not found");
    this.brain.updateProvider(id, {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: normalizeBaseUrl(input.baseUrl) } : {}),
    });
    if (input.apiKey === null) this.brain.setProviderKey(id, null, null);
    else if (input.apiKey) this.setKey(id, input.apiKey);
    this.catalogs.delete(id);
    return this.brain.getProvider(id)!;
  }

  setKey(id: string, apiKey: string): void {
    const key = apiKey.trim();
    this.brain.setProviderKey(id, this.keys.encrypt(key), keyLast4(key));
    this.catalogs.delete(id);
  }

  /** What still uses a provider, in words for an error message. */
  usedBy(id: string): string[] {
    const users: string[] = this.brain
      .listRoleSettings()
      .filter((s) => s.provider === id)
      .map((s) => `the ${s.role} role`);
    const { escalationModel, visionModel } = spendingSettings(this.brain);
    if (escalationModel?.provider === id) users.push("the stronger model");
    if (visionModel?.provider === id) users.push("the screenshot model");
    return users;
  }

  remove(id: string): void {
    const users = this.usedBy(id);
    if (users.length) throw new Error(`This provider is still used by ${users.join(", ")}. Choose another provider there first.`);
    this.brain.deleteProvider(id);
    this.catalogs.delete(id);
  }

  /** The provider's models, cached for an hour; a failed listing is remembered for five minutes so pricing never hammers it. */
  catalog(id: string): Promise<CatalogModel[]> {
    const hit = this.catalogs.get(id);
    if (hit && this.now() - hit.at < hit.ttl) return hit.models;
    let provider: GatewayProvider | null;
    try {
      provider = this.gateway(id);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!provider) return Promise.reject(new Error("Provider not found"));
    const entry = { at: this.now(), ttl: CATALOG_MS, models: Promise.resolve<CatalogModel[]>([]) };
    entry.models = fetchModelCatalog(provider, this.fetchImpl).catch((error: unknown) => {
      entry.ttl = CATALOG_RETRY_MS;
      throw error;
    });
    // The failure is handled by whoever awaits it; this keeps a cached rejection from being reported as unhandled.
    entry.models.catch(() => {});
    this.catalogs.set(id, entry);
    return entry.models;
  }

  /** Provider names whose models are in use but that have no key (local providers need none). */
  missingKeys(): string[] {
    const used = new Set<string>(this.brain.listRoleSettings().map((s) => s.provider));
    const { escalationModel, visionModel } = spendingSettings(this.brain);
    for (const ref of [escalationModel, visionModel]) if (ref) used.add(ref.provider);
    return this.brain
      .listProviders()
      .filter((p) => used.has(p.id) && !p.hasKey && !isLocalProvider(p.baseUrl))
      .map((p) => p.name);
  }
}

/** Every provider and model the team uses: each role, the stronger model and the screenshot model. */
export function modelsInUse(brain: Brain): ModelRef[] {
  const refs: ModelRef[] = brain.listRoleSettings().map((s) => ({ provider: s.provider, model: s.model }));
  const { escalationModel, visionModel } = spendingSettings(brain);
  if (escalationModel) refs.push(escalationModel);
  if (visionModel) refs.push(visionModel);
  const seen = new Set<string>();
  return refs.filter((r) => {
    const key = `${r.provider} ${r.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
