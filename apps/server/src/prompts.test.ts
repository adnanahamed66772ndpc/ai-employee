import { expect, it } from "vitest";
import { extractJson, isApproved, truncate } from "./prompts.ts";

it("extracts the last fenced JSON block, falling back to bare braces", () => {
  const reply = 'Plan below.\n```json\n{"steps": ["old"]}\n```\nRevised:\n```json\n{"steps": ["new"]}\n```';
  expect(extractJson<{ steps: string[] }>(reply)).toEqual({ steps: ["new"] });
  expect(extractJson('Verdict: {"approve": true, "issues": []} done')).toEqual({ approve: true, issues: [] });
  expect(extractJson("no json here")).toBeNull();
});

it("does not approve when blocking issues remain", () => {
  expect(isApproved({ approve: true, issues: [{ severity: "minor" }] })).toBe(true);
  expect(isApproved({ approve: true, issues: [{ severity: "Major" }] })).toBe(false);
  expect(isApproved({ approve: false })).toBe(false);
});

it("truncates long text with a marker", () => {
  expect(truncate("abcdef", 3)).toBe("abc\n… [truncated 3 characters]");
  expect(truncate("abc", 3)).toBe("abc");
});
