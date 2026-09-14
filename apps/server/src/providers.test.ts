import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Brain } from "@ai-employee/brain";
import { KeyStore } from "./keystore.ts";
import { catalogPrice, fetchModelCatalog, isLocalProvider, modelsInUse, normalizeBaseUrl, providerIdFrom, ProviderRegistry } from "./providers.ts";

let brain: Brain;
beforeEach(() => {
  brain = new Brain(":memory:");
});
afterEach(() => brain.close());

describe("provider helpers", () => {
  it("accepts only http(s) base URLs without credentials", () => {
    expect(normalizeBaseUrl(" https://api.openai.com/v1/ ")).toBe("https://api.openai.com/v1");
    expect(normalizeBaseUrl("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434/v1");
    expect(() => normalizeBaseUrl("file:///etc/passwd")).toThrow(/https:\/\/ or http:\/\//);
    expect(() => normalizeBaseUrl("https://user:secret@api.example.com")).toThrow(/API key field/);
    expect(() => normalizeBaseUrl("not a url")).toThrow(/full address/);
    expect(isLocalProvider("http://localhost:1234/v1")).toBe(true);
    expect(isLocalProvider("https://api.deepseek.com/v1")).toBe(false);
  });

  it("makes unique ids from names", () => {
    expect(providerIdFrom("Google Gemini", new Set())).toBe("google-gemini");
    expect(providerIdFrom("OpenAI", new Set(["openai", "openai-2"]))).toBe("openai-3");
    expect(providerIdFrom("!!!", new Set())).toBe("provider");
  });

  it("reads prices from CheaperInference and OpenRouter model lists", () => {
    expect(catalogPrice({ pricing: { input_per_million: 0.27, output_per_million: 1.1, cache_read_input_per_million: 0.07 } })).toEqual({ input: 0.27, output: 1.1, cacheRead: 0.07 });
    expect(catalogPrice({ pricing: { prompt: "0.0000025", completion: "0.00001" } })).toEqual({ input: 2.5, output: 10, cacheRead: 2.5 });
    expect(catalogPrice({ pricing: null })).toBeNull();
    expect(catalogPrice({})).toBeNull();
  });

  it("lists models the way each API type expects", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
      if (String(url).includes("anthropic")) return Response.json({ data: [{ id: "claude-sonnet-5" }] });
      if (String(url).includes("googleapis")) return Response.json({ data: [{ id: "models/gemini-3.7-flash" }] });
      return Response.json({ data: [{ id: "b-model" }, { id: "a-model", pricing: { input_per_million: 1, output_per_million: 2 } }] });
    }) as typeof fetch;

    expect(await fetchModelCatalog({ type: "openai", baseUrl: "https://api.example.com/v1", apiKey: "k1" }, fetchImpl)).toEqual([
      { id: "a-model", price: { input: 1, output: 2, cacheRead: 1 } },
      { id: "b-model", price: null },
    ]);
    expect(await fetchModelCatalog({ type: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "k2" }, fetchImpl)).toEqual([{ id: "claude-sonnet-5", price: null }]);
    expect(await fetchModelCatalog({ type: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: "k3" }, fetchImpl)).toEqual([
      { id: "gemini-3.7-flash", price: null },
    ]);
    expect(calls[0]).toEqual({ url: "https://api.example.com/v1/models", headers: { authorization: "Bearer k1" } });
    expect(calls[1]).toEqual({ url: "https://api.anthropic.com/v1/models?limit=1000", headers: { "anthropic-version": "2023-06-01", "x-api-key": "k2" } });

    const failing = (async () => new Response("invalid key", { status: 401 })) as typeof fetch;
    await expect(fetchModelCatalog({ type: "openai", baseUrl: "https://api.example.com/v1", apiKey: "bad" }, failing)).rejects.toThrow(/HTTP 401: invalid key/);
  });
});

describe("provider registry", () => {
  it("keeps keys encrypted in the brain and hands them only to the gateway", () => {
    const registry = new ProviderRegistry(brain, KeyStore.fromSecret(randomBytes(32)));
    const provider = registry.create({ name: "OpenAI", type: "openai", baseUrl: "https://api.openai.com/v1/", apiKey: "sk-proj-abcdefghijkl9876" });
    expect(provider).toMatchObject({ id: "openai", hasKey: true, keyLast4: "9876", baseUrl: "https://api.openai.com/v1" });
    expect(JSON.stringify(registry.list())).not.toContain("abcdefghijkl");
    expect(brain.providerKeyCipher("openai")).toMatch(/^v1:/);
    expect(registry.gateway("openai")).toMatchObject({ apiKey: "sk-proj-abcdefghijkl9876", type: "openai" });

    // An update without a key keeps it; null removes it.
    registry.update("openai", { name: "OpenAI (work)" });
    expect(registry.gateway("openai")?.apiKey).toBe("sk-proj-abcdefghijkl9876");
    registry.update("openai", { apiKey: null });
    expect(brain.getProvider("openai")).toMatchObject({ hasKey: false, keyLast4: null });
    expect(() => registry.create({ name: "Bad", type: "openai", baseUrl: "ftp://example.com" })).toThrow();
  });

  it("explains a key saved under another server secret", () => {
    registryWith(KeyStore.fromSecret(randomBytes(32))).setKey("cheaperinference", "ci-key-1234567890");
    expect(() => registryWith(KeyStore.fromSecret(randomBytes(32))).gateway("cheaperinference")).toThrow(/Enter the key again/);
  });

  it("will not remove a provider an agent, the stronger model or the screenshot model still uses", () => {
    const registry = registryWith(KeyStore.fromSecret(randomBytes(32)));
    registry.create({ name: "DeepSeek", type: "openai", baseUrl: "https://api.deepseek.com/v1" });
    brain.setAppSetting("visionModel", { provider: "deepseek", model: "vision-1" });
    expect(() => registry.remove("deepseek")).toThrow(/the screenshot model/);
    expect(() => registry.remove("cheaperinference")).toThrow(/the coder role/);
    brain.setAppSetting("visionModel", null);
    registry.remove("deepseek");
    expect(brain.getProvider("deepseek")).toBeNull();
  });

  it("lists providers in use without a key, and every model the team uses once", () => {
    const registry = registryWith(KeyStore.fromSecret(randomBytes(32)));
    expect(registry.missingKeys()).toEqual(["CheaperInference"]);
    registry.create({ name: "Ollama", type: "openai", baseUrl: "http://127.0.0.1:11434/v1" });
    brain.setRoleSetting("git", "ollama", "llama3.1:8b");
    expect(registry.missingKeys()).toEqual(["CheaperInference"]);
    expect(modelsInUse(brain)).toEqual([
      { provider: "cheaperinference", model: "deepseek-v4-flash" },
      { provider: "ollama", model: "llama3.1:8b" },
      { provider: "cheaperinference", model: "deepseek-v4-pro" },
      { provider: "cheaperinference", model: "glm-5.3-flash" },
    ]);
  });
});

function registryWith(keys: KeyStore): ProviderRegistry {
  return new ProviderRegistry(brain, keys);
}
