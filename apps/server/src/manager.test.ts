import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Brain, type Approval } from "@ai-employee/brain";
import type { PromptResult } from "@ai-employee/dsh-client";
import { commitAll, runCommand } from "@ai-employee/git";
import { parseEpicList, parseTaskList } from "./manager.ts";
import { McpTokens } from "./mcp.ts";
import { Orchestrator } from "./pipeline.ts";
import { FakeAgent, said, waitFor } from "./test-agents.ts";

// Several agent steps over real git repositories per test.
vi.setConfig({ testTimeout: 90_000 });

let root: string;
let repo: string;
let origin: string;
let brain: Brain;
let current: Orchestrator | null = null;
const pullRequests: { base: string; head: string; title: string }[] = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "ai-employee-manager-"));
  repo = join(root, "shop");
  origin = join(root, "origin.git");
  mkdirSync(repo);
  mkdirSync(origin);
  await runCommand("git", ["init", "--bare", "-q", "-b", "main"], origin);
  await runCommand("git", ["init", "-b", "main", "-q"], repo);
  await runCommand("git", ["config", "user.email", "test@example.com"], repo);
  await runCommand("git", ["config", "user.name", "Test"], repo);
  writeFileSync(join(repo, "README.md"), "# Shop\n");
  await commitAll(repo, "init");
  await runCommand("git", ["remote", "add", "origin", origin], repo);
  await runCommand("git", ["push", "-q", "origin", "main"], repo);
  brain = new Brain(":memory:");
  // Tests expect a task to stop after its rounds; the stronger-model try has its own test.
  brain.setAppSetting("escalationModel", null);
  pullRequests.length = 0;
});

afterEach(async () => {
  // Let the last task finish its bookkeeping before the database closes.
  if (current) await waitFor(() => current!.runningTaskIds.length === 0, "the orchestrator to go idle");
  current = null;
  brain.close();
  rmSync(root, { recursive: true, force: true });
});

function start(agent: FakeAgent): Orchestrator {
  const orchestrator = new Orchestrator({
    brain,
    pool: { get: async () => agent },
    tokens: new McpTokens(),
    mcpUrl: "http://127.0.0.1:7717/mcp",
    log: () => {},
    worktreesDir: join(root, ".worktrees"),
    openPullRequest: async (_repo, pr) => {
      pullRequests.push({ base: pr.base, head: pr.head, title: pr.title });
      return `https://github.test/pull/${pullRequests.length}`;
    },
    pullRequestState: async () => "OPEN",
  });
  orchestrator.start();
  current = orchestrator;
  return orchestrator;
}

/** Replies shared by every code task: plan, approving review, handoff notes, commit text and memory. */
function routine(text: string): PromptResult | null {
  if (text.startsWith("You are the Planner")) return said('```json\n{"summary": "Do the task"}\n```');
  if (text.startsWith("You are the Reviewer")) return said('```json\n{"approve": true, "summary": "Fine", "issues": []}\n```');
  if (text.startsWith("You keep the handoff notes")) return said("=== .ai/HANDOFF.md ===\n# Handoff\n\nUpdated.\n=== end ===");
  if (text.startsWith("You are the Git agent")) return said('```json\n{"commitMessage": "feat: task", "prTitle": "Task", "prBody": "Task"}\n```');
  if (text.startsWith("You maintain the long-term memory")) return said('```json\n{"memories": []}\n```');
  return null;
}

const isGoalPlan = (text: string) => text.startsWith("You are the Project manager on an AI engineering team. You are in a read-only");
const isEpicPlan = (text: string) => text.startsWith("You are the Project manager on an AI engineering team, planning the next epic");
const taskOf = (text: string) => /Task from the user:\n(.+)/.exec(text)?.[1];
const show = (ref: string, path: string) => runCommand("git", ["show", `${ref}:${path}`], repo);

async function decide(orchestrator: Orchestrator, match: (a: Approval) => boolean, decision: "approved" | "rejected"): Promise<void> {
  const pending = await waitFor(() => brain.listApprovals("pending").find(match), "an approval");
  await orchestrator.onApprovalDecided(brain.decideApproval(pending.id, decision)!);
}

