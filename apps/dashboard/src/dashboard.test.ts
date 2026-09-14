import { describe, expect, it } from "vitest";
import type { BrainEvent, Task } from "./api.ts";
import { parseDiff } from "./components/DiffView.tsx";
import { parseMarkdown } from "./components/Markdown.tsx";
import { deriveStations } from "./components/StationRail.tsx";
import { relativePath, tokens, usd } from "./format.ts";

const task = (patch: Partial<Task>): Task => ({
  id: "t1",
  sessionId: "s1",
  projectId: "p1",
  prompt: "Add a coupon field",
  kind: "code",
  goalId: null,
  epicId: null,
  epicPosition: null,
  status: "queued",
  plan: null,
  branch: null,
  baseBranch: null,
  worktreePath: null,
  commitSha: null,
  prUrl: null,
  reviewRounds: 0,
  error: null,
  claimedBy: null,
  createdAt: "2026-09-13T10:00:00.000Z",
  updatedAt: "2026-09-13T10:00:00.000Z",
  ...patch,
});

let nextId = 1;
const event = (type: string, payload: Record<string, unknown> = {}): BrainEvent => ({
  id: nextId++,
  taskId: "t1",
  runId: null,
  type,
  payload,
  createdAt: "2026-09-13T10:00:00.000Z",
});

describe("format", () => {
  it("shows small costs and token counts readably", () => {
    expect(usd(0)).toBe("$0");
    expect(usd(0.00164)).toBe("$0.0016");
    expect(usd(1.5)).toBe("$1.50");
    expect(tokens(950)).toBe("950");
    expect(tokens(1234)).toBe("1.2k");
    expect(tokens(45_600)).toBe("46k");
    expect(tokens(2_500_000)).toBe("2.5M");
  });

  it("shortens paths inside the project folder only", () => {
    expect(relativePath("/srv/ai-projects/shop/src/a.ts", "/srv/ai-projects/shop")).toBe("src/a.ts");
    expect(relativePath("/etc/passwd", "/srv/ai-projects/shop")).toBe("/etc/passwd");
  });
});

describe("station rail", () => {
  it("follows a task from plan to waiting for the owner", () => {
    const events = [
      event("branch_created", { base: "main" }),
      event("plan_ready", { plan: {} }),
      event("round_started", { round: 1 }),
      event("check_finished", { ok: true }),
      event("review_verdict", { approved: true }),
      event("committed", { sha: "abcdef1234" }),
    ];
    const stations = deriveStations(task({ status: "awaiting_approval" }), events);
    expect(stations.map((s) => s.state)).toEqual(["done", "done", "done", "done", "done", "skipped", "done", "needs"]);
    expect(stations.find((s) => s.key === "commit")!.note).toBe("abcdef1");
  });

  it("shows the critics' final round", () => {
    const events = [
      event("review_verdict", { approved: true }),
      event("critic_verdict", { critic: "ui", passed: false }),
      event("critic_verdict", { critic: "security", passed: true }),
      event("critic_verdict", { critic: "ui", passed: true }),
    ];
    const critics = (status: Task["status"]) => deriveStations(task({ status }), events).find((s) => s.key === "critics")!;
    expect(critics("coding")).toMatchObject({ state: "done", note: "Passed" });
    expect(critics("reviewing").state).toBe("active");
    expect(deriveStations(task({ status: "needs_human" }), events.slice(0, 2)).find((s) => s.key === "critics")!.state).toBe("attention");
  });

  it("marks where a failed task stopped", () => {
    const stations = deriveStations(task({ status: "failed" }), [event("branch_created", { base: "main" })]);
    expect(stations.find((s) => s.state === "failed")?.key).toBe("plan");
  });
});

describe("diff and markdown parsing", () => {
  it("splits a diff per file", () => {
    const diff = [
      "diff --git a/.ai/HANDOFF.md b/.ai/HANDOFF.md",
      "--- a/.ai/HANDOFF.md",
      "+++ b/.ai/HANDOFF.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/hello.txt b/hello.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/hello.txt",
      "@@ -0,0 +1 @@",
      "+hello",
    ].join("\n");
    expect(parseDiff(diff).map((file) => file.path)).toEqual([".ai/HANDOFF.md", "hello.txt"]);
  });

  it("keeps numbered lists together across blank lines", () => {
    const blocks = parseMarkdown("1. one\n\n2. two\n\n3. three");
    expect(blocks).toHaveLength(1);
  });
});
