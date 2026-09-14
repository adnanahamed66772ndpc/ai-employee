import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Brain } from "@ai-employee/brain";
import { dailyBudgetMessage, nextDay, sameModel, spendingSettings, startOfDay, toModelRef } from "./spending.ts";

let brain: Brain;
beforeEach(() => {
  brain = new Brain(":memory:");
});
afterEach(() => brain.close());

describe("spending", () => {
  it("defaults to a $2 day and deepseek-v4-pro at CheaperInference, and keeps a saved 'off'", () => {
    expect(spendingSettings(brain)).toEqual({
      dailyBudgetUsd: 2,
      escalationModel: { provider: "cheaperinference", model: "deepseek-v4-pro" },
      visionModel: { provider: "cheaperinference", model: "glm-5.3-flash" },
    });
    brain.setAppSetting("dailyBudgetUsd", null);
    brain.setAppSetting("escalationModel", null);
    expect(spendingSettings(brain)).toMatchObject({ dailyBudgetUsd: null, escalationModel: null });
  });

  it("reads model choices saved before providers existed as CheaperInference models", () => {
    expect(toModelRef("glm-5.3")).toEqual({ provider: "cheaperinference", model: "glm-5.3" });
    expect(toModelRef({ provider: "openai", model: "gpt-5.4" })).toEqual({ provider: "openai", model: "gpt-5.4" });
    expect(toModelRef({ provider: "openai" })).toBeNull();
    expect(toModelRef("")).toBeNull();
    expect(sameModel({ provider: "a", model: "m" }, { provider: "a", model: "m" })).toBe(true);
    expect(sameModel({ provider: "a", model: "m" }, { provider: "b", model: "m" })).toBe(false);
  });

  it("counts the day from local midnight", () => {
    const now = new Date(2026, 8, 14, 15, 30);
    expect(startOfDay(now)).toEqual(new Date(2026, 8, 14));
    expect(nextDay(now)).toEqual(new Date(2026, 8, 15));
    expect(dailyBudgetMessage(2.00341, 2)).toMatch(/\$2\.0034 today.*\$2 daily budget/);
  });
});
