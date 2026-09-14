import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Approval, Brain, CriticKind, Epic, Memory, MemoryKind, Project, Role, Task, Usage } from "@ai-employee/brain";
import type { DshAgent, PermissionMode, RequestPermissionRequest, RequestPermissionResponse, SessionUpdate } from "@ai-employee/dsh-client";
import * as git from "@ai-employee/git";
import { runCapture, runShellCommand } from "./checks.ts";
import { blockingFindings, CRITIC_INFO, planCritics, type CriticFinding, type CriticPlan, type CriticVerdict } from "./critics.ts";
import { AI_DIR, AI_FILES, dayStamp, parseHandoffReply, planHandoffWrite, templateFiles, type AiFiles, type FileOp } from "./handoff.ts";
import type { McpTokens } from "./mcp.ts";
import {
  advisoriesInTime,
  advisoryQuery,
  dependencyChanges,
  dependencyFindings,
  directDependencies,
  lockedVersions,
  lookupPackages,
  versionRows,
  versionsBlock,
  type DependencyChange,
  type PackageLookup,
} from "./packages.ts";
import {
  detectPackageChecks,
  formatQuickFindings,
  generatedCandidates,
  quickFindings,
  scriptFiles,
  scriptProblem,
  structuredFiles,
  type DetectedCheck,
  type QuickFinding,
} from "./quickChecks.ts";
import { dailyBudgetMessage, nextDay, spendingSettings, todaySpend } from "./spending.ts";
import { appCommand, captureFindings, freePort, type CaptureResult, type VisualTools } from "./visual.ts";
import { decidePermission, permissionResponse } from "./policy.ts";
import * as prompts from "./prompts.ts";
import { ProjectManager, type PullRequestState } from "./manager.ts";
import { prepareWorktree, protectCheckout } from "./workspace.ts";

const MAX_ROUNDS = 3;
/** Review rounds for the one extra try with the stronger model. */
const ESCALATION_ROUNDS = 2;
/** Fix rounds after the critics' final check before the task goes to the owner. */
const MAX_CRITIC_FIXES = 2;
/** About 10k tokens of diff per critic; anything longer is cut. */
const MAX_CRITIC_DIFF_CHARS = 40_000;
const CHECK_TIMEOUT_MS = 10 * 60_000;
/** Changes bigger than this skip the line-by-line scan (their size is reported instead). */
const MAX_QUICK_DIFF_BYTES = 20 * 1024 * 1024;
const SETUP_TIMEOUT_MS = 20 * 60_000;
/** Direct dependencies looked up on the npm registry before planning; a bigger package.json gets its first ones. */
const MAX_VERSION_PACKAGES = 60;
/** package.json files per change whose new dependencies are checked. */
const MAX_MANIFESTS = 10;
/** A model call that arrives just after a prompt finished (for example a session title) still belongs to it. */
const LATE_CALL_MS = 2 * 60_000;
const CANCELLED = "cancelled";

class CancelledError extends Error {
  constructor() {
    super("Task cancelled");
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new CancelledError();
}

/** The parts of a DeepSeek Harness process the pipeline uses; tests pass a fake. */
export type AgentHandle = Pick<DshAgent, "newSession" | "selectModel" | "prompt" | "cancel" | "closeSession">;

export interface AgentSource {
  get(mode: PermissionMode): Promise<AgentHandle>;
}

export interface OrchestratorOptions {
  brain: Brain;
  pool: AgentSource;
  tokens: McpTokens;
  mcpUrl: string;
  log: (message: string) => void;
  /** Task worktrees are created here, one folder per task. */
  worktreesDir: string;
  /** Unprivileged user for agents and checks; unset in local development. */
  agentUser?: string;
  agentGroup?: string;
  checkRunner?: string[];
  maxParallelTasks?: number;
  /** GitHub access for pull requests; tests replace it. */
  openPullRequest?: typeof git.createPullRequest;
  pullRequestState?: (repo: string, url: string) => Promise<PullRequestState>;
  /** Starts a task's app and judges its screenshots for the UI critic; unset skips the visual check. */
  visual?: VisualTools;
  /** The npm registry, for current stable versions and dependency checks; unset skips both. */
  packages?: PackageLookup;
}

export interface AgentSession {
  prompt(text: string): Promise<string>;
  close(): Promise<void>;
}

export interface RunningTask {
  taskId: string;
  abort: AbortController;
  sessions: Set<{ agent: AgentHandle; sessionId: string }>;
  /** Why the task is being stopped: "cancelled", or the message for a spent budget. */
  stopReason?: string;
  /** The merge before an approved push. The daily budget refuses its model calls but does not abort it. */
  merge?: boolean;
}

interface PromptingRun {
  runId: string;
  taskId: string;
  cwd: string;
}

/** Where a task's coding happens: its worktree and branch, the commit it started from, and its plan. */
interface BuildContext {
  worktree: git.Worktree;
  branch: string;
  base: string;
  diffBase: string;
  plan: prompts.Plan;
  memories: Memory[];
  epic: Epic | null;
  /** Current stable versions of the project's npm dependencies for the Coder's prompts; empty without a package.json. */
  versions: string;
}

interface CodingOutcome {
  approved: boolean;
  verdict: prompts.Verdict | null;
  checksReport: string;
  critics: CriticOutcome | null;
  /** The number of the last review round, counted across tries. */
  lastRound: number;
}

interface CriticOutcome {
  passed: boolean;
  /** Why the change cannot be committed, when it did not pass. */
  message?: string;
  /** The latest check results, when a fix round ran them again. */
  checksReport?: string;
  feedback: string[];
}

/** Turns ACP session updates into a readable, coalesced event stream for the dashboard timeline. */
class UpdateRecorder {
  private message = "";
  private thought = "";

  constructor(
    private readonly brain: Brain,
    private readonly taskId: string,
    private readonly runId: string,
    private readonly role: Role,
  ) {}

  push(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") this.message += update.content.text;
        break;
      case "agent_thought_chunk":
        if (update.content.type === "text") this.thought += update.content.text;
        break;
      case "tool_call":
        this.flush();
        this.brain.addEvent(
          this.taskId,
          "tool_call",
          {
            role: this.role,
            toolCallId: update.toolCallId,
            title: update.title,
            kind: update.kind ?? null,
            input: summarizeInput(update.rawInput),
            paths: (update.locations ?? []).map((l) => l.path),
          },
          this.runId,
        );
        break;
      case "tool_call_update":
        if (update.status === "completed" || update.status === "failed") {
          this.brain.addEvent(this.taskId, "tool_result", { role: this.role, toolCallId: update.toolCallId, title: update.title ?? null, status: update.status }, this.runId);
        }
        break;
      case "plan":
        this.flush();
        this.brain.addEvent(this.taskId, "agent_plan", { role: this.role, entries: update.entries }, this.runId);
        break;
      default:
        break;
    }
  }

  flush(): void {
    if (this.thought.trim()) this.brain.addEvent(this.taskId, "agent_thought", { role: this.role, text: prompts.truncate(this.thought.trim(), 4_000) }, this.runId);
    if (this.message.trim()) this.brain.addEvent(this.taskId, "agent_message", { role: this.role, text: prompts.truncate(this.message.trim(), 20_000) }, this.runId);
    this.thought = "";
    this.message = "";
  }
}

/** A short, human-readable hint of what a tool call does (command, path or pattern). */
function summarizeInput(rawInput: unknown): string | null {
  if (rawInput === undefined || rawInput === null) return null;
  if (typeof rawInput !== "object") return prompts.truncate(String(rawInput), 200);
  const record = rawInput as Record<string, unknown>;
  for (const key of ["command", "cmd", "path", "file_path", "filePath", "pattern", "query", "url"]) {
    const value = record[key];
    if (typeof value === "string") return prompts.truncate(value, 200);
  }
  return prompts.truncate(JSON.stringify(rawInput), 200);
}

const MEMORY_KINDS: MemoryKind[] = ["preference", "convention", "fact", "lesson", "note"];

const worktreeFolder = (repo: string, taskId: string) => `${basename(repo).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60)}-${taskId.slice(0, 8)}`;

