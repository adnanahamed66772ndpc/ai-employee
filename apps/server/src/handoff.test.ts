import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseHandoffReply, planHandoffWrite, writeTemplate } from "./handoff.ts";

const at = new Date(2026, 8, 13, 14, 5);

describe("handoff replies", () => {
  it("reads the file blocks and ignores unknown files", () => {
    const reply = [
      "Here are the notes.",
      "=== .ai/HANDOFF.md ===",
      "# Handoff",
      "",
      "Done.",
      "=== end ===",
      "=== .ai/SECRETS.md ===",
      "nope",
      "=== end ===",
      "=== .ai/TASKS.md ===",
      "# Tasks",
      "=== end ===",
    ].join("\n");
    expect(parseHandoffReply(reply).files).toEqual({ "HANDOFF.md": "# Handoff\n\nDone.\n", "TASKS.md": "# Tasks\n" });
  });

  it("archives the old handoff, replaces handoff and tasks, and appends decisions", () => {
    const current = { "HANDOFF.md": "# Handoff\n\n## Current state\n\nOld.\n", "TASKS.md": "# Tasks\n" };
    const reply = { files: { "HANDOFF.md": "# Handoff\n\nNew.\n", "TASKS.md": "# Tasks\n\n- done\n", "DECISIONS.md": "## D1 — Use SQLite\n" } };
    const { ops, skipped } = planHandoffWrite(current, reply, at);

    expect(skipped).toEqual([]);
    expect(ops.map((op) => [op.path, op.mode])).toEqual([
      [".ai/history/2026-09-13.md", "append"],
      [".ai/HANDOFF.md", "write"],
      [".ai/TASKS.md", "write"],
      [".ai/DECISIONS.md", "append"],
    ]);
    const archive = ops[0]!;
    expect(archive.header).toBe("# 2026-09-13\n");
    expect(archive.content).toContain("## Handoff archived at 14:05");
    expect(archive.content).toContain("### Handoff\n");
    expect(archive.content).toContain("#### Current state");
    expect(ops[3]!.header).toContain("# Decisions");
  });

  it("refuses unusable replies and keeps a file that a reply would gut", () => {
    expect(() => planHandoffWrite({}, { files: { "TASKS.md": "# Tasks\n" } }, at)).toThrow(/HANDOFF/);
    expect(() => planHandoffWrite({}, { files: { "HANDOFF.md": "token ghp_abcdefghijklmnopqrstuvwxyz123456\n" } }, at)).toThrow(/secret/);

    const conventions = `# Conventions\n\n${"- a rule that matters\n".repeat(40)}`;
    const { ops, skipped } = planHandoffWrite({ "CONVENTIONS.md": conventions }, { files: { "HANDOFF.md": "# Handoff\n", "CONVENTIONS.md": "# Conventions\n" } }, at);
    expect(skipped).toEqual(["CONVENTIONS.md"]);
    expect(ops.map((op) => op.path)).toEqual([".ai/HANDOFF.md"]);
  });
});

describe("handoff template", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates every file once and never touches an existing .ai folder", () => {
    dir = mkdtempSync(join(tmpdir(), "ai-employee-handoff-"));
    expect(writeTemplate(dir, "Shop", "main", at)).toEqual([".ai/HANDOFF.md", ".ai/ARCHITECTURE.md", ".ai/DECISIONS.md", ".ai/TASKS.md", ".ai/CONVENTIONS.md"]);
    expect(readFileSync(join(dir, ".ai", "HANDOFF.md"), "utf8")).toContain("Base branch: `main`");

    writeFileSync(join(dir, ".ai", "HANDOFF.md"), "mine\n");
    expect(writeTemplate(dir, "Shop", "main", at)).toEqual([]);
    expect(readFileSync(join(dir, ".ai", "HANDOFF.md"), "utf8")).toBe("mine\n");
  });
});
