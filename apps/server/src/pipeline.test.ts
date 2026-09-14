import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Brain, type Task } from "@ai-employee/brain";
import type { McpServer, OpenedSession, PromptResult, SessionHandlers } from "@ai-employee/dsh-client";
import { commitAll, currentBranch, runCommand } from "@ai-employee/git";
import { dayStamp } from "./handoff.ts";
import { McpTokens } from "./mcp.ts";
import { packageInfo, type PackageLookup } from "./packages.ts";
import { Orchestrator, type AgentHandle, type OrchestratorOptions } from "./pipeline.ts";
import type { VisualTools } from "./visual.ts";
import { addHandoffTemplate } from "./projects.ts";

// These tests drive real git through several agent steps, which is slow on a busy Windows machine.
vi.setConfig({ testTimeout: 60_000 });

type Reply = (text: string, cwd: string) => Promise<PromptResult> | PromptResult;

/** Stands in for DeepSeek Harness: answers each prompt with a scripted reply in the session's folder. */
class FakeAgent implements AgentHandle {
  readonly prompts: { text: string; cwd: string }[] = [];
  private readonly sessions = new Map<string, string>();

  constructor(private readonly reply: Reply) {}

  async newSession(cwd: string, _servers: McpServer[], _handlers: SessionHandlers): Promise<OpenedSession> {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, cwd);
    return { sessionId, configOptions: [] };
  }

  async selectModel(): Promise<void> {}

  async prompt(sessionId: string, text: string): Promise<PromptResult> {
    const cwd = this.sessions.get(sessionId)!;
    this.prompts.push({ text, cwd });
    return this.reply(text, cwd);
  }

  async cancel(): Promise<void> {}

  async closeSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}

const said = (text: string): PromptResult => ({ stopReason: "end_turn", text });
const cancelled: PromptResult = { stopReason: "cancelled", text: "" };

let root: string;
let repo: string;
let brain: Brain;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "ai-employee-pipeline-"));
  repo = join(root, "shop");
  mkdirSync(repo);
  await runCommand("git", ["init", "-b", "main", "-q"], repo);
  await runCommand("git", ["config", "user.email", "test@example.com"], repo);
  await runCommand("git", ["config", "user.name", "Test"], repo);
  writeFileSync(join(repo, "README.md"), "# Shop\n");
  await commitAll(repo, "init");
  brain = new Brain(":memory:");
  // Tests expect a task to stop after its rounds; the stronger-model try has its own test.
  brain.setAppSetting("escalationModel", null);
});

afterEach(() => {
  brain.close();
  rmSync(root, { recursive: true, force: true });
});

function startOrchestrator(agent: AgentHandle, maxParallelTasks = 1, extra: Partial<OrchestratorOptions> = {}): Orchestrator {
  const orchestrator = new Orchestrator({
    ...extra,
    brain,
    pool: { get: async () => agent },
    tokens: new McpTokens(),
    mcpUrl: "http://127.0.0.1:7717/mcp",
    log: () => {},
    worktreesDir: join(root, ".worktrees"),
    maxParallelTasks,
  });
  orchestrator.start();
  return orchestrator;
}