it("reads plans leniently and drops what it cannot use", () => {
  expect(parseEpicList('```json\n{"summary": "s", "epics": [{"title": "Login"}, {"description": "no title"}]}\n```')).toEqual({
    summary: "s",
    epics: [{ title: "Login", description: "" }],
  });
  expect(parseEpicList("no plan")).toBeNull();
  expect(parseTaskList('{"tasks": [{"title": "Table", "acceptance": ["has a test", 3], "files": "x"}]}')).toEqual([
    { title: "Table", description: "", acceptance: ["has a test"], files: [] },
  ]);
});

it("splits a goal into epics whose tasks build on each other, and stacks the epics' pull requests", async () => {
  const seen: Record<string, boolean> = {};
  const agent = new FakeAgent((text, cwd) => {
    if (isGoalPlan(text)) {
      return said('```json\n{"summary": "Greeting first, then goodbye", "epics": [{"title": "Greeting", "description": "Say hello"}, {"title": "Goodbye", "description": "Say bye"}]}\n```');
    }
    if (isEpicPlan(text)) {
      seen.planSawGreeting = existsSync(join(cwd, "main.txt"));
      return text.includes("Epic to plan: Greeting")
        ? said('```json\n{"tasks": [{"title": "Add the greeting", "acceptance": ["greeting.txt exists"]}, {"title": "Use the greeting"}]}\n```')
        : said('```json\n{"tasks": [{"title": "Say goodbye"}]}\n```');
    }
    const task = taskOf(text);
    if (text.startsWith("You are the Coder") && task === "Add the greeting") {
      writeFileSync(join(cwd, "greeting.txt"), "hello\n");
      return said("Added greeting.txt");
    }
    if (text.startsWith("You are the Coder") && task === "Use the greeting") {
      seen.secondTaskSawFirst = existsSync(join(cwd, "greeting.txt"));
      writeFileSync(join(cwd, "main.txt"), "uses greeting.txt\n");
      return said("Added main.txt");
    }
    if (text.startsWith("You are the Coder") && task === "Say goodbye") {
      seen.secondEpicSawFirst = existsSync(join(cwd, "main.txt"));
      writeFileSync(join(cwd, "bye.txt"), "bye\n");
      return said("Added bye.txt");
    }
    const reply = routine(text);
    if (reply) return reply;
    throw new Error(`unexpected prompt: ${text.slice(0, 80)}`);
  });
  const orchestrator = start(agent);
  const project = brain.createProject({ name: "Shop", localPath: repo });
  const session = brain.createSession(project.id, "Greetings");
  const goal = orchestrator.manager.createGoal(session.id, "Build a greeting app", null);

  await waitFor(() => brain.getGoal(goal.id)?.status === "awaiting_approval", "the plan");
  expect(brain.listEpics(goal.id).map((e) => [e.title, e.status])).toEqual([
    ["Greeting", "pending"],
    ["Goodbye", "pending"],
  ]);
  await decide(orchestrator, (a) => a.kind === "plan" && a.goalId === goal.id, "approved");

  const first = await waitFor(() => brain.listEpics(goal.id).find((e) => e.position === 0 && e.status === "awaiting_approval"), "epic 1 to finish");
  expect(seen.secondTaskSawFirst).toBe(true);
  expect(brain.listEpicTasks(first.id).map((t) => [t.epicPosition, t.status])).toEqual([
    [0, "done"],
    [1, "done"],
  ]);
  expect(await show(first.branch!, "greeting.txt")).toBe("hello\n");
  expect(await show(first.branch!, "main.txt")).toBe("uses greeting.txt\n");
  expect(existsSync(join(repo, "greeting.txt"))).toBe(false);
  expect(brain.listEpicTasks(first.id)[0]!.prompt).toContain("greeting.txt exists");

  await decide(orchestrator, (a) => a.kind === "epic_push" && a.epicId === first.id, "approved");
  expect(brain.getEpic(first.id)).toMatchObject({ status: "done", prUrl: "https://github.test/pull/1" });
  expect((await runCommand("git", ["ls-remote", "--heads", origin, first.branch!], repo)).trim()).not.toBe("");

  const second = await waitFor(() => brain.listEpics(goal.id).find((e) => e.position === 1 && e.status === "awaiting_approval"), "epic 2 to finish");
  expect(seen.secondEpicSawFirst).toBe(true);
  expect(seen.planSawGreeting).toBe(true);
  await decide(orchestrator, (a) => a.kind === "epic_push" && a.epicId === second.id, "approved");

  // The first epic's pull request is still open, so the second one stacks on its branch.
  expect(pullRequests).toEqual([
    { base: "main", head: first.branch, title: "Greeting" },
    { base: first.branch, head: second.branch, title: "Goodbye" },
  ]);
  expect(brain.getGoal(goal.id)?.status).toBe("done");
});

