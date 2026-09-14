import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { migrate } from "./schema.ts";
import {
  ACTIVE_TASK_STATUSES,
  type AgentRun,
  type Approval,
  type ApprovalKind,
  type BrainChange,
  type BrainEvent,
  type CriticKind,
  type CriticStats,
  type Epic,
  type Goal,
  type PlannedTask,
  type TaskKind,
  type Memory,
  type MemoryKind,
  type ModelPrice,
  type Project,
  type Provider,
  type ProviderType,
  type Role,
  type RoleSetting,
  type RunStatus,
  type Scope,
  type Session,
  type Task,
  type TaskStatus,
  type Usage,
} from "./types.ts";

type Row = Record<string, SQLInputValue>;

const now = () => new Date().toISOString();
const str = (v: SQLInputValue | undefined) => (v === null || v === undefined ? null : String(v));
const num = (v: SQLInputValue | undefined) => (v === null || v === undefined ? null : Number(v));
const parseJson = <T>(v: SQLInputValue | undefined, fallback: T): T => (typeof v === "string" ? (JSON.parse(v) as T) : fallback);

const toProject = (r: Row): Project => ({
  id: String(r.id),
  name: String(r.name),
  localPath: String(r.local_path),
  githubRepo: str(r.github_repo),
  defaultBranch: String(r.default_branch),
  setupCmd: str(r.setup_cmd),
  testCmd: str(r.test_cmd),
  lintCmd: str(r.lint_cmd),
  taskBudgetUsd: num(r.task_budget_usd),
  startCmd: str(r.start_cmd),
  appUrl: str(r.app_url),
  disabledCritics: parseJson<CriticKind[]>(r.disabled_critics, []),
  createdAt: String(r.created_at),
});

const toSession = (r: Row): Session => ({
  id: String(r.id),
  projectId: String(r.project_id),
  title: String(r.title),
  status: r.status as Session["status"],
  createdAt: String(r.created_at),
});

