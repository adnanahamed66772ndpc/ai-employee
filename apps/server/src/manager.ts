import { basename, join } from "node:path";
import type { Approval, Brain, Epic, Goal, PlannedTask, Task } from "@ai-employee/brain";
import * as git from "@ai-employee/git";
import type { Orchestrator, RunningTask } from "./pipeline.ts";
import * as prompts from "./prompts.ts";

/*
 * The project manager turns one large goal into epics, and each epic into small tasks that run one at a time on the
 * epic's own branch, each starting from the previous task's commit. The owner approves the epic list once and every
 * epic before it is pushed. A task that stops pauses its epic and the goal until the owner continues.
 */

const MAX_EPICS = 12;
const MAX_TASKS_PER_EPIC = 8;
const STOPPED: readonly Task["status"][] = ["needs_human", "failed", "cancelled", "rejected"];

export type PullRequestState = "OPEN" | "MERGED" | "CLOSED" | null;

export interface GitHubAccess {
  openPullRequest: typeof git.createPullRequest;
  pullRequestState: (repo: string, url: string) => Promise<PullRequestState>;
}

const clean = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const cleanList = (value: unknown, max: number, each: number) =>
  Array.isArray(value) ? value.map((item) => clean(item, each)).filter(Boolean).slice(0, max) : [];

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/g, "") || "epic";

export function parseEpicList(reply: string): { summary: string; epics: { title: string; description: string }[] } | null {
  const json = prompts.extractJson<{ summary?: unknown; epics?: unknown }>(reply);
  const raw: unknown[] = Array.isArray(json?.epics) ? json.epics : [];
  const epics = raw
    .map((item) => {
      const epic = (item ?? {}) as Record<string, unknown>;
      return { title: clean(epic.title, 120), description: clean(epic.description, 1_000) };
    })
    .filter((epic) => epic.title)
    .slice(0, MAX_EPICS);
  return epics.length ? { summary: clean(json?.summary, 2_000), epics } : null;
}

export function parseTaskList(reply: string): PlannedTask[] | null {
  const json = prompts.extractJson<{ tasks?: unknown }>(reply);
  const raw: unknown[] = Array.isArray(json?.tasks) ? json.tasks : [];
  const tasks = raw
    .map((item) => {
      const task = (item ?? {}) as Record<string, unknown>;
      return {
        title: clean(task.title, 120),
        description: clean(task.description, 2_000),
        acceptance: cleanList(task.acceptance, 8, 300),
        files: cleanList(task.files, 12, 200),
      };
    })
    .filter((task) => task.title)
    .slice(0, MAX_TASKS_PER_EPIC);
  return tasks.length ? tasks : null;
}

export class ProjectManager {
  constructor(
    private readonly brain: Brain,
    private readonly orchestrator: Orchestrator,
    private readonly worktreesDir: string,
    private readonly github: GitHubAccess,
    private readonly log: (message: string) => void,
  ) {}

  /** Records the goal and queues the task in which the project manager plans its epics. */
  createGoal(sessionId: string, prompt: string, budgetUsd: number | null): Goal {
    const goal = this.brain.createGoal(sessionId, prompt, budgetUsd);
    this.brain.createTask(sessionId, `Plan the goal: ${prompt}`, { kind: "goal_plan", goalId: goal.id });
    return goal;
  }

  private goalOf(task: Task) {
    const goal = task.goalId ? this.brain.getGoal(task.goalId) : null;
    const project = this.brain.getProject(task.projectId);
    if (!goal || !project) throw new Error("The goal or its project no longer exists");
    return { goal, project };
  }

  // ---- planning ------------------------------------------------------------------------------------

  async planGoal(task: Task, running: RunningTask): Promise<void> {
    const { goal, project } = this.goalOf(task);
    const notes = (await this.orchestrator.readAiFiles(project.localPath, running.abort.signal))["HANDOFF.md"] ?? null;
    const reply = await this.orchestrator.runOnce(task, project, project.localPath, "planner", "read-only", prompts.projectPlan(project, goal, notes), running, "project_plan");
    const plan = parseEpicList(reply);
    if (!plan) throw new Error("The project manager did not return a usable list of epics");

    const epics = this.brain.replaceEpics(goal.id, plan.epics);
    this.brain.updateTask(task.id, { status: "done", plan });
    this.brain.updateGoal(goal.id, { status: "awaiting_approval", summary: plan.summary || null, error: null });
    this.brain.addEvent(task.id, "goal_planned", { summary: plan.summary, epics: epics.map((e) => ({ title: e.title, description: e.description })) });
    this.brain.createApproval({ taskId: task.id, goalId: goal.id }, "plan", `Approve the plan for: ${goal.prompt.slice(0, 120)}`, {
      summary: plan.summary,
      epics: plan.epics,
    });
  }