async function waitFor<T>(check: () => T | undefined | null | false, what: string): Promise<T> {
  for (let i = 0; i < 2400; i++) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const untilStatus = (taskId: string, statuses: Task["status"][]) =>
  waitFor(() => {
    const task = brain.getTask(taskId)!;
    return statuses.includes(task.status) && task;
  }, `task status ${statuses.join(" or ")}`);

it("works in a worktree, updates the handoff notes in the same commit and waits for approval", async () => {
  await addHandoffTemplate(repo, "Shop", "main");
  const project = brain.createProject({ name: "Shop", localPath: repo });
  brain.addMemory({ scope: "project", projectId: project.id, kind: "fact", content: "Tests run with npm test" });

  const agent = new FakeAgent((text, cwd) => {
    if (text.startsWith("You are the Planner")) return said('Plan:\n```json\n{"summary": "Add hello.txt", "steps": ["Write hello.txt"]}\n```');
    if (text.startsWith("You are the Coder")) {
      writeFileSync(join(cwd, "hello.txt"), "hello\n");
      return said("Added hello.txt.");
    }
    if (text.startsWith("You are the Reviewer")) return said('```json\n{"approve": true, "summary": "Correct", "issues": []}\n```');
    if (text.startsWith("You keep the handoff notes")) {
      return said("=== .ai/HANDOFF.md ===\n# Handoff\n\n## Current state\n\nhello.txt exists.\n=== end ===\n=== .ai/TASKS.md ===\n# Tasks\n\n## Done\n\n- Add hello.txt\n=== end ===");
    }
    if (text.startsWith("You are the Git agent")) return said('```json\n{"commitMessage": "feat: add hello.txt", "prTitle": "Add hello.txt", "prBody": "Adds hello.txt"}\n```');
    if (text.startsWith("You maintain the long-term memory")) {
      return said('```json\n{"memories": [{"scope": "project", "kind": "fact", "content": "Greetings live in hello.txt"}, {"scope": "project", "kind": "fact", "content": "Tests run with npm test"}]}\n```');
    }
    throw new Error(`unexpected prompt: ${text.slice(0, 60)}`);
  });
  const orchestrator = startOrchestrator(agent);
  const task = brain.createTask(brain.createSession(project.id, "Greetings").id, "Add a hello file");

  const waiting = await untilStatus(task.id, ["awaiting_approval", "failed", "needs_human"]);
  expect(waiting).toMatchObject({ status: "awaiting_approval", error: null });
  await waitFor(() => brain.listEvents(task.id).find((e) => e.type === "memories_saved"), "the memory writer");

  const branch = waiting.branch!;
  const show = (path: string) => runCommand("git", ["show", `${branch}:${path}`], repo);
  expect(await show("hello.txt")).toBe("hello\n");
  expect(await show(".ai/HANDOFF.md")).toContain("hello.txt exists.");
  expect(await show(`.ai/history/${dayStamp(new Date())}.md`)).toContain("Wait for the next task.");
  expect(await show(".ai/CONVENTIONS.md")).toContain("Updating the handoff");

  // The project checkout itself never changed.
  expect(existsSync(join(repo, "hello.txt"))).toBe(false);
  expect(await currentBranch(repo)).toBe("main");

  const planner = agent.prompts.find((p) => p.text.startsWith("You are the Planner"))!;
  expect(planner.cwd).toBe(waiting.worktreePath);
  expect(planner.text).toContain("Wait for the next task.");

  const events = brain.listEvents(task.id);
  expect(events.find((e) => e.type === "handoff_updated")?.payload.files).toEqual([
    ".ai/history/" + dayStamp(new Date()) + ".md",
    ".ai/HANDOFF.md",
    ".ai/TASKS.md",
  ]);
  expect(events.find((e) => e.type === "memories_saved")?.payload).toMatchObject({ items: [{ content: "Greetings live in hello.txt" }], duplicates: 1 });

  const approval = brain.listApprovals("pending").find((a) => a.taskId === task.id)!;
  await orchestrator.onApprovalDecided(brain.decideApproval(approval.id, "rejected")!);
  expect(brain.getTask(task.id)).toMatchObject({ status: "rejected", worktreePath: null });
  expect(existsSync(waiting.worktreePath!)).toBe(false);
  expect(await runCommand("git", ["branch", "--list", branch], repo)).toContain(branch);
});

it("stops a task once its model calls reach the project's budget", async () => {
  const project = brain.createProject({ name: "Shop", localPath: repo, taskBudgetUsd: 0.01 });
  let refusal: string | null = null;
  let orchestrator!: Orchestrator;
  const agent = new FakeAgent(() => {
    const run = orchestrator.resolveRun("{}")!;
    orchestrator.recordUsage(run.runId, { inputTokens: 50_000, outputTokens: 5_000, cacheReadTokens: 0, costUsd: 0.02 });
    refusal = orchestrator.refusal(run.taskId);
    return cancelled;
  });
  orchestrator = startOrchestrator(agent);
  const task = brain.createTask(brain.createSession(project.id, "s").id, "Expensive task");

  const failed = await untilStatus(task.id, ["failed", "cancelled", "awaiting_approval"]);
  expect(failed.status).toBe("failed");
  expect(failed.error).toMatch(/\$0\.0200.*\$0\.01 budget/);
  expect(refusal).toMatch(/budget/);
  expect(brain.taskUsage(task.id).costUsd).toBeCloseTo(0.02);
  expect(brain.listEvents(task.id).find((e) => e.type === "task_failed")?.payload).toMatchObject({ reason: "budget" });
});

it("runs tasks side by side and tells their model calls apart by worktree", async () => {
  const project = brain.createProject({ name: "Shop", localPath: repo });
  let orchestrator!: Orchestrator;
  const cwds: string[] = [];
  let matched: (string | undefined)[] = [];
  let unmatched: unknown = "not checked";
  let release!: () => void;
  const bothPlanning = new Promise<void>((resolve) => (release = resolve));

  const agent = new FakeAgent(async (_text, cwd) => {
    cwds.push(cwd);
    if (cwds.length === 2) {
      matched = cwds.map((dir) => orchestrator.resolveRun(JSON.stringify({ messages: [{ role: "system", content: `Working directory: ${dir}` }] }))?.taskId);
      unmatched = orchestrator.resolveRun("{}");
      release();
    }
    await bothPlanning;
    return cancelled;
  });
  orchestrator = startOrchestrator(agent, 2);
  const session = brain.createSession(project.id, "s");
  const first = brain.createTask(session.id, "First task");
  const second = brain.createTask(session.id, "Second task");

  await untilStatus(first.id, ["cancelled", "failed"]);
  await untilStatus(second.id, ["cancelled", "failed"]);
  for (const id of [first.id, second.id]) await waitFor(() => brain.getTask(id)?.worktreePath === null, "the worktree cleanup");
  const worktreeOf = (id: string) => brain.listEvents(id).find((e) => e.type === "branch_created")?.payload.worktree;
  expect(matched).toEqual(cwds.map((dir) => (worktreeOf(first.id) === dir ? first.id : second.id)));
  expect(new Set(matched)).toEqual(new Set([first.id, second.id]));
  expect(unmatched).toBeNull();
});

/** Replies for the steps after the critics, shared by the critic tests. */
function afterCritics(text: string): PromptResult | null {
  if (text.startsWith("You keep the handoff notes")) return said("=== .ai/HANDOFF.md ===\n# Handoff\n\nCart page added.\n=== end ===");
  if (text.startsWith("You are the Git agent")) return said('```json\n{"commitMessage": "feat: add cart page", "prTitle": "Add cart page", "prBody": "Adds the cart page"}\n```');
  if (text.startsWith("You maintain the long-term memory")) return said('```json\n{"memories": []}\n```');
  return null;
}

const OVERFLOW = '```json\n{"summary": "Overflows on phones", "findings": [{"file": "src/Cart.tsx", "line": 1, "problem": "The fixed 900px width overflows phone screens", "scenario": "On a 390px phone the Save button is off screen", "confidence": 90}]}\n```';

it("says so when the critic a change needs is turned off", async () => {
  const project = brain.createProject({ name: "Shop", localPath: repo, disabledCritics: ["ui"] });
  const agent = new FakeAgent((text, cwd) => {
    if (text.startsWith("You are the Planner")) return said('```json\n{"summary": "Add the cart page"}\n```');
    if (text.startsWith("You are the Coder")) {
      mkdirSync(join(cwd, "src"), { recursive: true });
      writeFileSync(join(cwd, "src", "Cart.tsx"), "export const Cart = () => null;\n");
      return said("Added the cart page.");
    }
    if (text.startsWith("You are the Reviewer")) return said('```json\n{"approve": true, "summary": "Fine", "issues": []}\n```');
    const reply = afterCritics(text);
    if (reply) return reply;
    throw new Error(`unexpected prompt: ${text.slice(0, 60)}`);
  });
  startOrchestrator(agent);
  const task = brain.createTask(brain.createSession(project.id, "Cart").id, "Add a cart page");

  expect((await untilStatus(task.id, ["awaiting_approval", "failed", "needs_human"])).status).toBe("awaiting_approval");
  expect(brain.listEvents(task.id).find((e) => e.type === "critics_skipped")?.payload).toMatchObject({ turnedOff: ["ui"] });
  expect(agent.prompts.some((p) => p.text.startsWith("You are the UI critic"))).toBe(false);
});

it("sends a UI critic's problem back to the Coder and commits once the critic passes", async () => {
  const project = brain.createProject({ name: "Shop", localPath: repo });
  const agent = new FakeAgent((text, cwd) => {
    if (text.startsWith("You are the Planner")) return said('```json\n{"summary": "Add the cart page"}\n```');
    if (text.startsWith("You are the Coder")) {
      mkdirSync(join(cwd, "src"), { recursive: true });
      writeFileSync(join(cwd, "src", "Cart.tsx"), 'export const Cart = () => <div style={{ width: 900 }}>Cart</div>;\n');
      return said("Added the cart page.");
    }
    if (text.startsWith("The change is not ready yet")) {
      writeFileSync(join(cwd, "src", "Cart.tsx"), 'export const Cart = () => <div style={{ maxWidth: "100%" }}>Cart</div>;\n');
      return said("Made the width fluid.");
    }
    if (text.startsWith("You are the Reviewer")) return said('```json\n{"approve": true, "summary": "Logic is fine", "issues": []}\n```');
    if (text.startsWith("You are the UI critic")) return said(text.includes("This is a re-check") ? '```json\n{"summary": "Fixed", "findings": []}\n```' : OVERFLOW);
    const reply = afterCritics(text);
    if (reply) return reply;
    throw new Error(`unexpected prompt: ${text.slice(0, 60)}`);
  });
  startOrchestrator(agent);
  const task = brain.createTask(brain.createSession(project.id, "Cart").id, "Add a cart page");

  const waiting = await untilStatus(task.id, ["awaiting_approval", "failed", "needs_human"]);
  expect(waiting).toMatchObject({ status: "awaiting_approval", error: null });

  const events = brain.listEvents(task.id);
  expect(events.find((e) => e.type === "critics_planned")?.payload.critics).toEqual([{ critic: "ui", reason: "1 UI file changed", files: 1 }]);
  expect(events.filter((e) => e.type === "critic_verdict").map((e) => [e.payload.critic, e.payload.round, e.payload.passed])).toEqual([
    ["ui", 1, false],
    ["ui", 2, true],
  ]);
  expect(events.filter((e) => e.type === "critic_fix_started")).toHaveLength(1);

  const recheck = agent.prompts.filter((p) => p.text.startsWith("You are the UI critic"))[1]!;
  expect(recheck.text).toContain("The fixed 900px width overflows phone screens");
  expect(recheck.text).toContain('+export const Cart = () => <div style={{ maxWidth: "100%" }}>Cart</div>;');
  expect(await runCommand("git", ["show", `${waiting.branch}:src/Cart.tsx`], repo)).toContain("maxWidth");

  expect(brain.listRuns(task.id).filter((r) => r.role === "critic").map((r) => r.purpose)).toEqual(["ui", "ui"]);
  expect(brain.criticStats(project.id)).toMatchObject([{ critic: "ui", checks: 2, findings: 1, fixed: 1 }]);
});

it("starts a failed critic run over once instead of failing the task", async () => {
  const project = brain.createProject({ name: "Shop", localPath: repo });
  let criticCalls = 0;
  const agent = new FakeAgent((text, cwd) => {
    if (text.startsWith("You are the Planner")) return said('```json\n{"summary": "Add the cart page"}\n```');
    if (text.startsWith("You are the Coder")) {
      mkdirSync(join(cwd, "src"), { recursive: true });
      writeFileSync(join(cwd, "src", "Cart.tsx"), "export const Cart = () => null;\n");
      return said("Added the cart page.");
    }
    if (text.startsWith("You are the Reviewer")) return said('```json\n{"approve": true, "summary": "Fine", "issues": []}\n```');
    if (text.startsWith("You are the UI critic")) {
      criticCalls++;
      if (criticCalls === 1) throw new Error("Internal error: turn failed: This request could not be completed.");
      return said('```json\n{"summary": "Fine", "findings": []}\n```');
    }
    const reply = afterCritics(text);
    if (reply) return reply;
    throw new Error(`unexpected prompt: ${text.slice(0, 60)}`);
  });
  startOrchestrator(agent);
  const task = brain.createTask(brain.createSession(project.id, "Cart").id, "Add a cart page");

  expect(await untilStatus(task.id, ["awaiting_approval", "failed", "needs_human"])).toMatchObject({ status: "awaiting_approval", error: null });
  expect(criticCalls).toBe(2);
  expect(brain.listEvents(task.id).find((e) => e.type === "agent_retry")?.payload).toMatchObject({ role: "critic", purpose: "ui" });
  expect(brain.listRuns(task.id).filter((r) => r.role === "critic").map((r) => r.status)).toEqual(["failed", "succeeded"]);
});

it("commits nothing when the critics still find problems after two fix rounds", async () => {
  const project = brain.createProject({ name: "Shop", localPath: repo });
  let fixes = 0;
  const agent = new FakeAgent((text, cwd) => {
    if (text.startsWith("You are the Planner")) return said('```json\n{"summary": "Add the cart page"}\n```');
    if (text.startsWith("You are the Coder") || text.startsWith("The change is not ready yet")) {
      if (text.startsWith("The change")) fixes++;
      mkdirSync(join(cwd, "src"), { recursive: true });
      writeFileSync(join(cwd, "src", "Cart.tsx"), `export const Cart = () => <div style={{ width: ${900 + fixes} }}>Cart</div>;\n`);
      return said("Changed the cart page.");
    }
    if (text.startsWith("You are the Reviewer")) return said('```json\n{"approve": true, "summary": "Logic is fine", "issues": []}\n```');
    if (text.startsWith("You are the UI critic")) return said(OVERFLOW);
    const reply = afterCritics(text);
    if (reply) return reply;
    throw new Error(`unexpected prompt: ${text.slice(0, 60)}`);
  });
  startOrchestrator(agent);
  const task = brain.createTask(brain.createSession(project.id, "Cart").id, "Add a cart page");

  const stuck = await untilStatus(task.id, ["needs_human", "awaiting_approval", "failed"]);
  expect(stuck.status).toBe("needs_human");
  expect(stuck.error).toMatch(/UI critic still found problems after 2 fix rounds/);
  expect(stuck.commitSha).toBeNull();
  expect(fixes).toBe(2);
  expect(brain.listEvents(task.id).filter((e) => e.type === "critic_verdict")).toHaveLength(3);
  expect(brain.listEvents(task.id).find((e) => e.type === "needs_human")?.payload.reason).toBe("critics");
  expect(agent.prompts.some((p) => p.text.startsWith("You keep the handoff notes"))).toBe(false);
});

it("sends quick check problems to the Coder before any model reviews the change", async () => {
  const project = brain.createProject({ name: "Shop", localPath: repo });
  // Built at run time, so this test file itself never looks like it holds a key.
  const key = `sk-${"a1B2".repeat(8)}`;
  const agent = new FakeAgent((text, cwd) => {
    if (text.startsWith("You are the Planner")) return said('```json\n{"summary": "Add the price settings"}\n```');
    if (text.startsWith("You are the Coder")) {
      writeFileSync(join(cwd, "settings.json"), '{ "currency": "EUR", }\n');
      writeFileSync(join(cwd, "prices.js"), `const key = "${key}";\nmodule.exports = { key };\n`);
      return said("Added the price settings.");
    }
    if (text.startsWith("The change is not ready yet")) {
      writeFileSync(join(cwd, "settings.json"), '{ "currency": "EUR" }\n');
      writeFileSync(join(cwd, "prices.js"), "module.exports = { key: process.env.PRICES_KEY };\n");
      return said("Fixed both.");
    }
    if (text.startsWith("You are the Reviewer")) return said('```json\n{"approve": true, "summary": "Fine", "issues": []}\n```');
    const reply = afterCritics(text);
    if (reply) return reply;
    throw new Error(`unexpected prompt: ${text.slice(0, 60)}`);
  });
  startOrchestrator(agent);
  const task = brain.createTask(brain.createSession(project.id, "Prices").id, "Add price settings");

  const waiting = await untilStatus(task.id, ["awaiting_approval", "failed", "needs_human"]);
  expect(waiting).toMatchObject({ status: "awaiting_approval", error: null });

  const quick = brain.listEvents(task.id).filter((e) => e.type === "quick_checks");
  expect(quick[0]?.payload.ok).toBe(false);
  expect((quick[0]?.payload.findings as { kind: string; file: string }[]).map((f) => `${f.kind} ${f.file}`).sort()).toEqual(["secret prices.js", "syntax settings.json"]);
  expect(quick.slice(1).every((e) => e.payload.ok)).toBe(true);

  // The Reviewer saw the change only once it was clean, and the Coder was told where without the key itself.
  const texts = agent.prompts.map((p) => p.text);
  const followUp = texts.findIndex((t) => t.startsWith("The change is not ready yet"));
  expect(texts.filter((t) => t.startsWith("You are the Reviewer"))).toHaveLength(1);
  expect(texts.findIndex((t) => t.startsWith("You are the Reviewer"))).toBeGreaterThan(followUp);
  expect(texts[followUp]).toContain("prices.js:1");
  expect(texts[followUp]).toContain("settings.json");
  expect(texts[followUp]).not.toContain(key);
  expect(await runCommand("git", ["show", `${waiting.branch}:prices.js`], repo)).toContain("process.env.PRICES_KEY");
});

it("gives the Planner and Coder current package versions and sends a too-new dependency back to the Coder", async () => {
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "shop", dependencies: { react: "^18.3.1" } }, null, 2));
  await commitAll(repo, "add package.json");
  const project = brain.createProject({ name: "Shop", localPath: repo });
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const releases: Record<string, Record<string, string>> = {
    react: { "18.3.1": daysAgo(400), "19.3.0": daysAgo(5) },
    "date-kit": { "3.0.0": daysAgo(60), "3.1.0": daysAgo(1) },
  };
  const packages: PackageLookup = {
    info: async (name) => {
      const times = releases[name];
      if (!times) return null;
      const versions = Object.fromEntries(Object.keys(times).map((v) => [v, {}]));
      return packageInfo(name, { "dist-tags": { latest: Object.keys(times).at(-1)! }, versions }, new Date(), times);
    },
    advisories: async () => ({}),
  };
  const manifest = (dateKit: string) => JSON.stringify({ name: "shop", dependencies: { react: "^18.3.1", "date-kit": dateKit } }, null, 2);
  const agent = new FakeAgent((text, cwd) => {
    if (text.startsWith("You are the Planner")) return said('```json\n{"summary": "Add a date picker"}\n```');
    if (text.startsWith("You are the Coder")) {
      writeFileSync(join(cwd, "package.json"), manifest("^3.1.0"));
      return said("Added date-kit.");
    }
    if (text.startsWith("The change is not ready yet")) {
      writeFileSync(join(cwd, "package.json"), manifest("^3.0.0"));
      return said("Moved date-kit to 3.0.0.");
    }
    if (text.startsWith("You are the Reviewer")) return said('```json\n{"approve": true, "summary": "Fine", "issues": []}\n```');
    if (text.startsWith("You are the Security critic")) return said('```json\n{"summary": "Fine", "findings": []}\n```');
    const reply = afterCritics(text);
    if (reply) return reply;
    throw new Error(`unexpected prompt: ${text.slice(0, 60)}`);
  });
  startOrchestrator(agent, 1, { packages });
  const task = brain.createTask(brain.createSession(project.id, "Dates").id, "Add a date picker");

  expect((await untilStatus(task.id, ["awaiting_approval", "failed", "needs_human"])).status).toBe("awaiting_approval");
  const texts = agent.prompts.map((p) => p.text);
  const majorLine = "react 18.3.1: newer major version 19.3.0 (do not upgrade unless the task asks)";
  expect(texts.find((t) => t.startsWith("You are the Planner"))).toContain(majorLine);
  expect(texts.find((t) => t.startsWith("You are the Coder"))).toContain(majorLine);

  const events = brain.listEvents(task.id);
  expect(events.find((e) => e.type === "versions_checked")?.payload).toMatchObject({ failed: 0, total: 1, packages: [{ name: "react", status: "major", stable: "19.3.0" }] });
  const quick = events.filter((e) => e.type === "quick_checks");
  expect(quick[0]?.payload.findings).toEqual([
    expect.objectContaining({ kind: "dependency", file: "package.json", message: expect.stringMatching(/^date-kit@3\.1\.0 was published .* Use date-kit@3\.0\.0 instead\.$/) }),
  ]);
  expect(quick.at(-1)?.payload.ok).toBe(true);
  expect(texts.find((t) => t.startsWith("The change is not ready yet"))).toContain("date-kit@3.1.0 was published");
});