it("pauses the goal when a task gets stuck and continues with the owner's note", async () => {
  let approve = false;
  const agent = new FakeAgent((text, cwd) => {
    if (isGoalPlan(text)) return said('```json\n{"summary": "One epic", "epics": [{"title": "Greeting"}]}\n```');
    if (isEpicPlan(text)) return said('```json\n{"tasks": [{"title": "Add the greeting"}]}\n```');
    if (text.startsWith("You are the Coder") || text.startsWith("The change is not ready yet")) {
      writeFileSync(join(cwd, "greeting.txt"), approve ? "hello, plain text\n" : "hello\n");
      return said("Wrote greeting.txt");
    }
    if (text.startsWith("You are the Reviewer") && !approve) {
      return said('```json\n{"approve": false, "summary": "Wrong format", "issues": [{"severity": "major", "message": "Use plain text"}]}\n```');
    }
    const reply = routine(text);
    if (reply) return reply;
    throw new Error(`unexpected prompt: ${text.slice(0, 80)}`);
  });
  const orchestrator = start(agent);
  const project = brain.createProject({ name: "Shop", localPath: repo });
  const goal = orchestrator.manager.createGoal(brain.createSession(project.id, "s").id, "Build a greeting app", null);
  await decide(orchestrator, (a) => a.kind === "plan", "approved");

  const paused = await waitFor(() => (brain.getGoal(goal.id)?.status === "paused" ? brain.getGoal(goal.id) : null), "the goal to pause");
  expect(paused.error).toMatch(/Not ready after 3 rounds/);
  const [epic] = brain.listEpics(goal.id);
  expect(epic?.status).toBe("paused");

  approve = true;
  await orchestrator.manager.resumeGoal(goal.id, { note: "Plain text is fine" });
  const retried = await waitFor(() => brain.listEpicTasks(epic!.id)[1], "the retried task");
  expect(retried.prompt).toContain("Note from the owner: Plain text is fine");
  await waitFor(() => brain.getEpic(epic!.id)?.status === "awaiting_approval", "the epic to finish");
  expect(await show(brain.getEpic(epic!.id)!.branch!, "greeting.txt")).toBe("hello, plain text\n");
});