/** Shell commands that write a file through the agent user; base64 keeps the content out of shell parsing. */
function fileOpCommands(op: FileOp): string[] {
  const quoted = `'${op.path}'`;
  const chunks = (text: string) => {
    const encoded = Buffer.from(text, "utf8").toString("base64");
    const parts: string[] = [];
    for (let i = 0; i < encoded.length; i += 60_000) parts.push(encoded.slice(i, i + 60_000));
    return parts.length ? parts : [""];
  };
  const commands = [`mkdir -p -- '${dirname(op.path)}'`];
  if (op.mode === "write") commands.push(`: > ${quoted}`);
  else if (op.header) commands.push(`[ -e ${quoted} ] || printf '%s' '${Buffer.from(op.header, "utf8").toString("base64")}' | base64 -d > ${quoted}`);
  for (const part of chunks(op.content)) commands.push(`printf '%s' '${part}' | base64 -d >> ${quoted}`);
  return commands;
}

/**
 * Runs queued tasks through worktree → Planner → Coder ⇄ checks ⇄ Reviewer → critics → handoff notes → commit →
 * approval. Each task gets its own git worktree, so several tasks can run at once and the project checkout is never
 * edited.
 */
export class Orchestrator {
  private readonly brain: Brain;
  private readonly pool: AgentSource;
  private readonly tokens: McpTokens;
  private readonly log: (message: string) => void;
  private readonly running = new Map<string, RunningTask>();
  private readonly prompting = new Map<string, PromptingRun>();
  private lastPrompt: (PromptingRun & { at: number }) | null = null;
  private ticking = false;
  private dayTimer: NodeJS.Timeout | undefined;
  readonly manager: ProjectManager;

  constructor(private readonly options: OrchestratorOptions) {
    this.brain = options.brain;
    this.pool = options.pool;
    this.tokens = options.tokens;
    this.log = options.log;
    this.manager = new ProjectManager(
      options.brain,
      this,
      options.worktreesDir,
      { openPullRequest: options.openPullRequest ?? git.createPullRequest, pullRequestState: options.pullRequestState ?? git.pullRequestState },
      options.log,
    );
  }

  private get maxParallel(): number {
    return Math.max(1, this.options.maxParallelTasks ?? 1);
  }

  start(): void {
    this.brain.on("change", (change) => {
      // A raised daily budget lets waiting tasks start.
      if (change.kind === "task" || change.kind === "settings") this.tick();
    });
    this.tick();
  }

  get runningTaskIds(): string[] {
    return [...this.running.keys()];
  }