it("hands the agent's new files to the shared group before git stages them", async () => {
  const project = brain.createProject({ name: "Shop", localPath: repo });
  const agent = new FakeAgent((text, cwd) => {
    if (text.startsWith("You are the Planner")) return said('```json\n{"summary": "Add the deploy notes"}\n```');
    if (text.startsWith("You are the Coder")) {
      mkdirSync(join(cwd, "notes"), { recursive: true });
      writeFileSync(join(cwd, "notes", "deploy.txt"), "Deploy after merging into main.\n");
      return said("Added the deploy notes.");
    }
    if (text.startsWith("You are the Reviewer")) return said('```json\n{"approve": true, "summary": "Fine", "issues": []}\n```');
    const reply = afterCritics(text);
    if (reply) return reply;
    throw new Error(`unexpected prompt: ${text.slice(0, 60)}`);
  });
  const orchestrator = startOrchestrator(agent);
  // On the VPS a file the agent's editor wrote can be readable by the agent user only, so staging it first fails.
  const stagedAtShare: boolean[] = [];
  vi.spyOn(orchestrator, "shareAgentFiles").mockImplementation(async (_task, cwd) => {
    if (existsSync(join(cwd, "notes", "deploy.txt"))) stagedAtShare.push((await runCommand("git", ["ls-files", "--", "notes/deploy.txt"], cwd)).trim() !== "");
  });
  const task = brain.createTask(brain.createSession(project.id, "Deploy").id, "Add deploy notes");

  expect((await untilStatus(task.id, ["awaiting_approval", "failed", "needs_human"])).status).toBe("awaiting_approval");
  expect(stagedAtShare[0]).toBe(false);
});