it("undoes a base merge whose checks fail, so a later push cannot skip them", async () => {
  const other = join(root, "other");
  await runCommand("git", ["clone", "-q", origin, other], root);
  await runCommand("git", ["config", "user.email", "other@example.com"], other);
  await runCommand("git", ["config", "user.name", "Other"], other);

  const agent = new FakeAgent((text, cwd) => {
    if (text.startsWith("You are the Coder")) {
      writeFileSync(join(cwd, "a.txt"), "ours\n");
      return said("Added a.txt");
    }
    if (text.startsWith("The change is not ready yet")) return said("I could not fix it");
    const reply = routine(text);
    if (reply) return reply;
    throw new Error(`unexpected prompt: ${text.slice(0, 80)}`);
  });
  const orchestrator = start(agent);
  // The project's check fails once the newer main (with broken.txt) is merged in.
  const testCmd = `node -e "process.exit(require('fs').existsSync('broken.txt') ? 1 : 0)"`;
  const project = brain.createProject({ name: "Shop", localPath: repo, testCmd });
  const task = brain.createTask(brain.createSession(project.id, "s").id, "Add a.txt");
  await waitFor(() => brain.getTask(task.id)?.status === "awaiting_approval", "the task");
  const committed = brain.getTask(task.id)!.commitSha!;

  writeFileSync(join(other, "broken.txt"), "breaks the checks\n");
  await commitAll(other, "break the checks");
  await runCommand("git", ["push", "-q", "origin", "main"], other);
  await decide(orchestrator, (a) => a.taskId === task.id, "approved");

  expect(brain.getTask(task.id)).toMatchObject({ status: "failed" });
  expect(brain.getTask(task.id)!.error).toMatch(/checks fail after merging the newest main/);
  const branch = brain.getTask(task.id)!.branch!;
  expect((await runCommand("git", ["rev-parse", branch], repo)).trim()).toBe(committed);
  expect(existsSync(join(brain.getTask(task.id)!.worktreePath!, "broken.txt"))).toBe(false);
  expect((await runCommand("git", ["ls-remote", "--heads", origin, branch], repo)).trim()).toBe("");
});

it("starts a single task from GitHub's newer main and resolves conflicts with it before pushing", async () => {
  writeFileSync(join(repo, "a.txt"), "start\n");
  await commitAll(repo, "add a");
  await runCommand("git", ["push", "-q", "origin", "main"], repo);
  const other = join(root, "other");
  await runCommand("git", ["clone", "-q", origin, other], root);
  await runCommand("git", ["config", "user.email", "other@example.com"], other);
  await runCommand("git", ["config", "user.name", "Other"], other);
  const pushFromOther = async (file: string, content: string) => {
    writeFileSync(join(other, file), content);
    await commitAll(other, `change ${file}`);
    await runCommand("git", ["push", "-q", "origin", "main"], other);
  };
  await pushFromOther("b.txt", "only on GitHub\n");

  let sawGitHubFile = false;
  const agent = new FakeAgent((text, cwd) => {
    if (text.startsWith("You are the Coder") && text.includes("merge conflicts")) {
      writeFileSync(join(cwd, "a.txt"), "ours and theirs\n");
      return said("Kept both changes");
    }
    if (text.startsWith("You are the Coder")) {
      sawGitHubFile = existsSync(join(cwd, "b.txt"));
      writeFileSync(join(cwd, "a.txt"), "ours\n");
      return said("Changed a.txt");
    }
    const reply = routine(text);
    if (reply) return reply;
    throw new Error(`unexpected prompt: ${text.slice(0, 80)}`);
  });
  const orchestrator = start(agent);
  const project = brain.createProject({ name: "Shop", localPath: repo });
  const task = brain.createTask(brain.createSession(project.id, "s").id, "Change a.txt");
  await waitFor(() => brain.getTask(task.id)?.status === "awaiting_approval", "the task");
  expect(sawGitHubFile).toBe(true);
  expect(brain.listEvents(task.id).find((e) => e.type === "base_refreshed")?.payload).toMatchObject({ source: "origin" });

  // Someone changes the same line on GitHub before the owner approves.
  await pushFromOther("a.txt", "theirs\n");
  await decide(orchestrator, (a) => a.taskId === task.id, "approved");

  expect(brain.getTask(task.id)).toMatchObject({ status: "done", prUrl: "https://github.test/pull/1" });
  expect(brain.listEvents(task.id).find((e) => e.type === "base_merged")?.payload).toMatchObject({ conflicts: ["a.txt"], source: "origin" });
  const branch = brain.getTask(task.id)!.branch!;
  expect((await runCommand("git", ["show", `origin/${branch}:a.txt`], repo)).trim()).toBe("ours and theirs");
  expect(readFileSync(join(root, "origin.git", "HEAD"), "utf8")).toContain("main");
});
