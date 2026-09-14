export type Scope = "global" | "project";
export type Role = "planner" | "coder" | "reviewer" | "critic" | "git" | "memory";
export type MemoryKind = "preference" | "convention" | "fact" | "lesson" | "note";
/** Specialist critics that judge a change before it is committed. */
export type CriticKind = "ui" | "security";
export type TaskStatus =
  | "queued"
  | "planning"
  | "coding"
  | "checking"
  | "reviewing"
  | "awaiting_approval"
  | "pushing"
  | "done"
  | "rejected"
  | "needs_human"
  | "failed"
  | "cancelled";
export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";
/** "code" tasks change the repository; the others are the project manager planning a goal or an epic. */
export type TaskKind = "code" | "goal_plan" | "epic_plan";
export type GoalStatus = "planning" | "awaiting_approval" | "running" | "paused" | "done" | "cancelled" | "failed";
export type EpicStatus = "pending" | "planning" | "running" | "awaiting_approval" | "pushing" | "done" | "paused" | "cancelled";
export type ApprovalKind = "push_and_pr" | "permission" | "plan" | "epic_push";
export type ApprovalStatus = "pending" | "approved" | "rejected";

export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ["planning", "coding", "checking", "reviewing", "pushing"];

export interface Project {
  id: string;
  name: string;
  localPath: string;
  githubRepo: string | null;
  defaultBranch: string;
  /** Runs once in each task's fresh worktree before the Coder starts, e.g. `npm ci`. */
  setupCmd: string | null;
  testCmd: string | null;
  lintCmd: string | null;
  /** Stop a task once its model calls cost this many US dollars; null means no limit. */
  taskBudgetUsd: number | null;
  /** Starts the app for the visual check, e.g. `npm run dev -- --port {port}`; null guesses from package.json. */
  startCmd: string | null;
  /** Where the started app answers, e.g. `http://127.0.0.1:{port}/`. */
  appUrl: string | null;
  /** Critics switched off for this project; every other critic runs when a change needs it. */
  disabledCritics: CriticKind[];
  createdAt: string;
}

export interface Session {
  id: string;
  projectId: string;
  title: string;
  status: "active" | "archived";
  createdAt: string;
}

export interface Task {
  id: string;
  sessionId: string;
  projectId: string;
  prompt: string;
  kind: TaskKind;
  /** Set for tasks that belong to a project manager goal; code tasks of an epic also carry the epic and their place in it. */
  goalId: string | null;
  epicId: string | null;
  epicPosition: number | null;
  status: TaskStatus;
  plan: unknown;
  branch: string | null;
  baseBranch: string | null;
  /** The task's own git worktree; the project's checkout itself is never edited by agents. */
  worktreePath: string | null;
  commitSha: string | null;
  prUrl: string | null;
  reviewRounds: number;
  error: string | null;
  claimedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Tokens and cost of model calls, summed over one agent run or a whole task. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export interface AgentRun extends Usage {
  id: string;
  taskId: string;
  role: Role;
  /** What a run of a shared role was for, e.g. "handoff" for the memory model or "ui" for a critic. */
  purpose: string | null;
  provider: string | null;
  model: string | null;
  dshSessionId: string | null;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
}

export interface BrainEvent {
  id: number;
  taskId: string;
  runId: string | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** One large goal (for example "build an online shop") that the project manager splits into epics. */
export interface Goal {
  id: string;
  projectId: string;
  sessionId: string;
  prompt: string;
  status: GoalStatus;
  summary: string | null;
  /** Pause the goal once all its tasks together cost this many US dollars; null means no limit. */
  budgetUsd: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A small task the project manager planned for an epic; a code task is created for it when its turn comes. */
export interface PlannedTask {
  title: string;
  description: string;
  acceptance: string[];
  files: string[];
}

/** A slice of a goal worked on one small task at a time on its own branch, pushed as one pull request. */
export interface Epic {
  id: string;
  goalId: string;
  position: number;
  title: string;
  description: string;
  status: EpicStatus;
  branch: string | null;
  baseBranch: string | null;
  plannedTasks: PlannedTask[];
  prUrl: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Approval {
  id: string;
  /** What the decision is about: a task (push, permission), a goal (its plan) or an epic (its push). */
  taskId: string | null;
  goalId: string | null;
  epicId: string | null;
  kind: ApprovalKind;
  summary: string;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt: string | null;
}

export interface Memory {
  id: string;
  scope: Scope;
  projectId: string | null;
  kind: MemoryKind;
  content: string;
  tags: string[];
  sourceTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoleSetting {
  role: Role;
  provider: string;
  model: string;
  reasoningEffort: string | null;
}

/** How the server talks to a provider: any OpenAI-compatible API, Anthropic's Messages API, or Gemini's OpenAI endpoint. */
export type ProviderType = "openai" | "anthropic" | "gemini";

/** A model provider set up on the Models page. The key itself never leaves the server. */
export interface Provider {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  hasKey: boolean;
  /** The key's last four characters, to tell keys apart; null without a key or for very short keys. */
  keyLast4: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A price the owner entered for a model, in US dollars per million tokens. */
export interface ModelPrice {
  providerId: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number | null;
  updatedAt: string;
}

/** How one critic has done in a project, so critics that do not pay for themselves can be switched off. */
export interface CriticStats {
  critic: string;
  /** Times it judged a change, re-checks included. */
  checks: number;
  /** Problems it raised on first look. */
  findings: number;
  /** Problems that were gone when it looked again. */
  fixed: number;
  tokens: number;
  costUsd: number;
}

export type BrainChange =
  | { kind: "project"; id: string }
  | { kind: "session"; id: string; projectId: string }
  | { kind: "task"; id: string; projectId: string; sessionId: string }
  | { kind: "event"; id: number; taskId: string }
  | { kind: "run"; id: string; taskId: string }
  | { kind: "approval"; id: string; taskId: string | null; goalId: string | null }
  | { kind: "goal"; id: string; projectId: string; sessionId: string }
  | { kind: "epic"; id: string; goalId: string }
  | { kind: "memory"; id: string; projectId: string | null }
  | { kind: "settings"; role?: Role; key?: string };
