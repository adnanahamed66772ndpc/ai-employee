import { describe, expect, it } from "vitest";
import { containsSecret } from "./secrets.ts";

describe("containsSecret", () => {
  it.each([
    ["OpenAI", "sk-proj-abcdefghijklmnop1234"],
    ["Anthropic", "sk-ant-api03-abcdefghijklmnop1234"],
    ["Gemini", "AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q"],
    ["NVIDIA", "nvapi-Ab12Cd34Ef56Gh78Ij90Kl12Mn34"],
    ["Groq", "gsk_Ab12Cd34Ef56Gh78Ij90Kl12Mn34"],
    ["xAI", "xai-Ab12Cd34Ef56Gh78Ij90Kl12Mn34"],
    ["GitHub", "ghp_abcdefghijklmnopqrstuvwxyz123456"],
  ])("finds a %s key", (_name, key) => {
    expect(containsSecret(`const key = "${key}";`)).toBe(true);
  });

  it("leaves ordinary text alone", () => {
    expect(containsSecret("Use the xai-grok model through the gateway; AIza is a prefix, gsk_ too.")).toBe(false);
  });
});