  async onPlanDecided(approval: Approval): Promise<void> {
    const goal = approval.goalId ? this.brain.getGoal(approval.goalId) : null;
    if (!goal || goal.status !== "awaiting_approval") return;
    if (approval.status === "rejected") {
      this.brain.updateGoal(goal.id, { status: "cancelled", error: "The plan was rejected" });
      for (const epic of this.brain.listEpics(goal.id)) this.brain.updateEpic(epic.id, { status: "cancelled" });
      if (approval.taskId) this.brain.addEvent(approval.taskId, "plan_rejected", {});
      return;
    }
    this.brain.updateGoal(goal.id, { status: "running", error: null });
    if (approval.taskId) this.brain.addEvent(approval.taskId, "plan_approved", {});
    await this.startNextEpic(goal.id);
  }

  /** Branches the next pending epic from the previous epic (or the newest base branch) and queues its planning. */
  async startNextEpic(goalId: string): Promise<void> {
    const goal = this.brain.getGoal(goalId);
    const project = goal && this.brain.getProject(goal.projectId);
    if (!goal || !project || goal.status !== "running") return;
    const epics = this.brain.listEpics(goalId);
    const next = epics.find((e) => e.status === "pending");
    if (!next) {
      if (epics.every((e) => e.status === "done" || e.status === "cancelled")) this.brain.updateGoal(goalId, { status: "done", error: null });
      return;
    }
    const previous = epics.filter((e) => e.position < next.position && e.branch).at(-1);
    try {
      const repo = project.localPath;
      const start = previous?.branch
        ? await git.resolveCommit(repo, `refs/heads/${previous.branch}`)
        : (await git.freshStartPoint(repo, project.defaultBranch)).sha;
      if (!start) throw new Error(`The branch ${previous?.branch} of the previous epic no longer exists`);
      const branch = `epic/${goal.id.slice(0, 8)}-${next.position + 1}-${slug(next.title)}`;
      if (!(await git.resolveCommit(repo, `refs/heads/${branch}`))) await git.createBranchAt(repo, branch, start);
      this.brain.updateEpic(next.id, { status: "planning", branch, baseBranch: previous?.branch ?? project.defaultBranch, error: null });
      this.brain.createTask(goal.sessionId, `Plan epic ${next.position + 1}: ${next.title}`, { kind: "epic_plan", goalId, epicId: next.id });
    } catch (error) {
      this.pause(goal, next, (error as Error).message, null);
    }
  }

  async planEpic(task: Task, running: RunningTask): Promise<void> {
    const { goal, project } = this.goalOf(task);
    const epic = task.epicId ? this.brain.getEpic(task.epicId) : null;
    if (!epic?.branch) throw new Error("The epic to plan has no branch");
    const repo = project.localPath;
    const tip = await git.resolveCommit(repo, `refs/heads/${epic.branch}`);
    if (!tip) throw new Error(`The epic branch ${epic.branch} no longer exists`);

    // A read-only copy of the epic branch, so the plan sees everything earlier epics built.
    const view = await git.detachedWorktree(repo, join(this.worktreesDir, `${basename(repo)}-plan-${task.id.slice(0, 8)}`), tip);
    let tasks: PlannedTask[] | null;
    try {
      const notes = (await this.orchestrator.readAiFiles(view.path, running.abort.signal))["HANDOFF.md"] ?? null;
      const prompt = prompts.epicPlan(project, goal, this.brain.listEpics(goal.id), epic, notes);
      tasks = parseTaskList(await this.orchestrator.runOnce(task, project, view.path, "planner", "read-only", prompt, running, "epic_plan"));
    } finally {
      await git.removeWorktree(repo, view).catch(() => {});
    }
    if (!tasks) throw new Error("The project manager did not return a usable task list for this epic");

    this.brain.updateEpic(epic.id, { plannedTasks: tasks, status: "running", error: null });
    this.brain.updateTask(task.id, { status: "done", plan: { tasks } });
    this.brain.addEvent(task.id, "epic_planned", { epic: epic.title, tasks: tasks.map((t) => ({ title: t.title, acceptance: t.acceptance })) });
    await this.advanceEpic(epic.id);
  }

  // ---- running an epic -----------------------------------------------------------------------------