it("takes checks from package.json and only enforces those that passed before the change", async () => {
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "shop", scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(1)"' } }));
  await commitAll(repo, "add package.json");
  const project = brain.createProject({ name: "Shop", localPath: repo });
  const agent = new FakeAgent((text, cwd) => {
    if (text.startsWith("You are the Planner")) return said('```json\n{"summary": "Add hello.txt"}\n```');
    if (text.startsWith("You are the Coder")) {
      writeFileSync(join(cwd, "hello.txt"), "hello\n");
      return said("Added hello.txt.");
    }
    if (text.startsWith("You are the Reviewer")) return said('```json\n{"approve": true, "summary": "Fine", "issues": []}\n```');
    const reply = afterCritics(text);
    if (reply) return reply;
    throw new Error(`unexpected prompt: ${text.slice(0, 60)}`);
  });
  startOrchestrator(agent);
  const task = brain.createTask(brain.createSession(project.id, "Hello").id, "Add a hello file");

  expect((await untilStatus(task.id, ["awaiting_approval", "failed", "needs_human"])).status).toBe("awaiting_approval");
  const events = brain.listEvents(task.id);
  expect(events.find((e) => e.type === "checks_detected")?.payload).toMatchObject({
    commands: [{ command: "npm test --silent", source: "package.json scripts.test" }],
    dropped: [{ command: "npm run --silent lint", exitCode: 1 }],
  });
  expect(events.filter((e) => e.type === "check_finished").map((e) => [e.payload.command, e.payload.ok])).toEqual([["npm test --silent", true]]);
  expect(events.some((e) => e.type === "checks_skipped")).toBe(false);
});

