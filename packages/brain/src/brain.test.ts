import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Brain, memorySimilarity } from "./brain.ts";
import { migrate } from "./schema.ts";

let brain: Brain;
beforeEach(() => {
  brain = new Brain(":memory:");
});
afterEach(() => brain.close());

const twoProjects = () => ({
  a: brain.createProject({ name: "App A", localPath: "D:/work/a" }),
  b: brain.createProject({ name: "App B", localPath: "D:/work/b" }),
});

describe("memory scopes", () => {
  it("shows global memory everywhere but project memory only in its own project", () => {
    const { a, b } = twoProjects();
    brain.addMemory({ scope: "global", kind: "preference", content: "Use strict TypeScript everywhere" });
    brain.addMemory({ scope: "project", projectId: a.id, kind: "convention", content: "App A runs tests with npm run test:unit" });
    brain.addMemory({ scope: "project", projectId: b.id, kind: "convention", content: "App B runs tests with pnpm vitest" });

    const seenByA = brain.listMemories({ visibleTo: a.id }).map((m) => m.content);
    expect(seenByA).toContain("Use strict TypeScript everywhere");
    expect(seenByA).toContain("App A runs tests with npm run test:unit");
    expect(seenByA).not.toContain("App B runs tests with pnpm vitest");

    expect(brain.searchMemories(b.id, "tests").map((m) => m.content)).toEqual(["App B runs tests with pnpm vitest"]);
    expect(brain.searchMemories(null, "tests")).toEqual([]);
    expect(brain.listMemories({ scope: "global" })).toHaveLength(1);
  });

  it("matches word prefixes and ignores FTS syntax in the query", () => {
    const { a } = twoProjects();
    brain.addMemory({ scope: "project", projectId: a.id, content: "Authentication uses magic links" });
    expect(brain.searchMemories(a.id, "auth")).toHaveLength(1);
    expect(brain.searchMemories(a.id, 'AUTH" OR *) NEAR(')).toHaveLength(1);
  });

  it("keeps search in sync after edits, scope moves and deletes", () => {
    const { a, b } = twoProjects();
    const m = brain.addMemory({ scope: "project", projectId: a.id, content: "Prefer small pull requests" });
    brain.updateMemory(m.id, { scope: "global" });
    expect(brain.searchMemories(b.id, "pull").map((x) => x.id)).toEqual([m.id]);

    brain.updateMemory(m.id, { content: "Prefer tiny commits" });
    expect(brain.searchMemories(b.id, "pull")).toEqual([]);
    expect(brain.searchMemories(b.id, "commits")).toHaveLength(1);

    brain.deleteMemory(m.id);
    expect(brain.searchMemories(b.id, "commits")).toEqual([]);
  });

  it("rejects project memory without a project", () => {
    expect(() => brain.addMemory({ scope: "project", content: "orphan" })).toThrow(/projectId/);
  });
});

describe("tasks and approvals", () => {
  it("claims each queued task exactly once, oldest first", () => {
    const { a } = twoProjects();
    const session = brain.createSession(a.id, "Session 1");
    const first = brain.createTask(session.id, "first");
    const second = brain.createTask(session.id, "second");

    expect(brain.claimNextTask("w1")?.id).toBe(first.id);
    expect(brain.claimNextTask("w1")?.id).toBe(second.id);
    expect(brain.claimNextTask("w1")).toBeNull();
    expect(brain.getTask(first.id)?.status).toBe("planning");
  });

  it("stores plans as JSON and fails interrupted tasks on restart", () => {
    const { a } = twoProjects();
    const task = brain.createTask(brain.createSession(a.id, "s").id, "do it");
    brain.claimNextTask("w1");
    brain.updateTask(task.id, { status: "coding", plan: { steps: ["one"] } });
    expect(brain.getTask(task.id)?.plan).toEqual({ steps: ["one"] });
    expect(brain.failInterruptedTasks()).toEqual([task.id]);
    expect(brain.getTask(task.id)).toMatchObject({ status: "failed", error: "Interrupted: server restarted" });
  });

  it("decides an approval only once", () => {
    const { a } = twoProjects();
    const task = brain.createTask(brain.createSession(a.id, "s").id, "do it");
    const approval = brain.createApproval(task.id, "push_and_pr", "Push branch and open PR");
    expect(brain.decideApproval(approval.id, "approved")?.status).toBe("approved");
    expect(brain.decideApproval(approval.id, "rejected")).toBeNull();
  });

  it("emits change events and pages events by id", () => {
    const { a } = twoProjects();
    const task = brain.createTask(brain.createSession(a.id, "s").id, "do it");
    const seen: string[] = [];
    brain.on("change", (c) => seen.push(c.kind));
    const e1 = brain.addEvent(task.id, "log", { text: "hello" });
    brain.addEvent(task.id, "log", { text: "world" });
    expect(brain.listEvents(task.id, e1.id).map((e) => e.payload.text)).toEqual(["world"]);
    expect(seen).toEqual(["event", "event"]);
  });
});