  /** Queues the epic's next unfinished task, or asks the owner to push once every task is on the branch. */
  async advanceEpic(epicId: string, note?: string): Promise<void> {
    const epic = this.brain.getEpic(epicId);
    const goal = epic && this.brain.getGoal(epic.goalId);
    const project = goal && this.brain.getProject(goal.projectId);
    if (!epic?.branch || !goal || !project || goal.status !== "running" || epic.status !== "running") return;
    const tasks = this.brain.listEpicTasks(epic.id);
    // One step at a time: the next task must start from this one's commit.
    if (tasks.some((t) => !STOPPED.includes(t.status) && t.status !== "done")) return;
    const lastTask = tasks.at(-1) ?? null;

    if (goal.budgetUsd) {
      const spent = this.brain.goalUsage(goal.id).costUsd;
      if (spent >= goal.budgetUsd) {
        this.pause(goal, epic, `The goal's model calls cost $${spent.toFixed(4)}, which reached its $${goal.budgetUsd} budget. Raise the budget to continue.`, lastTask);
        return;
      }
    }

    const done = new Set(tasks.filter((t) => t.status === "done").map((t) => t.epicPosition));
    const position = epic.plannedTasks.findIndex((_, index) => !done.has(index));
    if (position >= 0) {
      const prompt = prompts.epicTask(goal, this.brain.listEpics(goal.id), epic, position, note);
      this.brain.createTask(goal.sessionId, prompt, { kind: "code", goalId: goal.id, epicId: epic.id, epicPosition: position });
      return;
    }

    const repo = project.localPath;
    const base = epic.baseBranch ?? project.defaultBranch;
    const commits = await git.commitLog(repo, base, epic.branch).catch(() => []);
    const stat = await git.diffStat(repo, base, epic.branch).catch(() => "");
    this.brain.updateEpic(epic.id, { status: "awaiting_approval" });
    this.brain.createApproval({ taskId: lastTask?.id ?? null, goalId: goal.id, epicId: epic.id }, "epic_push", `Push epic ${epic.position + 1}: ${epic.title}`, {
      branch: epic.branch,
      base,
      repo: project.githubRepo,
      stat,
      commits: commits.slice(-50),
      tasks: epic.plannedTasks.map((t) => t.title),
      prTitle: epic.title,
      prBody: prompts.epicPullRequest(goal, epic),
    });
  }

  /** Called by the pipeline when an epic task is committed: the epic branch moves to that commit. */
  async completeEpicTask(task: Task, epic: Epic, sha: string, startSha: string): Promise<void> {
    const project = this.brain.getProject(task.projectId);
    if (!project || !epic.branch) throw new Error("The epic of this task no longer exists");
    await git.moveBranch(project.localPath, epic.branch, sha, startSha);
    this.brain.updateTask(task.id, { status: "done" });
    this.brain.addEvent(task.id, "merged_into_epic", { branch: epic.branch, sha });
    await this.orchestrator.cleanupWorktree(task.id);
    await this.advanceEpic(epic.id);
  }

  async onEpicPushDecided(approval: Approval): Promise<void> {
    const epic = approval.epicId ? this.brain.getEpic(approval.epicId) : null;
    const goal = epic && this.brain.getGoal(epic.goalId);
    const project = goal && this.brain.getProject(goal.projectId);
    const task = approval.taskId ? this.brain.getTask(approval.taskId) : null;
    if (!epic?.branch || !goal || !project || !task || epic.status !== "awaiting_approval") return;
    if (approval.status === "rejected") {
      this.pause(goal, epic, `Kept ${epic.branch} local. Continue the goal to be asked again, or cancel it.`, task);
      return;
    }

    this.brain.updateEpic(epic.id, { status: "pushing" });
    try {
      const previous = this.brain.listEpics(goal.id).filter((e) => e.position < epic.position && e.prUrl && e.branch).at(-1);
      // Stack on the previous epic's pull request while it is open, so this one shows only its own changes.
      const stacked = previous?.prUrl && (await this.github.pullRequestState(project.localPath, previous.prUrl)) === "OPEN";
      const base = stacked && previous?.branch ? previous.branch : project.defaultBranch;
      await this.orchestrator.bringUpToDate(task, project, epic.branch, base, null);
      await git.pushBranch(project.localPath, epic.branch);
      const payload = approval.payload as { prTitle?: string; prBody?: string };
      const prUrl = await this.github.openPullRequest(project.localPath, {
        base,
        head: epic.branch,
        title: payload.prTitle ?? epic.title,
        body: payload.prBody ?? epic.description,
        repo: project.githubRepo,
      });
      this.brain.updateEpic(epic.id, { status: "done", prUrl, error: null });
      this.brain.addEvent(task.id, "epic_pushed", { branch: epic.branch, base, url: prUrl });
    } catch (error) {
      this.pause(goal, epic, `Pushing ${epic.branch} failed: ${(error as Error).message}`, task);
      return;
    }
    await this.startNextEpic(goal.id);
  }

