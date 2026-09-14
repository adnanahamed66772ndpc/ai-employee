import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Brain } from "@ai-employee/brain";
import { dailyBudgetMessage, nextDay, spendingSettings, startOfDay } from "./spending.ts";

let brain: Brain;
beforeEach(() => {
  brain = new Brain(":memory:");
});
afterEach(() => brain.close());

describe("spending", () => {
  it("defaults to a $2 day and deepseek-v4-pro, and keeps a saved 'off'", () => {
    expect(spendingSettings(brain)).toEqual({ dailyBudgetUsd: 2, escalationModel: "deepseek-v4-pro", visionModel: "glm-5.3-flash" });
    brain.setAppSetting("dailyBudgetUsd", null);
    brain.setAppSetting("escalationModel", null);
    expect(spendingSettings(brain)).toEqual({ dailyBudgetUsd: null, escalationModel: null, visionModel: "glm-5.3-flash" });
  });

  it("counts the day from local midnight", () => {
    const now = new Date(2026, 8, 14, 15, 30);
    expect(startOfDay(now)).toEqual(new Date(2026, 8, 14));
    expect(nextDay(now)).toEqual(new Date(2026, 8, 15));
    expect(dailyBudgetMessage(2.00341, 2)).toMatch(/\$2\.0034 today.*\$2 daily budget/);
  });
});