describe("project settings and usage", () => {
  it("stores the setup command and task budget", () => {
    const project = brain.createProject({ name: "App", localPath: "D:/work/app", setupCmd: "npm ci", taskBudgetUsd: 0.5 });
    expect(project).toMatchObject({ setupCmd: "npm ci", taskBudgetUsd: 0.5 });
    expect(brain.updateProject(project.id, { taskBudgetUsd: null })).toMatchObject({ setupCmd: "npm ci", taskBudgetUsd: null });
  });

  it("adds up tokens and cost per run and per task", () => {
    const { a } = twoProjects();
    const task = brain.createTask(brain.createSession(a.id, "s").id, "do it");
    const planner = brain.startRun(task.id, "planner", "cheaperinference", "deepseek-v4-flash");
    const coder = brain.startRun(task.id, "coder", "cheaperinference", "deepseek-v4-flash");
    brain.recordUsage(planner.id, { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, costUsd: 0.001 });
    brain.recordUsage(planner.id, { inputTokens: 500, outputTokens: 50, cacheReadTokens: 400, costUsd: 0.0005 });
    brain.recordUsage(coder.id, { inputTokens: 2000, outputTokens: 300, cacheReadTokens: 0, costUsd: 0.002 });

    expect(brain.getRun(planner.id)).toMatchObject({ inputTokens: 1500, outputTokens: 150, cacheReadTokens: 400 });
    const total = brain.taskUsage(task.id);
    expect(total).toMatchObject({ inputTokens: 3500, outputTokens: 450, cacheReadTokens: 400 });
    expect(total.costUsd).toBeCloseTo(0.0035, 10);
  });
});

describe("memory de-duplication", () => {
  it("scores word overlap", () => {
    expect(memorySimilarity("Run tests with npm test", "run TESTS with npm test.")).toBe(1);
    expect(memorySimilarity("Use pnpm", "Use npm")).toBeCloseTo(1 / 3);
    expect(memorySimilarity("", "anything")).toBe(0);
  });

  it("skips near-identical memories in the places they would be read together", () => {
    const { a, b } = twoProjects();
    const first = brain.rememberMemory({ scope: "project", projectId: a.id, kind: "fact", content: "The API tests run with npm run test:api" });
    expect(first.duplicate).toBe(false);

    const again = brain.rememberMemory({ scope: "project", projectId: a.id, kind: "fact", content: "the API tests run with `npm run test:api`" });
    expect(again).toMatchObject({ duplicate: true, memory: { id: first.memory.id } });

    // Another project may hold the same sentence, and a different fact is not a duplicate.
    expect(brain.rememberMemory({ scope: "project", projectId: b.id, content: "The API tests run with npm run test:api" }).duplicate).toBe(false);
    expect(brain.rememberMemory({ scope: "project", projectId: a.id, content: "The API tests need a running Postgres" }).duplicate).toBe(false);

    // A project memory that repeats a global preference is a duplicate too.
    brain.addMemory({ scope: "global", kind: "preference", content: "Write commit messages in English" });
    expect(brain.rememberMemory({ scope: "project", projectId: b.id, content: "Write commit messages in English" }).duplicate).toBe(true);
  });
});