  private tick(): void {
    if (this.ticking) return;
    this.ticking = true;
    try {
      while (this.running.size < this.maxParallel) {
        if (this.dailyBudgetStop()) {
          this.wakeAtMidnight();
          break;
        }
        const task = this.brain.claimNextTask("server");
        if (!task) break;
        const running: RunningTask = { taskId: task.id, abort: new AbortController(), sessions: new Set() };
        this.running.set(task.id, running);
        void this.process(task, running).finally(() => {
          this.running.delete(task.id);
          this.tick();
        });
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Why no model may be called and no task may start, once all tasks together reached today's budget. */
  private dailyBudgetStop(): string | null {
    const { dailyBudgetUsd } = spendingSettings(this.brain);
    if (dailyBudgetUsd === null) return null;
    const spent = todaySpend(this.brain);
    return spent >= dailyBudgetUsd ? dailyBudgetMessage(spent, dailyBudgetUsd) : null;
  }

  private wakeAtMidnight(): void {
    if (this.dayTimer) return;
    const wait = nextDay(new Date()).getTime() - Date.now() + 1_000;
    this.dayTimer = setTimeout(() => {
      this.dayTimer = undefined;
      this.tick();
    }, wait);
    this.dayTimer.unref();
  }

  cancel(taskId: string): boolean {
    const task = this.brain.getTask(taskId);
    if (!task) return false;
    const running = this.running.get(taskId);
    if (running) {
      this.stop(running, CANCELLED);
      return true;
    }
    if (["queued", "awaiting_approval", "needs_human"].includes(task.status)) {
      for (const a of this.brain.listApprovals("pending")) if (a.taskId === taskId) this.brain.decideApproval(a.id, "rejected");
      this.brain.updateTask(taskId, { status: "cancelled" });
      this.brain.addEvent(taskId, "task_cancelled", {});
      void this.cleanupWorktree(taskId);
      return true;
    }
    return false;
  }

  private stop(running: RunningTask, reason: string): void {
    if (running.stopReason) return;
    running.stopReason = reason;
    running.abort.abort();
    for (const s of running.sessions) void s.agent.cancel(s.sessionId).catch(() => {});
  }

  // ---- model gateway hooks ------------------------------------------------------------------------

  /**
   * The agent run a model call belongs to. Within a task only one agent prompts at a time; across parallel tasks
   * the request is matched by the task's worktree path, which the agent's context contains.
   */
  resolveRun(requestBody: string): { runId: string; taskId: string } | null {
    const pick = (r: PromptingRun) => ({ runId: r.runId, taskId: r.taskId });
    const active = [...this.prompting.values()];
    if (active.length === 1) return pick(active[0]!);
    if (active.length > 1) {
      const matches = active.filter((r) => requestBody.includes(JSON.stringify(r.cwd).slice(1, -1)));
      return matches.length === 1 ? pick(matches[0]!) : null;
    }
    const last = this.lastPrompt;
    return last && Date.now() - last.at < LATE_CALL_MS ? pick(last) : null;
  }

  /** Why model calls for this task are refused, if they are. */
  refusal(taskId: string): string | null {
    const reason = this.running.get(taskId)?.stopReason;
    if (reason) return reason === CANCELLED ? "The task was cancelled" : reason;
    return this.dailyBudgetStop();
  }

  recordUsage(runId: string, usage: Usage): void {
    const run = this.brain.recordUsage(runId, usage);
    const task = this.brain.getTask(run.taskId);
    const budget = task && this.brain.getProject(task.projectId)?.taskBudgetUsd;
    const running = this.running.get(run.taskId);
    if (!running) return;
    const spent = this.brain.taskUsage(run.taskId).costUsd;
    if (budget && spent >= budget) {
      this.log(`task ${run.taskId.slice(0, 8)} reached its budget ($${spent.toFixed(4)} of $${budget})`);
      this.stop(running, `Stopped: the model calls for this task cost $${spent.toFixed(4)}, which reached its $${budget} budget. Raise the budget in project settings to allow more.`);
      return;
    }
    const daily = this.dailyBudgetStop();
    if (daily) {
      this.log(`all tasks together reached the daily budget; stopping ${this.running.size} running task(s)`);
      // An approved push that is merging keeps going; its model calls are refused, and the push fails with that reason.
      for (const other of this.running.values()) if (!other.merge) this.stop(other, daily);
    }
  }

  // ---- pipeline -------------------------------------------------------------------------------------

  private async process(task: Task, running: RunningTask): Promise<void> {
    this.log(`task ${task.id.slice(0, 8)} started: ${task.prompt.slice(0, 80)}`);
    try {
      if (task.kind === "goal_plan") await this.manager.planGoal(task, running);
      else if (task.kind === "epic_plan") await this.manager.planEpic(task, running);
      else {
        const continuation = this.continuation(task);
        if (continuation) await this.continuePipeline(task, running, continuation.note);
        else await this.runPipeline(task, running);
      }
    } catch (error) {
      const reason = running.stopReason;
      const budget = reason !== undefined && reason !== CANCELLED;
      const cancelled = !budget && (reason === CANCELLED || running.abort.signal.aborted || error instanceof CancelledError);
      const message = budget ? reason : error instanceof Error ? error.message : String(error);
      this.brain.updateTask(task.id, { status: cancelled ? "cancelled" : "failed", error: cancelled ? null : message });
      this.brain.addEvent(task.id, cancelled ? "task_cancelled" : "task_failed", { message, ...(budget ? { reason: "budget" } : {}) });
      this.log(`task ${task.id.slice(0, 8)} ${cancelled ? "cancelled" : `failed: ${message}`}`);
      if (cancelled) await this.cleanupWorktree(task.id);
    } finally {
      for (const s of running.sessions) void s.agent.closeSession(s.sessionId).catch(() => {});
    }
    const finished = this.brain.getTask(task.id);
    if (finished?.goalId) await this.manager.afterTask(finished).catch((error: Error) => this.log(`project manager: ${error.message}`));
  }

  private recallMemories(project: Project, query: string): Memory[] {
    const byId = new Map<string, Memory>();
    for (const m of this.brain.searchMemories(project.id, query, 12)) byId.set(m.id, m);
    for (const m of this.brain.listMemories({ scope: "global" }, 20)) if (m.kind === "preference" || m.kind === "convention") byId.set(m.id, m);
    for (const m of this.brain.listMemories({ scope: "project", projectId: project.id }, 20)) if (m.kind === "convention") byId.set(m.id, m);
    return [...byId.values()].slice(0, 30);
  }

  private async runPipeline(task: Task, running: RunningTask): Promise<void> {
    const signal = running.abort.signal;
    const project = this.brain.getProject(task.projectId);
    if (!project) throw new Error("The project no longer exists");
    const repo = project.localPath;
    if (!(await git.isGitRepo(repo))) throw new Error(`${repo} is not a git repository`);
    const epic = task.epicId ? this.brain.getEpic(task.epicId) : null;
    if (task.epicId && !epic?.branch) throw new Error("The epic of this task has no branch");
    // An epic's tasks build on each other on the epic branch; a single task starts from the newest base, GitHub included.
    const base = epic?.branch ?? project.defaultBranch;
    if (this.options.agentUser) await protectCheckout(repo, this.options.agentUser);

    const memories = this.recallMemories(project, task.prompt);
    this.brain.addEvent(task.id, "task_started", { project: project.name, base });
    this.brain.addEvent(task.id, "memory_loaded", { items: memories.map((m) => ({ scope: m.scope, kind: m.kind, content: m.content })) });

    // 1. Git agent: a worktree on a new branch, so the project checkout is never touched
    const branch = git.branchName(task.id, task.prompt);
    mkdirSync(this.options.worktreesDir, { recursive: true });
    let diffBase: string;
    if (epic) {
      const tip = await git.resolveCommit(repo, `refs/heads/${base}`);
      if (!tip) throw new Error(`The epic branch ${base} no longer exists`);
      diffBase = tip;
    } else {
      const start = await git.freshStartPoint(repo, base);
      diffBase = start.sha;
      this.brain.addEvent(task.id, "base_refreshed", { base, sha: start.sha, source: start.source, diverged: start.diverged, fetched: start.fetched });
    }
    const worktree = await git.addWorktree(repo, join(this.options.worktreesDir, worktreeFolder(repo, task.id)), branch, diffBase);
    this.brain.updateTask(task.id, { branch, baseBranch: base, worktreePath: worktree.path });
    if (this.options.agentUser) await prepareWorktree(worktree.path, this.options.agentUser, this.options.agentGroup ?? "aiwork");
    this.brain.addEvent(task.id, "branch_created", { branch, base, worktree: worktree.path });
    const cwd = worktree.path;

    if (project.setupCmd?.trim()) {
      const command = project.setupCmd.trim();
      this.brain.addEvent(task.id, "setup_started", { command });
      const result = await runShellCommand(command, cwd, SETUP_TIMEOUT_MS, signal, this.options.checkRunner);
      this.brain.addEvent(task.id, "setup_finished", { command, ok: result.ok, exitCode: result.exitCode, output: result.output });
      throwIfAborted(signal);
      if (!result.ok) throw new Error(`The setup command \`${command}\` failed with exit code ${result.exitCode}. Check it in project settings.`);
      await this.shareAgentFiles(task, cwd, signal);
    }
    if (!project.testCmd?.trim() && !project.lintCmd?.trim()) await this.detectChecks(task, project, worktree, diffBase, signal);

    const versions = await this.checkVersions(task, worktree, diffBase, signal);

    // 2. Planner
    const notes = (await this.readAiFiles(cwd, signal))["HANDOFF.md"] ?? null;
    const planText = await this.runOnce(task, project, cwd, "planner", "read-only", prompts.planner(project, task, memories, notes, versions), running);
    const plan = prompts.extractJson<prompts.Plan>(planText) ?? { summary: prompts.truncate(planText, 4_000) };
    this.brain.updateTask(task.id, { status: "coding", plan });
    this.brain.addEvent(task.id, "plan_ready", { plan });

    const context: BuildContext = { worktree, branch, base, diffBase, plan, memories, epic, versions };
    await this.buildAndCommit(task, project, running, context, prompts.coder(project, task, plan, memories, branch, versions));
  }

  /**
   * The owner continues a stopped task: its earlier work stays in the worktree and a fresh Coder session picks up from
   * there with the owner's note and why the task stopped. Nothing was committed yet, so HEAD is still the task's start.
   */
  continueTask(taskId: string, note: string): Task {
    const task = this.brain.getTask(taskId);
    if (!task) throw new Error("Task not found");
    if (task.goalId) throw new Error("This task belongs to a goal. Continue the goal instead.");
    if (task.kind !== "code" || !(task.status === "needs_human" || (task.status === "failed" && !task.commitSha))) {
      throw new Error("Only a task that needs your help, or stopped before its commit, can continue");
    }
    if (!task.plan || !task.branch || !task.worktreePath || !existsSync(task.worktreePath)) {
      throw new Error("This task stopped before its work folder was ready, or the folder was cleaned up. Start a new task instead.");
    }
    this.brain.addEvent(task.id, "task_continued", { note, previousStatus: task.status });
    return this.brain.updateTask(task.id, { status: "queued", error: null });
  }

  /** The owner's note when this queued task continues stopped work instead of starting fresh. */
  private continuation(task: Task): { note: string } | null {
    const last = this.brain
      .listEvents(task.id)
      .filter((e) => e.type === "task_continued" || e.type === "task_started")
      .at(-1);
    return last?.type === "task_continued" ? { note: String(last.payload.note ?? "") } : null;
  }

  private async continuePipeline(task: Task, running: RunningTask, note: string): Promise<void> {
    const project = this.brain.getProject(task.projectId);
    if (!project) throw new Error("The project no longer exists");
    if (!task.plan || !task.branch || !task.worktreePath || !existsSync(task.worktreePath)) {
      throw new Error("The task's work folder is gone, so it cannot continue. Start a new task instead.");
    }
    if (this.options.agentUser) await protectCheckout(project.localPath, this.options.agentUser);
    const worktree = await git.openWorktree(project.localPath, task.worktreePath);
    const diffBase = await git.headSha(worktree);
    const base = task.baseBranch ?? project.defaultBranch;
    const plan = task.plan as prompts.Plan;
    const memories = this.recallMemories(project, `${task.prompt}\n${note}`);
    const stopped = this.brain
      .listEvents(task.id)
      .filter((e) => e.type === "needs_human" || e.type === "task_failed")
      .at(-1);
    const why = String(stopped?.payload.lastFeedback ?? stopped?.payload.message ?? "");
    this.brain.addEvent(task.id, "task_resumed", { branch: task.branch, base, note });
    const versions = await this.checkVersions(task, worktree, diffBase, running.abort.signal);
    const first = prompts.coderContinue(project, task, plan, memories, task.branch, note, why, versions);
    await this.buildAndCommit(task, project, running, { worktree, branch: task.branch, base, diffBase, plan, memories, epic: null, versions }, first);
  }

  /**
   * Coder ⇄ checks ⇄ Reviewer, the critics' final round, handoff notes, the commit, and the push approval (or the epic
   * branch). `firstPrompt` starts the Coder: the task itself, or a continuation of stopped work.
   */
  private async buildAndCommit(task: Task, project: Project, running: RunningTask, context: BuildContext, firstPrompt: string): Promise<void> {
    const { worktree, branch, plan, memories } = context;
    const signal = running.abort.signal;
    const cwd = worktree.path;

    // 3. Coder ⇄ checks ⇄ Reviewer (the logic and backend critic), then the specialist critics' final round
    const feedbackLog: string[] = [];
    let outcome = await this.codeAndReview(task, project, running, context, firstPrompt, { firstRound: 1, rounds: MAX_ROUNDS }, feedbackLog);

    // One more try with a stronger model, in a fresh session that gets a summary instead of the failed rounds' context.
    const stronger = spendingSettings(this.brain).escalationModel;
    const coderModel = this.brain.getRoleSetting("coder").model;
    let escalated = false;
    if (!(outcome.approved && outcome.critics?.passed) && stronger && stronger !== coderModel) {
      this.brain.addEvent(task.id, "escalated", { from: coderModel, to: stronger, reason: outcome.approved ? "critics" : "review" });
      const prompt = prompts.coderEscalate(project, task, plan, memories, branch, feedbackLog.at(-1) ?? "", context.versions);
      try {
        outcome = await this.codeAndReview(task, project, running, context, prompt, { firstRound: outcome.lastRound + 1, rounds: ESCALATION_ROUNDS, model: stronger }, feedbackLog);
        escalated = true;
      } catch (error) {
        if (error instanceof CancelledError || signal.aborted) throw error;
        this.brain.addEvent(task.id, "escalation_failed", { model: stronger, message: error instanceof Error ? error.message : String(error) });
      }
    }
    const { approved, verdict, critics, checksReport } = outcome;

    if (!approved || !critics?.passed) {
      const reason = approved ? "critics" : "review";
      this.brain.updateTask(task.id, {
        status: "needs_human",
        error: approved
          ? (critics?.message ?? "The critics did not pass the change.")
          : `Not ready after ${outcome.lastRound} rounds${escalated ? ` (the last ones with ${stronger})` : ""}. The changes are left uncommitted on ${branch} in ${cwd} for you to inspect.`,
      });
      this.brain.addEvent(task.id, "needs_human", { lastFeedback: feedbackLog.at(-1) ?? null, worktree: cwd, reason });
      await this.learn(task, project, cwd, plan, feedbackLog, running);
      return;
    }
    await this.commitReviewed(task, project, running, context, feedbackLog, verdict, checksReport);
  }

  /** Coder rounds against the checks and the Reviewer, then the critics once the Reviewer approves. */
  private async codeAndReview(
    task: Task,
    project: Project,
    running: RunningTask,
    context: BuildContext,
    firstPrompt: string,
    options: { firstRound: number; rounds: number; model?: string },
    feedbackLog: string[],
  ): Promise<CodingOutcome> {
    const { worktree, diffBase, plan } = context;
    const signal = running.abort.signal;
    const cwd = worktree.path;
    let verdict: prompts.Verdict | null = null;
    let approved = false;
    let checksReport = "";
    let critics: CriticOutcome | null = null;
    let lastRound = options.firstRound - 1;
    const coderSession = await this.openSession(task, project, cwd, "coder", "workspace-write", running, options.model ? "escalation" : undefined, options.model);
    try {
      let feedback: string | null = null;
      for (let round = options.firstRound; round < options.firstRound + options.rounds && !approved; round++) {
        lastRound = round;
        this.brain.updateTask(task.id, { status: "coding", reviewRounds: round - 1 });
        this.brain.addEvent(task.id, "round_started", { round });
        await coderSession.prompt(feedback ? prompts.coderFollowUp(feedback) : firstPrompt);
        throwIfAborted(signal);

        this.brain.updateTask(task.id, { status: "checking" });
        const checks = await this.runChecks(task, project, worktree, diffBase, signal);
        checksReport = checks.report;
        await this.shareAgentFiles(task, cwd, signal);
        const { diff, stat } = await git.diffAgainst(worktree, diffBase);
        if (!diff.trim()) {
          feedback = "No files have been changed yet. Implement the task.";
          feedbackLog.push(feedback);
          continue;
        }
        if (!checks.ok) {
          feedback = `The project checks failed:\n\n${checks.report}`;
          feedbackLog.push(feedback);
          continue;
        }

        this.brain.updateTask(task.id, { status: "reviewing" });
        const reviewText = await this.runOnce(task, project, cwd, "reviewer", "read-only", prompts.reviewer(task, plan, diff, stat, checks.report), running);
        verdict = prompts.extractJson<prompts.Verdict>(reviewText) ?? {
          approve: false,
          summary: prompts.truncate(reviewText, 2_000),
          issues: [{ severity: "major", message: "The reviewer did not return a structured verdict; address any concerns in its summary." }],
        };
        approved = prompts.isApproved(verdict);
        this.brain.updateTask(task.id, { reviewRounds: round });
        this.brain.addEvent(task.id, "review_verdict", { round, approved, summary: verdict.summary ?? "", issues: verdict.issues ?? [] });
        if (!approved) {
          feedback = prompts.formatIssues(verdict);
          feedbackLog.push(feedback);
        }
      }

      if (approved) {
        critics = await this.runCritics(task, project, worktree, diffBase, plan, checksReport, coderSession, running);
        feedbackLog.push(...critics.feedback);
        if (critics.checksReport) checksReport = critics.checksReport;
      }
    } finally {
      await coderSession.close();
    }
    return { approved, verdict, checksReport, critics, lastRound };
  }

  /** Handoff notes, the last secret scan, the commit, and the push approval (or the epic branch). */
  private async commitReviewed(
    task: Task,
    project: Project,
    running: RunningTask,
    context: BuildContext,
    feedbackLog: string[],
    verdict: prompts.Verdict | null,
    checksReport: string,
  ): Promise<void> {
    const { worktree, branch, base, diffBase, plan, epic } = context;
    const signal = running.abort.signal;
    const cwd = worktree.path;

    // 4. Handoff notes in .ai/, part of the same commit
    const reviewed = await git.diffAgainst(worktree, diffBase);
    await this.updateHandoff(task, project, cwd, branch, plan, reviewed.stat, verdict?.summary ?? "", checksReport, running);

    // A secret never reaches a commit, whatever the rounds before decided (the handoff notes included).
    const leaked = (await this.quickCheck(task, worktree, diffBase, signal, { dependencies: false })).filter((f) => f.kind === "secret");
    if (leaked.length) {
      this.brain.updateTask(task.id, {
        status: "needs_human",
        error: `Nothing was committed: the change contains ${leaked.length === 1 ? "a secret" : `${leaked.length} secrets`} (${leaked.map((f) => f.file).join(", ")}). The changes are in ${cwd} for you to inspect.`,
      });
      this.brain.addEvent(task.id, "needs_human", { lastFeedback: formatQuickFindings(leaked), worktree: cwd, reason: "secret" });
      return;
    }

    // 5. Git agent: commit, then wait for the user's approval to push + open a PR
    const { diff: finalDiff, stat } = await git.diffAgainst(worktree, diffBase);
    const messagesText = await this.runOnce(task, project, cwd, "git", "read-only", prompts.gitMessages(task, plan, stat, verdict?.summary ?? ""), running);
    const messages = prompts.extractJson<prompts.GitMessages>(messagesText) ?? {};
    const commitMessage = messages.commitMessage?.trim() || `feat: ${task.prompt.split("\n")[0]!.slice(0, 64)}`;
    const sha = await git.commitAll(worktree, commitMessage);
    this.brain.addEvent(task.id, "committed", { sha, message: commitMessage, stat, diff: prompts.truncate(finalDiff, 80_000) });
    if (epic) {
      // Epic tasks need no push approval of their own: the commit joins the epic branch and the next task builds on it.
      this.brain.updateTask(task.id, { commitSha: sha });
      await this.learn(task, project, cwd, plan, feedbackLog, running);
      await this.manager.completeEpicTask(task, epic, sha, diffBase);
      return;
    }
    this.brain.updateTask(task.id, { commitSha: sha, status: "awaiting_approval" });
    this.brain.createApproval(task.id, "push_and_pr", `Push ${branch} and open a pull request into ${base}`, {
      branch,
      base,
      stat,
      repo: project.githubRepo,
      prTitle: messages.prTitle?.trim() || commitMessage.split("\n")[0],
      prBody: messages.prBody?.trim() || `${plan.summary ?? task.prompt}\n\nReviewed by the AI Reviewer: ${verdict?.summary ?? ""}`,
      reviewSummary: verdict?.summary ?? "",
    });

    await this.learn(task, project, cwd, plan, feedbackLog, running);
  }

  /**
   * The final round before the commit. A script picks the specialist critics this change needs; each judges only its
   * files' diff. Problems go back to the Coder, the checks run again, and only the critics that failed (or a critic
   * the fix newly calls for) look again. After MAX_CRITIC_FIXES fix rounds the owner decides.
   */
  private async runCritics(
    task: Task,
    project: Project,
    worktree: git.Worktree,
    base: string,
    plan: prompts.Plan,
    checksReport: string,
    coder: AgentSession,
    running: RunningTask,
  ): Promise<CriticOutcome> {
    const signal = running.abort.signal;
    const changes = async () => ({ files: await git.changedFiles(worktree, base), diff: (await git.diffAgainst(worktree, base)).diff });
    const planFor = async () => {
      const { files, diff } = await changes();
      return planCritics(files, diff, project.disabledCritics);
    };

    const first = await changes();
    let pending = planCritics(first.files, first.diff, project.disabledCritics);
    if (pending.length === 0) {
      // Tell apart "nothing to check" from "the owner turned the needed critic off", so the log never overstates safety.
      const turnedOff = planCritics(first.files, first.diff).map((p) => p.kind);
      this.brain.addEvent(task.id, "critics_skipped", {
        reason: turnedOff.length ? "The critics this change needs are turned off for this project" : "No UI or security-sensitive files changed",
        turnedOff,
      });
      return { passed: true, feedback: [] };
    }
    this.brain.addEvent(task.id, "critics_planned", { critics: pending.map((p) => ({ critic: p.kind, reason: p.reason, files: p.files.length })) });

    const feedback: string[] = [];
    const ran = new Set<CriticKind>();
    const previous = new Map<CriticKind, CriticFinding[]>();
    let previousVisual: CriticFinding[] | null = null;
    let latestChecks: string | undefined;
    for (let round = 1; ; round++) {
      this.brain.updateTask(task.id, { status: "reviewing" });
      const failing: { critic: CriticPlan; findings: CriticFinding[] }[] = [];
      // One critic at a time, so every model call is counted against the right critic.
      for (const critic of pending) {
        const findings = await this.runCritic(task, project, worktree, base, critic, plan, latestChecks ?? checksReport, previous.get(critic.kind) ?? null, round, running);
        ran.add(critic.kind);
        // Each re-check only hears what it reported itself: the code critic cannot see screenshots, nor the vision model code.
        previous.set(critic.kind, [...findings]);
        if (critic.kind === "ui") {
          const seen = await this.visualCheck(task, project, worktree, plan, previousVisual, round, running);
          previousVisual = seen;
          findings.push(...seen);
        }
        if (findings.length) failing.push({ critic, findings });
      }
      if (failing.length === 0) return { passed: true, feedback, checksReport: latestChecks };

      const report = failing.map((f) => prompts.formatCriticFindings(CRITIC_INFO[f.critic.kind].name, f.findings)).join("\n\n");
      feedback.push(report);
      const names = failing.map((f) => CRITIC_INFO[f.critic.kind].name).join(" and ");
      if (round > MAX_CRITIC_FIXES) {
        return {
          passed: false,
          feedback,
          checksReport: latestChecks,
          message: `The ${names} still found problems after ${MAX_CRITIC_FIXES} fix rounds, so nothing was committed. The changes are in ${worktree.path} for you to inspect.`,
        };
      }

      this.brain.addEvent(task.id, "critic_fix_started", { round, critics: failing.map((f) => f.critic.kind) });
      this.brain.updateTask(task.id, { status: "coding" });
      await coder.prompt(prompts.coderFollowUp(report));
      throwIfAborted(signal);

      this.brain.updateTask(task.id, { status: "checking" });
      let checks = await this.runChecks(task, project, worktree, base, signal);
      await this.shareAgentFiles(task, worktree.path, signal);
      if (!checks.ok) {
        await coder.prompt(prompts.coderFollowUp(`The project checks failed after your fix:\n\n${checks.report}`));
        throwIfAborted(signal);
        checks = await this.runChecks(task, project, worktree, base, signal);
        await this.shareAgentFiles(task, worktree.path, signal);
      }
      latestChecks = checks.report;
      if (!checks.ok) {
        return {
          passed: false,
          feedback,
          checksReport: latestChecks,
          message: `The project checks failed after fixing what the ${names} found, so nothing was committed. The changes are in ${worktree.path} for you to inspect.`,
        };
      }

      const failed = new Set(failing.map((f) => f.critic.kind));
      pending = (await planFor()).filter((p) => failed.has(p.kind) || !ran.has(p.kind));
      if (pending.length === 0) return { passed: true, feedback, checksReport: latestChecks };
    }
  }

  /**
   * The UI critic's look at the running app: start it, capture it on a phone and a desktop, and turn a failed load, page
   * errors, serious accessibility violations and the vision model's verdict into findings. When the app cannot be
   * started the check is skipped with the reason; that never blocks the change on its own.
   */
  private async visualCheck(
    task: Task,
    project: Project,
    worktree: git.Worktree,
    plan: prompts.Plan,
    previous: CriticFinding[] | null,
    round: number,
    running: RunningTask,
  ): Promise<CriticFinding[]> {
    const visual = this.options.visual;
    if (!visual) return [];
    const signal = running.abort.signal;
    // The staged package.json (the checks staged the change), so scripts the task added count.
    const command = appCommand(project, await git.showFile(worktree, "", "package.json"), await freePort());
    if (!command) {
      this.brain.addEvent(task.id, "visual_skipped", { round, reason: "No way to start the app: set a start command and app address in project settings" });
      return [];
    }
    let captured: CaptureResult;
    try {
      captured = await visual.capture({ command, cwd: worktree.path, signal, runner: this.options.checkRunner, log: this.log });
    } catch (error) {
      throwIfAborted(signal);
      captured = { ok: false, reason: `The app check failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    throwIfAborted(signal);
    if (!captured.ok) {
      this.brain.addEvent(task.id, "visual_skipped", { round, reason: captured.reason, command: command.command, url: command.url });
      return [];
    }
    const { capture } = captured;
    const findings = captureFindings(capture, command.url);
    const visionModel = spendingSettings(this.brain).visionModel;
    let summary = "";
    let reviewedBy: string | null = null;
    if (visionModel && capture.shots.length && !capture.loadError) {
      const run = this.brain.startRun(task.id, "critic", "cheaperinference", visionModel, "visual");
      try {
        const reply = await visual.review(visionModel, prompts.visualCritic(task, plan, capture.shots, previous), capture.shots, signal);
        this.recordUsage(run.id, reply.usage);
        this.brain.finishRun(run.id, "succeeded");
        const verdict = prompts.extractJson<CriticVerdict>(reply.text);
        if (verdict) findings.push(...blockingFindings(verdict));
        summary = verdict?.summary ?? "The vision model's reply could not be read, so it did not block the change.";
        reviewedBy = visionModel;
      } catch (error) {
        this.brain.finishRun(run.id, signal.aborted ? "cancelled" : "failed");
        throwIfAborted(signal);
        this.brain.addEvent(task.id, "visual_review_failed", { round, model: visionModel, message: error instanceof Error ? error.message : String(error) });
      }
    }
    const reported = findings.slice(0, 8);
    this.brain.addEvent(task.id, "visual_check", {
      round,
      url: command.url,
      source: command.source,
      passed: reported.length === 0,
      findings: reported,
      loadError: capture.loadError,
      consoleErrors: capture.consoleErrors.slice(0, 5),
      axe: capture.axe.slice(0, 5),
      views: capture.shots.map((s) => `${s.name} ${s.width}x${s.height}`),
      model: reviewedBy,
      summary,
    });
    return reported;
  }

  private async runCritic(
    task: Task,
    project: Project,
    worktree: git.Worktree,
    base: string,
    critic: CriticPlan,
    plan: prompts.Plan,
    checksReport: string,
    previous: CriticFinding[] | null,
    round: number,
    running: RunningTask,
  ): Promise<CriticFinding[]> {
    const diff = prompts.truncate(await git.diffPaths(worktree, base, critic.files), MAX_CRITIC_DIFF_CHARS);
    const prompt = prompts.critic(critic.kind, task, plan, diff, critic.files, checksReport, previous);
    const reply = await this.runOnce(task, project, worktree.path, "critic", "read-only", prompt, running, critic.kind);
    const verdict = prompts.extractJson<CriticVerdict>(reply);
    // An unreadable reply is not evidence of a problem; sending the Coder after it would only burn tokens.
    const findings = verdict ? blockingFindings(verdict) : [];
    this.brain.addEvent(task.id, "critic_verdict", {
      critic: critic.kind,
      round,
      passed: findings.length === 0,
      summary: verdict?.summary ?? "",
      findings,
      files: critic.files.length,
      ...(verdict ? {} : { unreadable: true }),
    });
    return findings;
  }

  /** Called after the user decides a push_and_pr approval in the dashboard. */
  async onApprovalDecided(approval: Approval): Promise<void> {
    if (approval.kind === "plan") return this.manager.onPlanDecided(approval);
    if (approval.kind === "epic_push") return this.manager.onEpicPushDecided(approval);
    if (approval.kind !== "push_and_pr" || !approval.taskId) return;
    const task = this.brain.getTask(approval.taskId);
    if (!task || task.status !== "awaiting_approval") return;
    if (approval.status === "rejected") {
      this.brain.updateTask(task.id, { status: "rejected" });
      this.brain.addEvent(task.id, "approval_rejected", { branch: task.branch });
      await this.cleanupWorktree(task.id);
      return;
    }
    const project = this.brain.getProject(task.projectId);
    if (!project) return;
    const payload = approval.payload as { branch: string; base: string; prTitle: string; prBody: string; repo?: string | null };
    this.brain.updateTask(task.id, { status: "pushing" });
    try {
      await this.bringUpToDate(task, project, payload.branch, payload.base, task.worktreePath);
      // The branch and its commit live in the project's own repository, which agents cannot write.
      await git.pushBranch(project.localPath, payload.branch);
      this.brain.addEvent(task.id, "pushed", { branch: payload.branch });
      const prUrl = await (this.options.openPullRequest ?? git.createPullRequest)(project.localPath, {
        base: payload.base,
        head: payload.branch,
        title: payload.prTitle,
        body: payload.prBody,
        repo: payload.repo ?? project.githubRepo,
      });
      this.brain.updateTask(task.id, { status: "done", prUrl });
      this.brain.addEvent(task.id, "pr_opened", { url: prUrl });
      await this.cleanupWorktree(task.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.brain.updateTask(task.id, { status: "failed", error: message });
      this.brain.addEvent(task.id, "push_failed", { message });
    }
  }

  /**
   * Before a push: when `branch` no longer contains the newest `base` (GitHub's copy included), merges it in. Conflicts go
   * to the Coder, then the checks run; anything left unresolved stops the push with the reason.
   */
  async bringUpToDate(task: Task, project: Project, branch: string, base: string, worktreePath: string | null): Promise<void> {
    const repo = project.localPath;
    const start = await git.freshStartPoint(repo, base);
    const tip = await git.resolveCommit(repo, `refs/heads/${branch}`);
    if (!tip) throw new Error(`The branch ${branch} no longer exists`);
    if (await git.isAncestor(repo, start.sha, tip)) return;

    const running: RunningTask = { taskId: task.id, abort: new AbortController(), sessions: new Set(), merge: true };
    this.running.set(task.id, running);
    const temporary = !worktreePath || !existsSync(worktreePath);
    let worktree: git.Worktree | null = null;
    let coder: AgentSession | null = null;
    const message = `Merge the newest ${base} into ${branch}`;
    try {
      worktree = temporary
        ? await git.checkoutWorktree(repo, join(this.options.worktreesDir, `${worktreeFolder(repo, task.id)}-merge`), branch)
        : await git.openWorktree(repo, worktreePath!);
      if (this.options.agentUser) await prepareWorktree(worktree.path, this.options.agentUser, this.options.agentGroup ?? "aiwork");
      const signal = running.abort.signal;
      const conflicts = await git.mergeInto(worktree, start.sha, message);
      this.brain.addEvent(task.id, "base_merge_started", { base, branch, conflicts, source: start.source });

      if (conflicts.length) {
        coder = await this.openSession(task, project, worktree.path, "coder", "workspace-write", running, "merge");
        await coder.prompt(prompts.resolveConflicts(base, branch, conflicts));
        await this.shareAgentFiles(task, worktree.path, signal);
        let left = await git.conflictMarkers(worktree, conflicts);
        if (left.length) {
          await coder.prompt(prompts.coderFollowUp(`These files still contain conflict markers: ${left.join(", ")}. Resolve them.`));
          await this.shareAgentFiles(task, worktree.path, signal);
          left = await git.conflictMarkers(worktree, conflicts);
        }
        if (left.length) throw new Error(`The merge conflicts in ${left.join(", ")} could not be resolved automatically`);
        await git.commitAll(worktree, message);
      }

      let checks = await this.runChecks(task, project, worktree, start.sha, signal);
      if (!checks.ok) {
        coder ??= await this.openSession(task, project, worktree.path, "coder", "workspace-write", running, "merge");
        await coder.prompt(prompts.coderFollowUp(`After merging the newest ${base}, the project checks fail:\n\n${checks.report}`));
        await this.shareAgentFiles(task, worktree.path, signal);
        checks = await this.runChecks(task, project, worktree, start.sha, signal);
        if (!checks.ok) throw new Error(`The project checks fail after merging the newest ${base} into ${branch}`);
        if (!(await git.isClean(worktree))) await git.commitAll(worktree, `Fix the checks after merging ${base}`);
      }
      this.brain.addEvent(task.id, "base_merged", { base, branch, conflicts, source: start.source });
    } catch (error) {
      // Undo the merge commit as well: otherwise the next push would find the base already merged and skip the checks.
      if (worktree) await git.resetTo(worktree, tip).catch((reset: Error) => this.log(`could not undo the merge on ${branch}: ${reset.message}`));
      throw error;
    } finally {
      await coder?.close();
      this.running.delete(task.id);
      if (temporary && worktree) await git.removeWorktree(repo, worktree).catch(() => {});
    }
  }

  /** Deletes a finished task's worktree folder. The branch and its commits stay in the repository. */
  async cleanupWorktree(taskId: string, reason?: "cleanup"): Promise<void> {
    const task = this.brain.getTask(taskId);
    const project = task && this.brain.getProject(task.projectId);
    if (!task?.worktreePath || !project) return;
    try {
      // Inside the try: a project whose folder is gone must not throw out of cleanup.
      const worktree = await git.openWorktree(project.localPath, task.worktreePath);
      try {
        await git.removeWorktree(project.localPath, worktree);
      } catch (error) {
        // Folders the agent created and locked down: open them up as the agent user, then try again.
        if (!this.options.checkRunner || !existsSync(worktree.path)) throw error;
        await runShellCommand("chmod -R u+rwX,g+rwX .", worktree.path, 120_000, new AbortController().signal, this.options.checkRunner);
        await git.removeWorktree(project.localPath, worktree);
      }
      this.brain.updateTask(task.id, { worktreePath: null });
      this.brain.addEvent(task.id, "worktree_removed", { path: worktree.path, ...(reason ? { reason } : {}) });
    } catch (error) {
      this.log(`could not remove the worktree ${task.worktreePath}: ${(error as Error).message}`);
    }
  }

  /**
   * The free checks before any model looks at a change: the quick checks, then the project's test and lint commands (or,
   * for a project without them, the package.json scripts that passed before the change).
   */
  async runChecks(task: Task, project: Project, worktree: git.Worktree, base: string, signal: AbortSignal): Promise<{ ok: boolean; report: string }> {
    const findings = await this.quickCheck(task, worktree, base, signal);
    const parts = [formatQuickFindings(findings)];
    let ok = findings.length === 0;
    const commands = this.checkCommands(task, project);
    if (commands.length === 0) {
      this.brain.addEvent(task.id, "checks_skipped", { reason: "No test or lint command configured for this project" });
      parts.push("No test or lint command is configured for this project.");
    }
    for (const command of commands) {
      throwIfAborted(signal);
      this.brain.addEvent(task.id, "check_started", { command });
      const result = await runShellCommand(command, worktree.path, CHECK_TIMEOUT_MS, signal, this.options.checkRunner);
      this.brain.addEvent(task.id, "check_finished", { command, ok: result.ok, exitCode: result.exitCode, output: result.output });
      parts.push(`$ ${command}\n(exit code ${result.exitCode})\n${result.output}`);
      ok &&= result.ok;
    }
    return { ok, report: parts.join("\n\n") };
  }

  /** The project's direct npm dependencies against their current stable releases, for the Planner's and Coder's prompts. */
  private async checkVersions(task: Task, worktree: git.Worktree, base: string, signal: AbortSignal): Promise<string> {
    const lookup = this.options.packages;
    const deps = lookup ? directDependencies(await git.showFile(worktree, base, "package.json")) : null;
    if (!lookup || !deps?.length) return "";
    const checked = deps.slice(0, MAX_VERSION_PACKAGES);
    const locked = lockedVersions(await git.showFile(worktree, base, "package-lock.json"));
    const { infos, failed } = await lookupPackages(lookup, checked.map((d) => d.name));
    throwIfAborted(signal);
    const rows = versionRows(checked, locked, infos);
    this.brain.addEvent(task.id, "versions_checked", { packages: rows, failed: failed.length, total: deps.length });
    return versionsBlock(rows, failed);
  }

  /** Dependencies the change adds or re-ranges in any package.json, checked on the registry; a registry outage skips it. */
  private async dependencyCheck(task: Task, worktree: git.Worktree, base: string, files: Awaited<ReturnType<typeof git.stagedChanges>>): Promise<QuickFinding[]> {
    const lookup = this.options.packages;
    const manifests = files
      .filter((f) => f.status !== "D" && f.blob && /(^|\/)package\.json$/.test(f.path) && !/(^|\/)node_modules\//.test(f.path))
      .slice(0, MAX_MANIFESTS);
    if (!lookup || manifests.length === 0) return [];
    // Staged content when the change touches the file, the base otherwise (an untouched file is the same in both).
    const staged = async (path: string): Promise<string | null> => {
      const file = files.find((f) => f.path === path);
      if (!file) return git.showFile(worktree, base, path);
      return file.status !== "D" && file.blob ? git.readBlob(worktree, file.blob) : null;
    };
    const changes: DependencyChange[] = [];
    for (const manifest of manifests) {
      const dir = manifest.path.slice(0, manifest.path.lastIndexOf("/") + 1);
      const nearLock = await staged(`${dir}package-lock.json`);
      const lock = nearLock ?? (dir ? await staged("package-lock.json") : null);
      const prefixes = nearLock !== null ? ["node_modules/"] : [`${dir}node_modules/`, "node_modules/"];
      changes.push(...dependencyChanges(manifest.path, await git.showFile(worktree, base, manifest.path), await git.readBlob(worktree, manifest.blob!), lock, prefixes));
    }
    if (changes.length === 0) return [];
    const { infos, failed } = await lookupPackages(lookup, changes.map((c) => c.name));
    if (failed.length) this.log(`dependency check: the npm registry had no answer for ${failed.join(", ")}`);
    const advisories = await advisoriesInTime(lookup, advisoryQuery(changes)).catch((error: Error) => {
      this.log(`dependency check: security advisories skipped: ${error.message}`);
      return {};
    });
    return dependencyFindings(changes, infos, advisories, task.prompt, new Date());
  }

  /** Secrets, broken JSON/YAML/JavaScript, debug leftovers, unwanted files and risky dependencies in the change against `base`. */
  private async quickCheck(task: Task, worktree: git.Worktree, base: string, signal: AbortSignal, options: { dependencies?: boolean } = {}): Promise<QuickFinding[]> {
    throwIfAborted(signal);
    // Staging reads every file, and the agent's editor may have left a new one readable only by the agent user.
    await this.shareAgentFiles(task, worktree.path, signal);
    const files = await git.stagedChanges(worktree, base);
    // A huge change (an added node_modules) is already a finding; its diff would not even fit in memory.
    const bytes = files.reduce((sum, f) => sum + f.size, 0);
    const diff = files.length && bytes < MAX_QUICK_DIFF_BYTES ? (await git.diffAgainst(worktree, base)).diff : "";
    const existingFolders = new Set<string>();
    for (const folder of generatedCandidates(files)) if (await git.pathExists(worktree, base, folder)) existingFolders.add(folder);
    const contents = new Map<string, string>();
    for (const file of structuredFiles(files)) contents.set(file.path, await git.readBlob(worktree, file.blob!));
    const findings = quickFindings({ diff, files, existingFolders, contents });
    // `node --check` only parses the file; it still runs as the agent user, because the agent wrote the file.
    for (const file of scriptFiles(files)) {
      throwIfAborted(signal);
      const result = await runShellCommand(`node --check "${file.path}"`, worktree.path, 60_000, signal, this.options.checkRunner);
      const problem = scriptProblem(file.path, result.ok, result.output);
      if (problem) findings.push(problem);
    }
    if (options.dependencies !== false) findings.push(...(await this.dependencyCheck(task, worktree, base, files)));
    throwIfAborted(signal);
    this.brain.addEvent(task.id, "quick_checks", { ok: findings.length === 0, total: findings.length, findings: findings.slice(0, 30), files: files.length });
    return findings;
  }

  /** The project's own commands, or the ones detectChecks kept for this task. */
  private checkCommands(task: Task, project: Project): string[] {
    const configured = [project.testCmd, project.lintCmd].filter((c): c is string => Boolean(c?.trim()));
    if (configured.length) return configured;
    const detected = this.brain.listEvents(task.id).filter((e) => e.type === "checks_detected").at(-1);
    return Array.isArray(detected?.payload.commands) ? (detected.payload.commands as DetectedCheck[]).map((c) => c.command) : [];
  }

  /**
   * For a project without test or lint commands: its package.json typecheck, lint and test scripts. Each runs once before
   * the change, and only those that pass then are enforced, so the Coder never chases failures it did not cause.
   */
  private async detectChecks(task: Task, project: Project, worktree: git.Worktree, base: string, signal: AbortSignal): Promise<void> {
    const lockfile = (await git.pathExists(worktree, base, "package-lock.json")) || (await git.pathExists(worktree, base, "npm-shrinkwrap.json"));
    const found = detectPackageChecks(await git.showFile(worktree, base, "package.json"), { lockfile });
    const record = (commands: DetectedCheck[], dropped: (DetectedCheck & { exitCode: number | null })[], reason: string) => {
      this.brain.addEvent(task.id, "checks_detected", { commands, dropped, reason });
    };
    if (!found) return record([], [], "There is no package.json to take checks from");
    if (found.commands.length === 0) return record([], [], "package.json has no typecheck, lint or test script");
    const notRun = found.commands.map((c) => ({ ...c, exitCode: null }));

    if (found.install && !project.setupCmd?.trim()) {
      // Installed packages must stay out of the change, so only install where git ignores them.
      if (!(await git.isIgnored(worktree, "node_modules/.package-lock.json"))) {
        return record([], notRun, "node_modules is not in .gitignore, so the dependencies were not installed and the scripts were not run");
      }
      this.brain.addEvent(task.id, "setup_started", { command: found.install, detected: true });
      const result = await runShellCommand(found.install, worktree.path, SETUP_TIMEOUT_MS, signal, this.options.checkRunner);
      this.brain.addEvent(task.id, "setup_finished", { command: found.install, ok: result.ok, exitCode: result.exitCode, output: result.output, detected: true });
      throwIfAborted(signal);
      await this.shareAgentFiles(task, worktree.path, signal);
      if (!result.ok) return record([], notRun, "Installing the dependencies failed, so the scripts were not run. Set a setup command in project settings.");
    }

    const kept: DetectedCheck[] = [];
    const dropped: (DetectedCheck & { exitCode: number | null })[] = [];
    for (const check of found.commands) {
      throwIfAborted(signal);
      const result = await runShellCommand(check.command, worktree.path, CHECK_TIMEOUT_MS, signal, this.options.checkRunner);
      if (result.ok) kept.push(check);
      else dropped.push({ ...check, exitCode: result.exitCode });
    }
    await this.shareAgentFiles(task, worktree.path, signal);
    record(kept, dropped, dropped.length ? "Scripts that already fail before the change are not enforced" : "");
  }

  /**
   * With a separate agent user, files it creates or replaces (editors write a temp file and rename it) keep
   * the agent's own group. Hand them to the shared group so the server user's git can update them later.
   */
  async shareAgentFiles(task: Task, cwd: string, signal: AbortSignal): Promise<void> {
    if (!this.options.checkRunner) return;
    const group = this.options.agentGroup ?? "aiwork";
    const command = [
      `find . \\( -type f -o -type d \\) -user "$(id -un)" -exec chgrp ${group} {} + -exec chmod g+rwX {} +`,
      `find . -type d -user "$(id -un)" -exec chmod g+s {} +`,
    ].join(" && ");
    const result = await runShellCommand(command, cwd, 60_000, signal, this.options.checkRunner);
    if (!result.ok) this.brain.addEvent(task.id, "permissions_fix_failed", { output: result.output });
  }

  /**
   * Reads the `.ai/` notes of a worktree. With an agent user they are read as that user, so a symlink planted in the
   * worktree cannot pull the server's own files into a prompt or a commit.
   */
  async readAiFiles(cwd: string, signal: AbortSignal): Promise<AiFiles> {
    const files: AiFiles = {};
    if (!this.options.checkRunner) {
      for (const name of AI_FILES) {
        const path = join(cwd, AI_DIR, name);
        if (existsSync(path)) files[name] = readFileSync(path, "utf8");
      }
      return files;
    }
    const script = AI_FILES.map((name) => `if [ -f '${AI_DIR}/${name}' ]; then printf '%s\\n' '${name}'; base64 -w0 '${AI_DIR}/${name}'; printf '\\n'; fi`).join("; ");
    const result = await runCapture(script, cwd, 60_000, signal, this.options.checkRunner);
    if (!result.ok) throw new Error(`Could not read the handoff notes: ${result.stderr.trim()}`);
    const lines = result.stdout.split("\n");
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const name = lines[i] as (typeof AI_FILES)[number];
      if (AI_FILES.includes(name)) files[name] = Buffer.from(lines[i + 1] ?? "", "base64").toString("utf8");
    }
    return files;
  }

  private async writeAiFiles(cwd: string, ops: FileOp[], signal: AbortSignal): Promise<void> {
    if (!this.options.checkRunner) {
      for (const op of ops) {
        const path = join(cwd, op.path);
        mkdirSync(dirname(path), { recursive: true });
        if (op.mode === "write") writeFileSync(path, op.content);
        else appendFileSync(path, `${existsSync(path) ? "" : (op.header ?? "")}${op.content}`);
      }
      return;
    }
    for (const op of ops) {
      const result = await runShellCommand(fileOpCommands(op).join(" && "), cwd, 60_000, signal, this.options.checkRunner);
      if (!result.ok) throw new Error(`Could not write ${op.path}: ${result.output.trim()}`);
    }
  }

  private async updateHandoff(
    task: Task,
    project: Project,
    cwd: string,
    branch: string,
    plan: prompts.Plan,
    stat: string,
    reviewSummary: string,
    checksReport: string,
    running: RunningTask,
  ): Promise<void> {
    const signal = running.abort.signal;
    try {
      const now = new Date();
      const current = await this.readAiFiles(cwd, signal);
      const prompt = prompts.handoff(project, task, branch, plan, stat, reviewSummary, checksReport, current, dayStamp(now));
      const reply = await this.runOnce(task, project, cwd, "memory", "read-only", prompt, running, "handoff");
      const { ops, skipped } = planHandoffWrite(current, parseHandoffReply(reply), now);
      // A project added before handoff notes existed gets the rest of the template in the same commit.
      const template = templateFiles(project.name, project.defaultBranch, now);
      for (const name of AI_FILES) {
        const path = `${AI_DIR}/${name}`;
        if (current[name] === undefined && !ops.some((op) => op.path === path)) ops.push({ path, mode: "write", content: template[name] });
      }
      await this.writeAiFiles(cwd, ops, signal);
      this.brain.addEvent(task.id, "handoff_updated", { files: [...new Set(ops.map((op) => op.path))], skipped });
    } catch (error) {
      if (error instanceof CancelledError || signal.aborted) throw error;
      this.brain.addEvent(task.id, "handoff_failed", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  private async learn(task: Task, project: Project, cwd: string, plan: prompts.Plan, feedbackLog: string[], running: RunningTask): Promise<void> {
    try {
      const existing = this.brain.listMemories({ visibleTo: project.id }, 60);
      const reply = await this.runOnce(task, project, cwd, "memory", "read-only", prompts.memoryWriter(project, task, plan, feedbackLog, existing), running);
      const proposal = prompts.extractJson<{ memories?: prompts.ProposedMemory[] }>(reply);
      const saved: { scope: string; content: string }[] = [];
      let duplicates = 0;
      for (const m of (proposal?.memories ?? []).slice(0, 5)) {
        const content = m.content?.trim();
        if (!content || (m.scope !== "project" && m.scope !== "global")) continue;
        const kind = MEMORY_KINDS.includes(m.kind as MemoryKind) ? (m.kind as MemoryKind) : "lesson";
        const result = this.brain.rememberMemory({ scope: m.scope, projectId: project.id, kind, content, tags: (m.tags ?? []).slice(0, 8), sourceTaskId: task.id });
        if (result.duplicate) duplicates++;
        else saved.push({ scope: m.scope, content });
      }
      this.brain.addEvent(task.id, "memories_saved", { items: saved, duplicates });
    } catch (error) {
      if (error instanceof CancelledError || running.abort.signal.aborted) throw error;
      this.brain.addEvent(task.id, "memory_failed", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  async runOnce(
    task: Task,
    project: Project,
    cwd: string,
    role: Role,
    mode: PermissionMode,
    prompt: string,
    running: RunningTask,
    purpose?: string,
  ): Promise<string> {
    // A one-shot agent only reads, so a failed turn (a model or provider error) can safely start over once in a fresh
    // session instead of throwing away the whole task.
    for (let attempt = 1; ; attempt++) {
      const session = await this.openSession(task, project, cwd, role, mode, running, purpose);
      try {
        return await session.prompt(prompt);
      } catch (error) {
        if (attempt >= 2 || error instanceof CancelledError || running.abort.signal.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        this.brain.addEvent(task.id, "agent_retry", { role, purpose: purpose ?? null, message });
        this.log(`task ${task.id.slice(0, 8)}: the ${purpose ?? role} run failed (${message}), trying once more`);
      } finally {
        await session.close();
      }
    }
  }

  async openSession(
    task: Task,
    project: Project,
    cwd: string,
    role: Role,
    mode: PermissionMode,
    running: RunningTask,
    purpose?: string,
    /** Another model than the role's setting, for the stronger-model try. */
    modelOverride?: string,
  ): Promise<AgentSession> {
    const signal = running.abort.signal;
    throwIfAborted(signal);
    const setting = this.brain.getRoleSetting(role);
    const model = modelOverride ?? setting.model;
    const run = this.brain.startRun(task.id, role, setting.provider, model, purpose ?? null);
    this.brain.addEvent(task.id, "agent_started", { role, model: `${setting.provider}/${model}`, ...(purpose ? { purpose } : {}) }, run.id);
    const recorder = new UpdateRecorder(this.brain, task.id, run.id, role);
    const token = this.tokens.issue(project.id, task.id);

    let agent: AgentHandle;
    let sessionId: string;
    try {
      agent = await this.pool.get(mode);
      const opened = await agent.newSession(
        cwd,
        [{ type: "http", name: "brain", url: this.options.mcpUrl, headers: [{ name: "Authorization", value: `Bearer ${token}` }] }],
        {
          onUpdate: (update) => recorder.push(update),
          onPermission: (request) => this.onPermission(task, role, mode, cwd, request),
        },
      );
      sessionId = opened.sessionId;
      await agent.selectModel(opened, setting.provider, model, setting.reasoningEffort);
    } catch (error) {
      this.tokens.revoke(token);
      this.brain.finishRun(run.id, "failed");
      throw error;
    }
    this.brain.setRunSession(run.id, sessionId);
    const handle = { agent, sessionId };
    running.sessions.add(handle);

    let failed = false;
    return {
      prompt: async (text) => {
        throwIfAborted(signal);
        const active: PromptingRun = { runId: run.id, taskId: task.id, cwd };
        this.prompting.set(run.id, active);
        try {
          const result = await agent.prompt(sessionId, text);
          if (result.stopReason === "cancelled") throw new CancelledError();
          if (result.stopReason === "refusal") throw new Error(`The ${role} model refused the request`);
          return result.text;
        } catch (error) {
          failed = true;
          throw signal.aborted ? new CancelledError() : error;
        } finally {
          this.prompting.delete(run.id);
          this.lastPrompt = { ...active, at: Date.now() };
          recorder.flush();
        }
      },
      close: async () => {
        running.sessions.delete(handle);
        this.tokens.revoke(token);
        await agent.closeSession(sessionId).catch(() => {});
        const status = signal.aborted ? "cancelled" : failed ? "failed" : "succeeded";
        this.brain.finishRun(run.id, status);
        this.brain.addEvent(task.id, "agent_finished", { role, status }, run.id);
      },
    };
  }

  private async onPermission(task: Task, role: Role, mode: PermissionMode, cwd: string, request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const decision = decidePermission(request, { cwd, writable: mode === "workspace-write" });
    if (decision === "reject") this.brain.addEvent(task.id, "permission_denied", { role, title: request.toolCall.title ?? "wider sandbox access" });
    return permissionResponse(request, decision === "allow");
  }
}