it("continues a task that needs help from its earlier work, with the owner's note", async () => {
  const project = brain.createProject({ name: "Shop", localPath: repo });
  let continued = false;
  let keptEarlierWork = false;
  const agent = new FakeAgent((text, cwd) => {
    if (text.startsWith("You are the Planner")) return said('```json\n{"summary": "Add cart totals"}\n```');
    if (text.startsWith("You are the Coder") && text.includes("This task stopped before")) {
      keptEarlierWork = readFileSync(join(cwd, "cart.js"), "utf8").includes("total");
      writeFileSync(join(cwd, "cart.js"), "exports.total = (items) => items.reduce((s, i) => s + i.price, 0).toFixed(2);\n");
      return said("Totals now show two decimals.");
    }
    if (text.startsWith("You are the Coder")) {
      writeFileSync(join(cwd, "cart.js"), "exports.total = (items) => items.reduce((s, i) => s + i.price, 0);\n");
      return said("Added the total.");
    }
    if (text.startsWith("The change is not ready yet")) return said("I could not tell how to format it.");
    if (text.startsWith("You are the Reviewer")) {
      return said(
        continued
          ? '```json\n{"approve": true, "summary": "Fine", "issues": []}\n```'
          : '```json\n{"approve": false, "summary": "Format", "issues": [{"severity": "major", "message": "Totals must show two decimals"}]}\n```',
      );
    }
    const reply = afterCritics(text);
    if (reply) return reply;
    throw new Error(`unexpected prompt: ${text.slice(0, 60)}`);
  });
  const orchestrator = startOrchestrator(agent);
  const task = brain.createTask(brain.createSession(project.id, "Cart").id, "Add cart totals");

  const stuck = await untilStatus(task.id, ["awaiting_approval", "failed", "needs_human"]);
  expect(stuck.status).toBe("needs_human");
  continued = true;
  orchestrator.continueTask(task.id, "Use toFixed(2) for the total");
  // Once it is running again, a second continue is refused.
  expect(() => orchestrator.continueTask(task.id, "")).toThrow(/can continue/);
  const waiting = await untilStatus(task.id, ["awaiting_approval", "failed"]);
  expect(waiting).toMatchObject({ status: "awaiting_approval", error: null, worktreePath: stuck.worktreePath, branch: stuck.branch });

  const resumed = agent.prompts.find((p) => p.text.includes("This task stopped before"))!;
  expect(resumed.text).toContain("Note from the owner (follow it): Use toFixed(2) for the total");
  expect(resumed.text).toContain("Totals must show two decimals");
  expect(keptEarlierWork).toBe(true);
  expect(agent.prompts.filter((p) => p.text.startsWith("You are the Planner"))).toHaveLength(1);
  expect(await runCommand("git", ["show", `${waiting.branch}:cart.js`], repo)).toContain("toFixed(2)");
  expect(brain.listEvents(task.id).map((e) => e.type)).toContain("task_resumed");
});