  // ---- stopping and continuing ---------------------------------------------------------------------

  /** Called after every task of a goal ends; a task that stopped pauses its epic and the goal. */
  async afterTask(task: Task): Promise<void> {
    if (!task.goalId || !STOPPED.includes(task.status)) return;
    const goal = this.brain.getGoal(task.goalId);
    if (!goal || goal.status === "cancelled" || goal.status === "done") return;
    if (task.kind === "goal_plan") {
      this.brain.updateGoal(goal.id, { status: task.status === "cancelled" ? "cancelled" : "failed", error: task.error });
      return;
    }
    const epic = task.epicId ? this.brain.getEpic(task.epicId) : null;
    this.pause(goal, epic, task.status === "cancelled" ? "A task of this goal was cancelled." : (task.error ?? "A task needs your help."), task);
  }

  private pause(goal: Goal, epic: Epic | null, reason: string, task: Task | null): void {
    if (epic && epic.status !== "done" && epic.status !== "cancelled") this.brain.updateEpic(epic.id, { status: "paused", error: reason });
    this.brain.updateGoal(goal.id, { status: "paused", error: reason });
    if (task) this.brain.addEvent(task.id, "goal_paused", { reason });
    this.log(`goal ${goal.id.slice(0, 8)} paused: ${reason}`);
  }

  /** The owner continues a paused goal: retry the stopped step (with an optional note), re-plan, or ask to push again. */
  async resumeGoal(goalId: string, options: { note?: string; budgetUsd?: number | null } = {}): Promise<Goal> {
    const goal = this.brain.getGoal(goalId);
    if (!goal) throw new Error("Goal not found");
    if (goal.status !== "paused" && goal.status !== "failed") throw new Error("Only a paused or failed goal can continue");
    const budget = "budgetUsd" in options ? { budgetUsd: options.budgetUsd ?? null } : {};
    const epics = this.brain.listEpics(goalId);

    if (epics.length === 0) {
      this.brain.updateGoal(goalId, { status: "planning", error: null, ...budget });
      this.brain.createTask(goal.sessionId, `Plan the goal: ${goal.prompt}`, { kind: "goal_plan", goalId });
      return this.brain.getGoal(goalId)!;
    }

    this.brain.updateGoal(goalId, { status: "running", error: null, ...budget });
    const epic = epics.find((e) => e.status === "paused");
    if (!epic || !epic.branch) {
      if (epic) this.brain.updateEpic(epic.id, { status: "pending", error: null });
      await this.startNextEpic(goalId);
    } else if (epic.plannedTasks.length === 0) {
      this.brain.updateEpic(epic.id, { status: "planning", error: null });
      this.brain.createTask(goal.sessionId, `Plan epic ${epic.position + 1}: ${epic.title}`, { kind: "epic_plan", goalId, epicId: epic.id });
    } else {
      this.brain.updateEpic(epic.id, { status: "running", error: null });
      await this.advanceEpic(epic.id, options.note?.trim() || undefined);
    }
    return this.brain.getGoal(goalId)!;
  }

  cancelGoal(goalId: string): void {
    const goal = this.brain.getGoal(goalId);
    if (!goal) throw new Error("Goal not found");
    if (goal.status === "done" || goal.status === "cancelled") throw new Error("This goal has already ended");
    this.brain.updateGoal(goalId, { status: "cancelled", error: null });
    for (const approval of this.brain.listApprovals("pending")) if (approval.goalId === goalId) this.brain.decideApproval(approval.id, "rejected");
    for (const epic of this.brain.listEpics(goalId)) if (epic.status !== "done" && epic.status !== "cancelled") this.brain.updateEpic(epic.id, { status: "cancelled" });
    for (const task of this.brain.listTasks(goal.sessionId)) if (task.goalId === goalId) this.orchestrator.cancel(task.id);
  }

  /** After a restart: goals whose task was interrupted pause, and so do epics that were being pushed. */
  async recover(interruptedTaskIds: string[]): Promise<void> {
    for (const id of interruptedTaskIds) {
      const task = this.brain.getTask(id);
      if (task) await this.afterTask(task);
    }
    for (const epic of this.brain.listEpicsByStatus("pushing")) {
      const goal = this.brain.getGoal(epic.goalId);
      if (goal) this.pause(goal, epic, "The server restarted while this epic was being pushed. Continue the goal to try again.", null);
    }
  }
}
