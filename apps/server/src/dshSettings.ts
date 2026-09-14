import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stringify } from "yaml";
import type { Brain, BrainChange, Provider } from "@ai-employee/brain";
import { modelsInUse } from "./providers.ts";
import type { ModelRef } from "./spending.ts";

/*
 * DeepSeek Harness learns its providers and models from settings.yaml. The server writes that file from the Models
 * page: every provider points at the server's local gateway (which adds the real key), and each provider lists the
 * models the team uses. DeepSeek Harness re-reads the file, so a change applies to the next session.
 */

/** The key variable DeepSeek Harness sends; the gateway ignores its value and uses the provider's real key. */
export const GATEWAY_TOKEN_ENV = "AI_EMPLOYEE_GATEWAY_TOKEN";
export const GATEWAY_TOKEN_PLACEHOLDER = "supplied-by-ai-employee-gateway";

/** The gateway address for a provider. The Anthropic client adds `/v1/messages` itself. */
export function gatewayBaseUrl(provider: Pick<Provider, "id" | "type">, port: number): string {
  const root = `http://127.0.0.1:${port}/llm/p/${provider.id}`;
  return provider.type === "anthropic" ? root : `${root}/v1`;
}

/** OpenAI's own API wants `max_completion_tokens` for its reasoning models; OpenAI-compatible APIs take `max_tokens`. */
const maxTokensField = (baseUrl: string) => (new URL(baseUrl).hostname === "api.openai.com" ? "max_completion_tokens" : "max_tokens");

export function renderDshSettings(providers: Pick<Provider, "id" | "name" | "type" | "baseUrl">[], models: ModelRef[], port: number): string {
  const entries: Record<string, unknown> = {};
  for (const provider of providers) {
    const ids = [...new Set(models.filter((m) => m.provider === provider.id).map((m) => m.model))].sort();
    if (ids.length === 0) continue;
    const openaiStyle = provider.type !== "anthropic";
    entries[provider.id] = {
      displayName: provider.name,
      apiKeyEnv: GATEWAY_TOKEN_ENV,
      api: openaiStyle ? "openai-completions" : "anthropic-messages",
      baseURL: gatewayBaseUrl(provider, port),
      ...(openaiStyle ? { compat: { supportsDeveloperRole: false, maxTokensField: maxTokensField(provider.baseUrl) } } : {}),
      models: ids.map((id) => ({ id, ...(openaiStyle && /(^|\/)deepseek/i.test(id) ? { compat: { thinkingFormat: "deepseek" } } : {}) })),
    };
  }
  return [
    "# Written by the AI Employee server from the Models page; edits here are overwritten.",
    "# Every provider points at the server's local gateway, which adds the real API key.",
    stringify({ "llm-pi-ai": { providers: entries } }),
  ].join("\n");
}

/** Keeps settings.yaml in step with the Models page, for the server's own DeepSeek Harness and the agent user's. */
export class DshSettingsWriter {
  private readonly onChange = (change: BrainChange) => {
    if (change.kind === "settings") this.write();
  };

  constructor(
    private readonly options: {
      brain: Brain;
      port: number;
      /** Where to write: the server's .dsh-home, plus the shared copy the agent user's settings link to. */
      paths: string[];
      log: (message: string) => void;
    },
  ) {}

  /** Writes the settings wherever they changed and returns those paths. */
  write(): string[] {
    const { brain, port, paths, log } = this.options;
    const yaml = renderDshSettings(brain.listProviders(), modelsInUse(brain), port);
    const written: string[] = [];
    for (const path of paths) {
      try {
        if (existsSync(path) && readFileSync(path, "utf8") === yaml) continue;
        mkdirSync(dirname(path), { recursive: true });
        // No secrets inside: the agent user must be able to read the shared copy.
        writeFileSync(path, yaml, { mode: 0o644 });
        try {
          chmodSync(path, 0o644);
        } catch {
          // Windows has no Unix modes.
        }
        written.push(path);
      } catch (error) {
        log(`could not write DeepSeek Harness settings to ${path}: ${(error as Error).message}`);
      }
    }
    return written;
  }

  start(): void {
    this.write();
    this.options.brain.on("change", this.onChange);
  }

  stop(): void {
    this.options.brain.off("change", this.onChange);
  }
}