it("gives the Coder one more try with the stronger model when the review rounds run out", async () => {
  brain.setAppSetting("escalationModel", "deepseek-v4-pro");
  const project = brain.createProject({ name: "Shop", localPath: repo });
  const agent = new FakeAgent((text, cwd) => {
    if (text.startsWith("You are the Planner")) return said('```json\n{"summary": "Add cart totals"}\n```');
    if (text.startsWith("You are the Coder") && text.includes("A cheaper model already tried")) {
      writeFileSync(join(cwd, "cart.js"), "exports.total = (items) => items.reduce((s, i) => s + i.price, 0).toFixed(2);\n");
      return said("Formatted the total.");
    }
    if (text.startsWith("You are the Coder")) {
      writeFileSync(join(cwd, "cart.js"), "exports.total = (items) => items.reduce((s, i) => s + i.price, 0);\n");
      return said("Added the total.");
    }
    if (text.startsWith("The change is not ready yet")) return said("I could not tell how to format it.");
    if (text.startsWith("You are the Reviewer")) {
      return said(
        readFileSync(join(cwd, "cart.js"), "utf8").includes("toFixed")
          ? '```json\n{"approve": true, "summary": "Fine", "issues": []}\n```'
          : '```json\n{"approve": false, "summary": "Format", "issues": [{"severity": "major", "message": "Totals must show two decimals"}]}\n```',
      );
    }
    const reply = afterCritics(text);
    if (reply) return reply;
    throw new Error(`unexpected prompt: ${text.slice(0, 60)}`);
  });
  startOrchestrator(agent);
  const task = brain.createTask(brain.createSession(project.id, "Cart").id, "Add cart totals");

  expect(await untilStatus(task.id, ["awaiting_approval", "failed", "needs_human"])).toMatchObject({ status: "awaiting_approval", error: null });
  const events = brain.listEvents(task.id);
  expect(events.find((e) => e.type === "escalated")?.payload).toEqual({ from: "cheaperinference/deepseek-v4-flash", to: "cheaperinference/deepseek-v4-pro", reason: "review" });
  expect(events.filter((e) => e.type === "review_verdict").map((e) => [e.payload.round, e.payload.approved])).toEqual([
    [1, false],
    [2, false],
    [3, false],
    [4, true],
  ]);
  expect(brain.listRuns(task.id).filter((r) => r.role === "coder").map((r) => [r.model, r.purpose])).toEqual([
    ["deepseek-v4-flash", null],
    ["deepseek-v4-pro", "escalation"],
  ]);
  expect(agent.prompts.find((p) => p.text.includes("A cheaper model already tried"))?.text).toContain("Totals must show two decimals");
});

