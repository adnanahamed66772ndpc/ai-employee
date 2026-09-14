import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Brain } from "@ai-employee/brain";
import { DshSettingsWriter, renderDshSettings } from "./dshSettings.ts";

let brain: Brain;
let dir: string;
beforeEach(() => {
  brain = new Brain(":memory:");
  dir = mkdtempSync(join(tmpdir(), "ai-employee-dsh-"));
});
afterEach(() => {
  brain.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("DeepSeek Harness settings", () => {
  it("points every provider at the gateway with only the models the team uses", () => {
    const yaml = renderDshSettings(
      [
        { id: "cheaperinference", name: "CheaperInference", type: "openai", baseUrl: "https://api.cheaperinference.com/v1" },
        { id: "openai", name: "OpenAI", type: "openai", baseUrl: "https://api.openai.com/v1" },
        { id: "anthropic", name: "Anthropic", type: "anthropic", baseUrl: "https://api.anthropic.com" },
        { id: "unused", name: "Unused", type: "openai", baseUrl: "https://api.example.com/v1" },
      ],
      [
        { provider: "cheaperinference", model: "deepseek-v4-flash" },
        { provider: "openai", model: "gpt-5.4-mini" },
        { provider: "anthropic", model: "claude-sonnet-5" },
        { provider: "cheaperinference", model: "deepseek-v4-flash" },
      ],
      7717,
    );
    expect(yaml).not.toMatch(/sk-|x-api-key/);
    const providers = (parse(yaml) as { "llm-pi-ai": { providers: Record<string, Record<string, unknown>> } })["llm-pi-ai"].providers;
    expect(Object.keys(providers)).toEqual(["cheaperinference", "openai", "anthropic"]);
    expect(providers.cheaperinference).toEqual({
      displayName: "CheaperInference",
      apiKeyEnv: "AI_EMPLOYEE_GATEWAY_TOKEN",
      api: "openai-completions",
      baseURL: "http://127.0.0.1:7717/llm/p/cheaperinference/v1",
      compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
      models: [{ id: "deepseek-v4-flash", compat: { thinkingFormat: "deepseek" } }],
    });
    expect(providers.openai).toMatchObject({ compat: { maxTokensField: "max_completion_tokens" }, models: [{ id: "gpt-5.4-mini" }] });
    expect(providers.anthropic).toEqual({
      displayName: "Anthropic",
      apiKeyEnv: "AI_EMPLOYEE_GATEWAY_TOKEN",
      api: "anthropic-messages",
      baseURL: "http://127.0.0.1:7717/llm/p/anthropic",
      models: [{ id: "claude-sonnet-5" }],
    });
  });

  it("rewrites the files when a model or provider changes, and leaves them alone otherwise", () => {
    const paths = [join(dir, "server", "settings.yaml"), join(dir, "shared", "dsh", "settings.yaml")];
    const writer = new DshSettingsWriter({ brain, port: 7717, paths, log: () => {} });
    writer.start();
    expect(readFileSync(paths[1]!, "utf8")).toContain("deepseek-v4-flash");
    expect(writer.write()).toEqual([]);

    brain.createProvider({ id: "openai", name: "OpenAI", type: "openai", baseUrl: "https://api.openai.com/v1" });
    brain.setRoleSetting("coder", "openai", "gpt-5.4");
    for (const path of paths) expect(readFileSync(path, "utf8")).toContain("gpt-5.4");
    writer.stop();
  });
});