const toTask = (r: Row): Task => ({
  id: String(r.id),
  sessionId: String(r.session_id),
  projectId: String(r.project_id),
  prompt: String(r.prompt),
  kind: (str(r.kind) ?? "code") as TaskKind,
  goalId: str(r.goal_id),
  epicId: str(r.epic_id),
  epicPosition: num(r.epic_position),
  status: r.status as TaskStatus,
  plan: parseJson<unknown>(r.plan, null),
  branch: str(r.branch),
  baseBranch: str(r.base_branch),
  worktreePath: str(r.worktree_path),
  commitSha: str(r.commit_sha),
  prUrl: str(r.pr_url),
  reviewRounds: Number(r.review_rounds),
  error: str(r.error),
  claimedBy: str(r.claimed_by),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

const toRun = (r: Row): AgentRun => ({
  id: String(r.id),
  taskId: String(r.task_id),
  role: r.role as Role,
  purpose: str(r.purpose),
  provider: str(r.provider),
  model: str(r.model),
  dshSessionId: str(r.dsh_session_id),
  status: r.status as RunStatus,
  startedAt: String(r.started_at),
  endedAt: str(r.ended_at),
  inputTokens: Number(r.input_tokens ?? 0),
  outputTokens: Number(r.output_tokens ?? 0),
  cacheReadTokens: Number(r.cache_read_tokens ?? 0),
  costUsd: Number(r.cost_usd ?? 0),
});

const toEvent = (r: Row): BrainEvent => ({
  id: Number(r.id),
  taskId: String(r.task_id),
  runId: str(r.run_id),
  type: String(r.type),
  payload: parseJson<Record<string, unknown>>(r.payload, {}),
  createdAt: String(r.created_at),
});

const toGoal = (r: Row): Goal => ({
  id: String(r.id),
  projectId: String(r.project_id),
  sessionId: String(r.session_id),
  prompt: String(r.prompt),
  status: r.status as Goal["status"],
  summary: str(r.summary),
  budgetUsd: num(r.budget_usd),
  error: str(r.error),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

const toEpic = (r: Row): Epic => ({
  id: String(r.id),
  goalId: String(r.goal_id),
  position: Number(r.position),
  title: String(r.title),
  description: String(r.description),
  status: r.status as Epic["status"],
  branch: str(r.branch),
  baseBranch: str(r.base_branch),
  plannedTasks: parseJson<PlannedTask[]>(r.planned_tasks, []),
  prUrl: str(r.pr_url),
  error: str(r.error),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

const toApproval = (r: Row): Approval => ({
  id: String(r.id),
  taskId: str(r.task_id),
  goalId: str(r.goal_id),
  epicId: str(r.epic_id),
  kind: r.kind as ApprovalKind,
  summary: String(r.summary),
  payload: parseJson<Record<string, unknown>>(r.payload, {}),
  status: r.status as Approval["status"],
  createdAt: String(r.created_at),
  decidedAt: str(r.decided_at),
});

const toMemory = (r: Row): Memory => ({
  id: String(r.id),
  scope: r.scope as Scope,
  projectId: str(r.project_id),
  kind: r.kind as MemoryKind,
  content: String(r.content),
  tags: parseJson<string[]>(r.tags, []),
  sourceTaskId: str(r.source_task_id),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

const toRoleSetting = (r: Row): RoleSetting => ({
  role: r.role as Role,
  provider: String(r.provider),
  model: String(r.model),
  reasoningEffort: str(r.reasoning_effort),
});

const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);

/** Share of distinct words two memory texts have in common (Jaccard index), from 0 to 1. */
export function memorySimilarity(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / (left.size + right.size - shared);
}

/** Memories at least this similar count as the same fact. */
const DUPLICATE_SIMILARITY = 0.8;

export interface NewProject {
  name: string;
  localPath: string;
  githubRepo?: string | null;
  defaultBranch?: string;
  setupCmd?: string | null;
  testCmd?: string | null;
  lintCmd?: string | null;
  taskBudgetUsd?: number | null;
  disabledCritics?: CriticKind[];
  startCmd?: string | null;
  appUrl?: string | null;
}

export interface NewTaskOptions {
  kind?: TaskKind;
  goalId?: string | null;
  epicId?: string | null;
  epicPosition?: number | null;
}

export type GoalPatch = Partial<Pick<Goal, "status" | "summary" | "error" | "budgetUsd">>;
export type EpicPatch = Partial<Pick<Epic, "status" | "branch" | "baseBranch" | "plannedTasks" | "prUrl" | "error">>;

const GOAL_COLUMNS: Record<keyof GoalPatch, string> = { status: "status", summary: "summary", error: "error", budgetUsd: "budget_usd" };
const EPIC_COLUMNS: Record<keyof EpicPatch, string> = {
  status: "status",
  branch: "branch",
  baseBranch: "base_branch",
  plannedTasks: "planned_tasks",
  prUrl: "pr_url",
  error: "error",
};

/** Builds "col = ?" pairs for the keys present in a patch; JSON-encodes arrays. */
function setClause<P extends object>(patch: P, columns: Record<keyof P, string>): { sets: string[]; params: SQLInputValue[] } {
  const sets: string[] = [];
  const params: SQLInputValue[] = [];
  for (const [key, column] of Object.entries(columns) as [keyof P, string][]) {
    if (!(key in patch)) continue;
    const value = patch[key];
    sets.push(`${column} = ?`);
    params.push(Array.isArray(value) ? JSON.stringify(value) : ((value ?? null) as SQLInputValue));
  }
  return { sets, params };
}

export interface ApprovalTarget {
  taskId?: string | null;
  goalId?: string | null;
  epicId?: string | null;
}

export interface NewMemory {
  scope: Scope;
  projectId?: string | null;
  kind?: MemoryKind;
  content: string;
  tags?: string[];
  sourceTaskId?: string | null;
}

export type TaskPatch = Partial<
  Pick<Task, "status" | "plan" | "branch" | "baseBranch" | "worktreePath" | "commitSha" | "prUrl" | "reviewRounds" | "error">
>;

const TASK_COLUMNS: Record<keyof TaskPatch, string> = {
  status: "status",
  plan: "plan",
  branch: "branch",
  baseBranch: "base_branch",
  worktreePath: "worktree_path",
  commitSha: "commit_sha",
  prUrl: "pr_url",
  reviewRounds: "review_rounds",
  error: "error",
};

/** The shared brain: one SQLite file holding projects, sessions, tasks, events, approvals and memory. */
export class Brain extends EventEmitter<{ change: [BrainChange] }> {
  readonly db: DatabaseSync;

  constructor(path: string) {
    super();
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;");
    migrate(this.db);
  }

  close(): void {
    this.db.close();
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  private one(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  private run(sql: string, ...params: SQLInputValue[]): void {
    this.db.prepare(sql).run(...params);
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("begin immediate");
    try {
      const result = fn();
      this.db.exec("commit");
      return result;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  // ---- projects -------------------------------------------------------------

  createProject(input: NewProject): Project {
    const id = randomUUID();
    this.run(
      `insert into projects (id, name, local_path, github_repo, default_branch, setup_cmd, test_cmd, lint_cmd, task_budget_usd, disabled_critics,
       start_cmd, app_url)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      input.localPath,
      input.githubRepo ?? null,
      input.defaultBranch ?? "main",
      input.setupCmd ?? null,
      input.testCmd ?? null,
      input.lintCmd ?? null,
      input.taskBudgetUsd ?? null,
      JSON.stringify(input.disabledCritics ?? []),
      input.startCmd ?? null,
      input.appUrl ?? null,
    );
    this.emit("change", { kind: "project", id });
    return this.getProject(id)!;
  }

  updateProject(id: string, patch: Partial<NewProject>): Project {
    const current = this.getProject(id);
    if (!current) throw new Error(`Project ${id} not found`);
    const next = { ...current, ...patch };
    this.run(
      `update projects set name = ?, local_path = ?, github_repo = ?, default_branch = ?, setup_cmd = ?, test_cmd = ?, lint_cmd = ?,
       task_budget_usd = ?, disabled_critics = ?, start_cmd = ?, app_url = ? where id = ?`,
      next.name,
      next.localPath,
      next.githubRepo ?? null,
      next.defaultBranch ?? "main",
      next.setupCmd ?? null,
      next.testCmd ?? null,
      next.lintCmd ?? null,
      next.taskBudgetUsd ?? null,
      JSON.stringify(next.disabledCritics ?? []),
      next.startCmd ?? null,
      next.appUrl ?? null,
      id,
    );
    this.emit("change", { kind: "project", id });
    return this.getProject(id)!;
  }

  deleteProject(id: string): void {
    this.run("delete from projects where id = ?", id);
    this.emit("change", { kind: "project", id });
  }

  getProject(id: string): Project | null {
    const row = this.one("select * from projects where id = ?", id);
    return row ? toProject(row) : null;
  }

  listProjects(): Project[] {
    return this.all("select * from projects order by name collate nocase").map(toProject);
  }

  // ---- sessions -------------------------------------------------------------

  createSession(projectId: string, title: string): Session {
    const id = randomUUID();
    this.run("insert into sessions (id, project_id, title) values (?, ?, ?)", id, projectId, title);
    this.emit("change", { kind: "session", id, projectId });
    return this.getSession(id)!;
  }

  getSession(id: string): Session | null {
    const row = this.one("select * from sessions where id = ?", id);
    return row ? toSession(row) : null;
  }

  listSessions(projectId: string): Session[] {
    return this.all("select * from sessions where project_id = ? order by created_at desc", projectId).map(toSession);
  }

  // ---- tasks ----------------------------------------------------------------

  createTask(sessionId: string, prompt: string, options: NewTaskOptions = {}): Task {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    const id = randomUUID();
    this.run(
      "insert into tasks (id, session_id, project_id, prompt, kind, goal_id, epic_id, epic_position) values (?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      sessionId,
      session.projectId,
      prompt,
      options.kind ?? "code",
      options.goalId ?? null,
      options.epicId ?? null,
      options.epicPosition ?? null,
    );
    const task = this.getTask(id)!;
    this.emit("change", { kind: "task", id, projectId: task.projectId, sessionId });
    return task;
  }

  getTask(id: string): Task | null {
    const row = this.one("select * from tasks where id = ?", id);
    return row ? toTask(row) : null;
  }

  listTasks(sessionId: string): Task[] {
    return this.all("select * from tasks where session_id = ? order by created_at, rowid", sessionId).map(toTask);
  }

  /** Atomically takes the oldest queued task, or returns null when the queue is empty. */
  claimNextTask(workerId: string): Task | null {
    const task = this.transaction(() => {
      const row = this.one("select id from tasks where status = 'queued' order by created_at, rowid limit 1");
      if (!row) return null;
      this.run(
        "update tasks set status = 'planning', claimed_by = ?, updated_at = ? where id = ? and status = 'queued'",
        workerId,
        now(),
        String(row.id),
      );
      return this.getTask(String(row.id));
    });
    if (task) this.emit("change", { kind: "task", id: task.id, projectId: task.projectId, sessionId: task.sessionId });
    return task;
  }

  updateTask(id: string, patch: TaskPatch): Task {
    const sets: string[] = [];
    const params: SQLInputValue[] = [];
    for (const [key, column] of Object.entries(TASK_COLUMNS) as [keyof TaskPatch, string][]) {
      if (!(key in patch)) continue;
      const value = patch[key];
      sets.push(`${column} = ?`);
      if (key === "plan") params.push(value === null || value === undefined ? null : JSON.stringify(value));
      else params.push((value ?? null) as SQLInputValue);
    }
    sets.push("updated_at = ?");
    params.push(now(), id);
    this.run(`update tasks set ${sets.join(", ")} where id = ?`, ...params);
    const task = this.getTask(id);
    if (!task) throw new Error(`Task ${id} not found`);
    this.emit("change", { kind: "task", id, projectId: task.projectId, sessionId: task.sessionId });
    return task;
  }

  /** Marks tasks that were mid-pipeline when the server stopped as failed. Returns their ids. */
  failInterruptedTasks(): string[] {
    const placeholders = ACTIVE_TASK_STATUSES.map(() => "?").join(", ");
    const ids = this.all(`select id from tasks where status in (${placeholders})`, ...ACTIVE_TASK_STATUSES).map((row) => String(row.id));
    for (const id of ids) this.updateTask(id, { status: "failed", error: "Interrupted: server restarted" });
    return ids;
  }

  /** Tasks that still have a work folder, oldest update first. */
  listTasksWithWorktree(): Task[] {
    return this.all("select id from tasks where worktree_path is not null order by updated_at").map((row) => this.getTask(String(row.id))!);
  }

  /** Writes a consistent copy of the whole brain to `path` while the server keeps running. */
  backupTo(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    this.db.exec(`vacuum into '${path.replace(/'/g, "''")}'`);
  }

  /** The code tasks created for an epic, in plan order (a retried step appears more than once). */
  listEpicTasks(epicId: string): Task[] {
    return this.all("select * from tasks where epic_id = ? and kind = 'code' order by epic_position, created_at, rowid", epicId).map(toTask);
  }

  // ---- goals & epics ----------------------------------------------------------

  createGoal(sessionId: string, prompt: string, budgetUsd: number | null = null): Goal {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    const id = randomUUID();
    this.run("insert into goals (id, project_id, session_id, prompt, budget_usd) values (?, ?, ?, ?, ?)", id, session.projectId, sessionId, prompt, budgetUsd);
    const goal = this.getGoal(id)!;
    this.emit("change", { kind: "goal", id, projectId: goal.projectId, sessionId });
    return goal;
  }

  getGoal(id: string): Goal | null {
    const row = this.one("select * from goals where id = ?", id);
    return row ? toGoal(row) : null;
  }

  listGoals(sessionId: string): Goal[] {
    return this.all("select * from goals where session_id = ? order by created_at, rowid", sessionId).map(toGoal);
  }

  updateGoal(id: string, patch: GoalPatch): Goal {
    const { sets, params } = setClause(patch, GOAL_COLUMNS);
    this.run(`update goals set ${[...sets, "updated_at = ?"].join(", ")} where id = ?`, ...params, now(), id);
    const goal = this.getGoal(id);
    if (!goal) throw new Error(`Goal ${id} not found`);
    this.emit("change", { kind: "goal", id, projectId: goal.projectId, sessionId: goal.sessionId });
    return goal;
  }

  /** Replaces a goal's epics with a new plan, numbered from 0. */
  replaceEpics(goalId: string, epics: { title: string; description: string }[]): Epic[] {
    this.transaction(() => {
      this.run("delete from epics where goal_id = ?", goalId);
      epics.forEach((epic, position) =>
        this.run("insert into epics (id, goal_id, position, title, description) values (?, ?, ?, ?, ?)", randomUUID(), goalId, position, epic.title, epic.description),
      );
    });
    const saved = this.listEpics(goalId);
    for (const epic of saved) this.emit("change", { kind: "epic", id: epic.id, goalId });
    return saved;
  }

  getEpic(id: string): Epic | null {
    const row = this.one("select * from epics where id = ?", id);
    return row ? toEpic(row) : null;
  }

  listEpicsByStatus(status: Epic["status"]): Epic[] {
    return this.all("select * from epics where status = ? order by created_at", status).map(toEpic);
  }

  listEpics(goalId: string): Epic[] {
    return this.all("select * from epics where goal_id = ? order by position", goalId).map(toEpic);
  }

  updateEpic(id: string, patch: EpicPatch): Epic {
    const { sets, params } = setClause(patch, EPIC_COLUMNS);
    this.run(`update epics set ${[...sets, "updated_at = ?"].join(", ")} where id = ?`, ...params, now(), id);
    const epic = this.getEpic(id);
    if (!epic) throw new Error(`Epic ${id} not found`);
    this.emit("change", { kind: "epic", id, goalId: epic.goalId });
    return epic;
  }

  /** Total tokens and cost of every task of a goal, planning included. */
  goalUsage(goalId: string): Usage {
    const row = this.one(
      `select coalesce(sum(r.input_tokens), 0) as input, coalesce(sum(r.output_tokens), 0) as output,
       coalesce(sum(r.cache_read_tokens), 0) as cache_read, coalesce(sum(r.cost_usd), 0) as cost
       from agent_runs r join tasks t on t.id = r.task_id where t.goal_id = ?`,
      goalId,
    )!;
    return { inputTokens: Number(row.input), outputTokens: Number(row.output), cacheReadTokens: Number(row.cache_read), costUsd: Number(row.cost) };
  }

  // ---- agent runs & events --------------------------------------------------

  startRun(taskId: string, role: Role, provider: string | null, model: string | null, purpose: string | null = null): AgentRun {
    const id = randomUUID();
    this.run("insert into agent_runs (id, task_id, role, purpose, provider, model) values (?, ?, ?, ?, ?, ?)", id, taskId, role, purpose, provider, model);
    return this.getRun(id)!;
  }

  setRunSession(id: string, dshSessionId: string): void {
    this.run("update agent_runs set dsh_session_id = ? where id = ?", dshSessionId, id);
  }

  finishRun(id: string, status: Exclude<RunStatus, "running">): AgentRun {
    this.run("update agent_runs set status = ?, ended_at = ? where id = ?", status, now(), id);
    return this.getRun(id)!;
  }

  getRun(id: string): AgentRun | null {
    const row = this.one("select * from agent_runs where id = ?", id);
    return row ? toRun(row) : null;
  }

  listRuns(taskId: string): AgentRun[] {
    return this.all("select * from agent_runs where task_id = ? order by started_at, rowid", taskId).map(toRun);
  }

  /** Adds the tokens and cost of one model call to an agent run. */
  recordUsage(runId: string, usage: Usage): AgentRun {
    this.run(
      `update agent_runs set input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
       cache_read_tokens = cache_read_tokens + ?, cost_usd = cost_usd + ? where id = ?`,
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.costUsd,
      runId,
    );
    const run = this.getRun(runId);
    if (!run) throw new Error(`Agent run ${runId} not found`);
    this.emit("change", { kind: "run", id: runId, taskId: run.taskId });
    return run;
  }

  /** Total tokens and cost of every agent run of a task. */
  taskUsage(taskId: string): Usage {
    const row = this.one(
      `select coalesce(sum(input_tokens), 0) as input, coalesce(sum(output_tokens), 0) as output,
       coalesce(sum(cache_read_tokens), 0) as cache_read, coalesce(sum(cost_usd), 0) as cost
       from agent_runs where task_id = ?`,
      taskId,
    )!;
    return { inputTokens: Number(row.input), outputTokens: Number(row.output), cacheReadTokens: Number(row.cache_read), costUsd: Number(row.cost) };
  }

  /** How each critic has done in a project: checks, problems found on first look, problems fixed, tokens and cost. */
  criticStats(projectId: string): CriticStats[] {
    const stats = new Map<string, CriticStats>();
    const entry = (critic: string) => {
      let found = stats.get(critic);
      if (!found) stats.set(critic, (found = { critic, checks: 0, findings: 0, fixed: 0, tokens: 0, costUsd: 0 }));
      return found;
    };
    const open = new Map<string, number>();
    const verdicts = this.all(
      `select e.task_id, e.payload from events e join tasks t on t.id = e.task_id
       where t.project_id = ? and e.type = 'critic_verdict' order by e.id`,
      projectId,
    );
    for (const row of verdicts) {
      const payload = parseJson<{ critic?: string; findings?: unknown[] }>(row.payload, {});
      if (!payload.critic) continue;
      const stat = entry(payload.critic);
      const count = Array.isArray(payload.findings) ? payload.findings.length : 0;
      const key = `${String(row.task_id)}:${payload.critic}`;
      const before = open.get(key);
      stat.checks++;
      if (before === undefined) stat.findings += count;
      else stat.fixed += Math.max(0, before - count);
      open.set(key, count);
    }
    const costs = this.all(
      `select r.purpose, coalesce(sum(r.input_tokens + r.output_tokens), 0) as tokens, coalesce(sum(r.cost_usd), 0) as cost
       from agent_runs r join tasks t on t.id = r.task_id
       where t.project_id = ? and r.role = 'critic' and r.purpose is not null group by r.purpose`,
      projectId,
    );
    for (const row of costs) Object.assign(entry(String(row.purpose)), { tokens: Number(row.tokens), costUsd: Number(row.cost) });
    return [...stats.values()].sort((a, b) => a.critic.localeCompare(b.critic));
  }

  addEvent(taskId: string, type: string, payload: Record<string, unknown> = {}, runId: string | null = null): BrainEvent {
    const row = this.one(
      "insert into events (task_id, run_id, type, payload) values (?, ?, ?, ?) returning *",
      taskId,
      runId,
      type,
      JSON.stringify(payload),
    )!;
    const event = toEvent(row);
    this.emit("change", { kind: "event", id: event.id, taskId });
    return event;
  }

  listEvents(taskId: string, afterId = 0): BrainEvent[] {
    return this.all("select * from events where task_id = ? and id > ? order by id", taskId, afterId).map(toEvent);
  }

  // ---- approvals ------------------------------------------------------------

  /** `target` is a task id, or the task, goal or epic the decision is about. */
  createApproval(target: string | ApprovalTarget, kind: ApprovalKind, summary: string, payload: Record<string, unknown> = {}): Approval {
    const { taskId = null, goalId = null, epicId = null } = typeof target === "string" ? { taskId: target } : target;
    const id = randomUUID();
    this.run(
      "insert into approvals (id, task_id, goal_id, epic_id, kind, summary, payload) values (?, ?, ?, ?, ?, ?, ?)",
      id,
      taskId,
      goalId,
      epicId,
      kind,
      summary,
      JSON.stringify(payload),
    );
    this.emit("change", { kind: "approval", id, taskId, goalId });
    return this.getApproval(id)!;
  }

  /** Records a decision once; returns null if the approval is missing or was already decided. */
  decideApproval(id: string, decision: "approved" | "rejected"): Approval | null {
    const row = this.one(
      "update approvals set status = ?, decided_at = ? where id = ? and status = 'pending' returning *",
      decision,
      now(),
      id,
    );
    if (!row) return null;
    const approval = toApproval(row);
    this.emit("change", { kind: "approval", id, taskId: approval.taskId, goalId: approval.goalId });
    return approval;
  }

  getApproval(id: string): Approval | null {
    const row = this.one("select * from approvals where id = ?", id);
    return row ? toApproval(row) : null;
  }

  listApprovals(status?: Approval["status"]): Approval[] {
    const rows = status
      ? this.all("select * from approvals where status = ? order by created_at desc", status)
      : this.all("select * from approvals order by created_at desc");
    return rows.map(toApproval);
  }

  // ---- memory ---------------------------------------------------------------

  addMemory(input: NewMemory): Memory {
    const projectId = input.scope === "project" ? input.projectId : null;
    if (input.scope === "project" && !projectId) throw new Error("Project memory needs a projectId");
    const id = randomUUID();
    this.run(
      `insert into memories (id, scope, project_id, kind, content, tags, source_task_id)
       values (?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.scope,
      projectId ?? null,
      input.kind ?? "note",
      input.content.trim(),
      JSON.stringify(input.tags ?? []),
      input.sourceTaskId ?? null,
    );
    this.emit("change", { kind: "memory", id, projectId: projectId ?? null });
    return this.getMemory(id)!;
  }

  /**
   * A saved memory that says nearly the same thing and would be read in the same places: for global memory
   * another global memory, for project memory a memory of that project or a global one.
   */
  findDuplicateMemory(input: Pick<NewMemory, "scope" | "projectId" | "content">): Memory | null {
    const projectId = input.scope === "project" ? (input.projectId ?? null) : null;
    const candidates = this.searchMemories(projectId, input.content, 20);
    return candidates.find((m) => memorySimilarity(m.content, input.content) >= DUPLICATE_SIMILARITY) ?? null;
  }

  /** Adds a memory unless a near-identical one already exists; agents save through this. */
  rememberMemory(input: NewMemory): { memory: Memory; duplicate: boolean } {
    const existing = this.findDuplicateMemory(input);
    return existing ? { memory: existing, duplicate: true } : { memory: this.addMemory(input), duplicate: false };
  }

  updateMemory(id: string, patch: Partial<Omit<NewMemory, "sourceTaskId">>): Memory {
    const current = this.getMemory(id);
    if (!current) throw new Error(`Memory ${id} not found`);
    const scope = patch.scope ?? current.scope;
    const projectId = scope === "global" ? null : (patch.projectId ?? current.projectId);
    if (scope === "project" && !projectId) throw new Error("Project memory needs a projectId");
    this.run(
      "update memories set scope = ?, project_id = ?, kind = ?, content = ?, tags = ?, updated_at = ? where id = ?",
      scope,
      projectId,
      patch.kind ?? current.kind,
      (patch.content ?? current.content).trim(),
      JSON.stringify(patch.tags ?? current.tags),
      now(),
      id,
    );
    this.emit("change", { kind: "memory", id, projectId });
    return this.getMemory(id)!;
  }

  deleteMemory(id: string): void {
    const current = this.getMemory(id);
    this.run("delete from memories where id = ?", id);
    if (current) this.emit("change", { kind: "memory", id, projectId: current.projectId });
  }

  getMemory(id: string): Memory | null {
    const row = this.one("select * from memories where id = ?", id);
    return row ? toMemory(row) : null;
  }

  /**
   * `{ scope: "global" }` → global only; `{ scope: "project", projectId }` → that project only;
   * `{ visibleTo: projectId }` → what an agent working in that project may see (global + that project).
   */
  listMemories(
    filter: { scope: "global" } | { scope: "project"; projectId: string } | { visibleTo: string | null },
    limit = 200,
  ): Memory[] {
    if ("visibleTo" in filter) {
      return this.all(
        "select * from memories where scope = 'global' or project_id = ? order by updated_at desc limit ?",
        filter.visibleTo,
        limit,
      ).map(toMemory);
    }
    if (filter.scope === "global") {
      return this.all("select * from memories where scope = 'global' order by updated_at desc limit ?", limit).map(toMemory);
    }
    return this.all(
      "select * from memories where scope = 'project' and project_id = ? order by updated_at desc limit ?",
      filter.projectId,
      limit,
    ).map(toMemory);
  }

  /** Full-text search over global memory plus the given project's memory (never other projects). */
  searchMemories(projectId: string | null, query: string, limit = 20): Memory[] {
    const terms = (query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 16);
    if (terms.length === 0) return this.listMemories({ visibleTo: projectId }, limit);
    const match = terms.map((t) => `"${t}"*`).join(" OR ");
    return this.all(
      `select m.* from memories_fts
       join memories m on m.seq = memories_fts.rowid
       where memories_fts match ? and (m.scope = 'global' or m.project_id = ?)
       order by bm25(memories_fts), m.updated_at desc
       limit ?`,
      match,
      projectId,
      limit,
    ).map(toMemory);
  }

  // ---- role settings --------------------------------------------------------

  listRoleSettings(): RoleSetting[] {
    return this.all("select * from role_settings order by role").map(toRoleSetting);
  }

  getRoleSetting(role: Role): RoleSetting {
    return toRoleSetting(this.one("select * from role_settings where role = ?", role)!);
  }

  setRoleSetting(role: Role, provider: string, model: string, reasoningEffort: string | null = null): RoleSetting {
    this.run(
      "update role_settings set provider = ?, model = ?, reasoning_effort = ?, updated_at = ? where role = ?",
      provider,
      model,
      reasoningEffort,
      now(),
      role,
    );
    this.emit("change", { kind: "settings", role });
    return this.getRoleSetting(role);
  }

  // ---- model providers and prices -----------------------------------------------

  listProviders(): Provider[] {
    return this.all("select * from providers order by name collate nocase").map(toProvider);
  }

  getProvider(id: string): Provider | null {
    const row = this.one("select * from providers where id = ?", id);
    return row ? toProvider(row) : null;
  }

  /** The encrypted key; only the server's provider registry decrypts it. */
  providerKeyCipher(id: string): string | null {
    const row = this.one("select key_cipher from providers where id = ?", id);
    return row?.key_cipher ? String(row.key_cipher) : null;
  }

  createProvider(input: { id: string; name: string; type: ProviderType; baseUrl: string }): Provider {
    this.run("insert into providers (id, name, type, base_url) values (?, ?, ?, ?)", input.id, input.name, input.type, input.baseUrl);
    this.emit("change", { kind: "settings", key: "providers" });
    return this.getProvider(input.id)!;
  }

  updateProvider(id: string, patch: Partial<{ name: string; type: ProviderType; baseUrl: string }>): Provider {
    const columns: [string, SQLInputValue][] = [];
    if (patch.name !== undefined) columns.push(["name", patch.name]);
    if (patch.type !== undefined) columns.push(["type", patch.type]);
    if (patch.baseUrl !== undefined) columns.push(["base_url", patch.baseUrl]);
    if (columns.length) {
      this.run(
        `update providers set ${columns.map(([c]) => `${c} = ?`).join(", ")}, updated_at = ? where id = ?`,
        ...columns.map(([, v]) => v),
        now(),
        id,
      );
      this.emit("change", { kind: "settings", key: "providers" });
    }
    return this.getProvider(id)!;
  }

  setProviderKey(id: string, cipher: string | null, last4: string | null): void {
    this.run("update providers set key_cipher = ?, key_last4 = ?, updated_at = ? where id = ?", cipher, last4, now(), id);
    this.emit("change", { kind: "settings", key: "providers" });
  }

  deleteProvider(id: string): void {
    this.run("delete from providers where id = ?", id);
    this.emit("change", { kind: "settings", key: "providers" });
  }

  listModelPrices(): ModelPrice[] {
    return this.all("select * from model_prices order by provider_id, model").map(toModelPrice);
  }

  getModelPrice(providerId: string, model: string): ModelPrice | null {
    const row = this.one("select * from model_prices where provider_id = ? and model = ?", providerId, model);
    return row ? toModelPrice(row) : null;
  }

  /** Saves the owner's price for a model (US dollars per million tokens), or removes it with null. */
  setModelPrice(providerId: string, model: string, price: { input: number; output: number; cacheRead: number | null } | null): void {
    if (price) {
      this.run(
        `insert into model_prices (provider_id, model, input_per_million, output_per_million, cache_read_per_million, updated_at) values (?, ?, ?, ?, ?, ?)
         on conflict(provider_id, model) do update set input_per_million = excluded.input_per_million, output_per_million = excluded.output_per_million,
           cache_read_per_million = excluded.cache_read_per_million, updated_at = excluded.updated_at`,
        providerId,
        model,
        price.input,
        price.output,
        price.cacheRead,
        now(),
      );
    } else {
      this.run("delete from model_prices where provider_id = ? and model = ?", providerId, model);
    }
    this.emit("change", { kind: "settings", key: "prices" });
  }

  // ---- server settings and spending -------------------------------------------

  /** A server-wide setting stored as JSON, or `fallback` when it was never set (a saved null stays null). */
  getAppSetting<T>(key: string, fallback: T): T {
    const row = this.one("select value from app_settings where key = ?", key);
    return row ? (JSON.parse(String(row.value)) as T) : fallback;
  }

  setAppSetting(key: string, value: unknown): void {
    this.run(
      "insert into app_settings (key, value, updated_at) values (?, ?, ?) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at",
      key,
      JSON.stringify(value ?? null),
      now(),
    );
    this.emit("change", { kind: "settings", key });
  }

  /** What all agent runs started since `sinceIso` cost together, across every project. */
  costSince(sinceIso: string): number {
    return Number(this.one("select coalesce(sum(cost_usd), 0) as cost from agent_runs where started_at >= ?", sinceIso)!.cost);
  }
}

const toProvider = (r: Row): Provider => ({
  id: String(r.id),
  name: String(r.name),
  type: String(r.type) as ProviderType,
  baseUrl: String(r.base_url),
  hasKey: r.key_cipher !== null && r.key_cipher !== undefined && String(r.key_cipher) !== "",
  keyLast4: r.key_last4 ? String(r.key_last4) : null,
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

const toModelPrice = (r: Row): ModelPrice => ({
  providerId: String(r.provider_id),
  model: String(r.model),
  input: Number(r.input_per_million),
  output: Number(r.output_per_million),
  cacheRead: r.cache_read_per_million === null || r.cache_read_per_million === undefined ? null : Number(r.cache_read_per_million),
  updatedAt: String(r.updated_at),
});