it("stops every task once all model calls today reach the daily budget, and starts waiting tasks when it is raised", async () => {
  brain.setAppSetting("dailyBudgetUsd", 0.05);
  const project = brain.createProject({ name: "Shop", localPath: repo });
  let orchestrator!: Orchestrator;
  let refusal: string | null = null;
  let calls = 0;
  const agent = new FakeAgent(() => {
    calls++;
    const run = orchestrator.resolveRun("{}")!;
    orchestrator.recordUsage(run.runId, { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, costUsd: 0.06 });
    refusal = orchestrator.refusal(run.taskId);
    return cancelled;
  });
  orchestrator = startOrchestrator(agent);
  const session = brain.createSession(project.id, "s");
  const first = brain.createTask(session.id, "First task");

  const failed = await untilStatus(first.id, ["failed", "cancelled"]);
  expect(failed.error).toMatch(/\$0\.0600 today.*\$0\.05 daily budget/);
  expect(refusal).toMatch(/daily budget/);

  const second = brain.createTask(session.id, "Second task");
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(brain.getTask(second.id)?.status).toBe("queued");

  brain.setAppSetting("dailyBudgetUsd", 1);
  await untilStatus(second.id, ["failed", "cancelled"]);
  expect(calls).toBe(2);
  // A cancelled task removes its folder after its status changes; let that finish before the test cleans up.
  await waitFor(() => orchestrator.runningTaskIds.length === 0 && brain.getTask(second.id)?.worktreePath === null, "the orchestrator to go idle");
});