describe("critics", () => {
  it("upgrades an older brain to the critic role without losing run links", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-employee-brain-"));
    const path = join(dir, "brain.db");
    try {
      const old = new DatabaseSync(path);
      migrate(old, 2);
      old.exec(`
        insert into projects (id, name, local_path) values ('p1', 'Shop', '/srv/shop');
        insert into sessions (id, project_id, title) values ('s1', 'p1', 'Session');
        insert into tasks (id, session_id, project_id, prompt) values ('t1', 's1', 'p1', 'do it');
        insert into agent_runs (id, task_id, role, cost_usd) values ('r1', 't1', 'reviewer', 0.5);
        insert into events (task_id, run_id, type) values ('t1', 'r1', 'agent_started');
      `);
      old.close();

      const upgraded = new Brain(path);
      try {
        expect(upgraded.listEvents("t1")[0]?.runId).toBe("r1");
        expect(upgraded.getRun("r1")).toMatchObject({ role: "reviewer", purpose: null, costUsd: 0.5 });
        expect(upgraded.getRoleSetting("critic")).toMatchObject({ provider: "cheaperinference", model: "deepseek-v4-flash" });
        expect(upgraded.getProject("p1")?.disabledCritics).toEqual([]);
        const run = upgraded.startRun("t1", "critic", "cheaperinference", "deepseek-v4-flash", "ui");
        expect(run).toMatchObject({ role: "critic", purpose: "ui" });
      } finally {
        upgraded.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores which critics a project turned off", () => {
    const project = brain.createProject({ name: "Shop", localPath: "D:/work/shop", disabledCritics: ["ui"] });
    expect(project.disabledCritics).toEqual(["ui"]);
    expect(brain.updateProject(project.id, { disabledCritics: [] }).disabledCritics).toEqual([]);
  });

  it("counts problems found on first look, problems fixed later, and cost per critic", () => {
    const { a } = twoProjects();
    const task = brain.createTask(brain.createSession(a.id, "s").id, "Build the cart page");
    const ui = brain.startRun(task.id, "critic", "cheaperinference", "deepseek-v4-flash", "ui");
    brain.recordUsage(ui.id, { inputTokens: 4000, outputTokens: 300, cacheReadTokens: 0, costUsd: 0.0004 });
    brain.addEvent(task.id, "critic_verdict", { critic: "ui", round: 1, findings: [{ problem: "a" }, { problem: "b" }] });
    brain.addEvent(task.id, "critic_verdict", { critic: "ui", round: 2, findings: [{ problem: "b" }] });
    brain.addEvent(task.id, "critic_verdict", { critic: "security", round: 1, findings: [] });

    expect(brain.criticStats(a.id)).toEqual([
      { critic: "security", checks: 1, findings: 0, fixed: 0, tokens: 0, costUsd: 0 },
      { critic: "ui", checks: 2, findings: 2, fixed: 1, tokens: 4300, costUsd: 0.0004 },
    ]);
  });
});

describe("server settings and spending", () => {
  it("stores settings as JSON with a fallback, and sums model cost since a time", () => {
    expect(brain.getAppSetting("dailyBudgetUsd", 2)).toBe(2);
    brain.setAppSetting("dailyBudgetUsd", 5);
    brain.setAppSetting("escalationModel", null);
    expect(brain.getAppSetting("dailyBudgetUsd", 2)).toBe(5);
    expect(brain.getAppSetting<string | null>("escalationModel", "deepseek-v4-pro")).toBeNull();

    const project = brain.createProject({ name: "App A", localPath: "D:/work/a" });
    const task = brain.createTask(brain.createSession(project.id, "s").id, "t");
    const old = brain.startRun(task.id, "coder", "cheaperinference", "deepseek-v4-flash");
    brain.recordUsage(old.id, { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, costUsd: 0.5 });
    brain.db.prepare("update agent_runs set started_at = ? where id = ?").run("2000-01-01T00:00:00.000Z", old.id);
    const recent = brain.startRun(task.id, "coder", "cheaperinference", "deepseek-v4-flash");
    brain.recordUsage(recent.id, { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, costUsd: 0.25 });

    expect(brain.costSince(new Date(Date.now() - 60_000).toISOString())).toBeCloseTo(0.25);
    expect(brain.costSince("1999-01-01T00:00:00.000Z")).toBeCloseTo(0.75);
  });
});
