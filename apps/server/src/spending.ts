import type { Brain } from "@ai-employee/brain";

/*
 * Server-wide spending rules the owner sets on the Models page: a daily budget for all projects together, and a
 * stronger model the Coder gets one more try with when the cheap model's rounds did not get a change accepted.
 */

export const DEFAULT_DAILY_BUDGET_USD = 2;
export const DEFAULT_ESCALATION_MODEL = "deepseek-v4-pro";
/** Looks at the running app's screenshots for the UI critic; it must understand images. */
export const DEFAULT_VISION_MODEL = "glm-5.3-flash";

export interface SpendingSettings {
  /** null: no daily limit. */
  dailyBudgetUsd: number | null;
  /** null: no second try. */
  escalationModel: string | null;
  /** null: screenshots are not reviewed (the free page checks still run). */
  visionModel: string | null;
}

export function spendingSettings(brain: Brain): SpendingSettings {
  return {
    dailyBudgetUsd: brain.getAppSetting<number | null>("dailyBudgetUsd", DEFAULT_DAILY_BUDGET_USD),
    escalationModel: brain.getAppSetting<string | null>("escalationModel", DEFAULT_ESCALATION_MODEL),
    visionModel: brain.getAppSetting<string | null>("visionModel", DEFAULT_VISION_MODEL),
  };
}

/** Midnight at the start of `now`'s day, in the server's time zone. */
export function startOfDay(now: Date): Date {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day;
}

/** The next midnight, when the daily budget starts over. */
export function nextDay(now: Date): Date {
  const day = startOfDay(now);
  day.setDate(day.getDate() + 1);
  return day;
}

export function todaySpend(brain: Brain, now = new Date()): number {
  return brain.costSince(startOfDay(now).toISOString());
}

export function dailyBudgetMessage(spent: number, budget: number): string {
  return `Stopped: all tasks together spent $${spent.toFixed(4)} today, which reached the $${budget} daily budget. Raise it on the Models page, or wait until it resets at midnight.`;
}