it("starts the app for a UI change and sends what the screenshots show back to the Coder", async () => {
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "shop", scripts: { dev: "vite" } }));
  await commitAll(repo, "add package.json");
  const project = brain.createProject({ name: "Shop", localPath: repo });
  const commands: string[] = [];
  const visionPrompts: string[] = [];
  const visual: VisualTools = {
    capture: async ({ command }) => {
      commands.push(command.command);
      return { ok: true, capture: { shots: [{ name: "phone", width: 390, height: 844, jpegBase64: "AAAA" }], consoleErrors: [], axe: [], loadError: null } };
    },
    review: async (model, prompt) => {
      visionPrompts.push(prompt);
      const text =
        visionPrompts.length === 1
          ? '```json\n{"summary": "Cut off", "findings": [{"file": "phone screenshot", "problem": "The cart total is cut off on the phone", "scenario": "Shoppers cannot see what they pay", "confidence": 90}]}\n```'
          : '```json\n{"summary": "Looks right", "findings": []}\n```';
      return { text, usage: { inputTokens: 1_200, outputTokens: 60, cacheReadTokens: 0, costUsd: 0.0002 }, model: `${model.provider}/${model.model}` };
    },
  };
  const agent = new FakeAgent((text, cwd) => {
    if (text.startsWith("You are the Planner")) return said('```json\n{"summary": "Add the cart page"}\n```');
    if (text.startsWith("You are the Coder")) {
      mkdirSync(join(cwd, "src"), { recursive: true });
      writeFileSync(join(cwd, "src", "Cart.tsx"), "export const Cart = () => <div style={{ width: 900 }}>Total</div>;\n");
      return said("Added the cart page.");
    }
    if (text.startsWith("The change is not ready yet")) {
      writeFileSync(join(cwd, "src", "Cart.tsx"), 'export const Cart = () => <div style={{ maxWidth: "100%" }}>Total</div>;\n');
      return said("The cart fits the phone now.");
    }
    if (text.startsWith("You are the Reviewer")) return said('```json\n{"approve": true, "summary": "Fine", "issues": []}\n```');
    if (text.startsWith("You are the UI critic")) return said('```json\n{"summary": "Code looks fine", "findings": []}\n```');
    const reply = afterCritics(text);
    if (reply) return reply;
    throw new Error(`unexpected prompt: ${text.slice(0, 60)}`);
  });
  startOrchestrator(agent, 1, { visual });
  const task = brain.createTask(brain.createSession(project.id, "Cart").id, "Add a cart page");

  expect(await untilStatus(task.id, ["awaiting_approval", "failed", "needs_human"])).toMatchObject({ status: "awaiting_approval", error: null });
  expect(commands[0]).toMatch(/^npm run dev -- --host 127\.0\.0\.1 --port \d+ --strictPort$/);
  const checks = brain.listEvents(task.id).filter((e) => e.type === "visual_check");
  expect(checks.map((e) => [e.payload.round, e.payload.passed])).toEqual([
    [1, false],
    [2, true],
  ]);
  const fix = agent.prompts.find((p) => p.text.startsWith("The change is not ready yet"))!;
  expect(fix.text).toContain("The cart total is cut off on the phone");
  expect(visionPrompts[1]).toContain("This is a re-check");
  expect(brain.listRuns(task.id).filter((r) => r.purpose === "visual").map((r) => [r.model, r.costUsd])).toEqual([
    ["glm-5.3-flash", 0.0002],
    ["glm-5.3-flash", 0.0002],
  ]);
});

it("skips the app check instead of failing the task when the capture breaks", async () => {
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "shop", scripts: { dev: "vite" } }));
  await commitAll(repo, "add package.json");
  const project = brain.createProject({ name: "Shop", localPath: repo });
  const visual: VisualTools = {
    capture: async () => {
      throw new Error("the browser printed nonsense");
    },
    review: async () => {
      throw new Error("not reached");
    },
  };
  const agent = new FakeAgent((text, cwd) => {
    if (text.startsWith("You are the Planner")) return said('```json\n{"summary": "Add the cart page"}\n```');
    if (text.startsWith("You are the Coder")) {
      mkdirSync(join(cwd, "src"), { recursive: true });
      writeFileSync(join(cwd, "src", "Cart.tsx"), "export const Cart = () => <div>Total</div>;\n");
      return said("Added the cart page.");
    }
    if (text.startsWith("You are the Reviewer")) return said('```json\n{"approve": true, "summary": "Fine", "issues": []}\n```');
    if (text.startsWith("You are the UI critic")) return said('```json\n{"summary": "Fine", "findings": []}\n```');
    const reply = afterCritics(text);
    if (reply) return reply;
    throw new Error(`unexpected prompt: ${text.slice(0, 60)}`);
  });
  startOrchestrator(agent, 1, { visual });
  const task = brain.createTask(brain.createSession(project.id, "Cart").id, "Add a cart page");

  expect(await untilStatus(task.id, ["awaiting_approval", "failed", "needs_human"])).toMatchObject({ status: "awaiting_approval", error: null });
  expect(brain.listEvents(task.id).find((e) => e.type === "visual_skipped")?.payload.reason).toMatch(/the browser printed nonsense/);
});
