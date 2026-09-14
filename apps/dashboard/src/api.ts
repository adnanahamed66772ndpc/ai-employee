import type {
  AgentRun,
  Approval,
  BrainChange,
  BrainEvent,
  CriticKind,
  CriticStats,
  Epic,
  Goal,
  Memory,
  MemoryKind,
  Project,
  Provider,
  ProviderType,
  Role,
  RoleSetting,
  Scope,
  Session,
  Task,
  Usage,
} from "@ai-employee/brain/types";

export type { AgentRun, Approval, BrainChange, BrainEvent, CriticKind, CriticStats, Epic, Goal, Memory, MemoryKind, Project, Provider, ProviderType, Role, RoleSetting, Scope, Session, Task, Usage };

/** A model at a provider set up on the Models page. */
export interface ModelRef {
  provider: string;
  model: string;
}

export interface ProviderPreset {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
}

/** US dollars per million tokens. */
export interface Pricing {
  input: number;
  cacheRead: number;
  output: number;
}

export interface CatalogModel {
  id: string;
  price: Pricing | null;
}

export interface PriceRow extends ModelRef {
  providerName: string;
  price: Pricing | null;
  source: "manual" | "provider" | "public" | null;
}

export interface ProviderInput {
  name: string;
  type: ProviderType;
  baseUrl: string;
  /** Leave out to keep the saved key; null removes it. */
  apiKey?: string | null;
}

export interface Health {
  /** Providers the team uses that have no API key yet. */
  missingKeys: string[];
  dshSettings: boolean;
  agents: Record<"read-only" | "workspace-write", boolean>;
  currentTaskId: string | null;
  runningTaskIds: string[];
  maxParallelTasks: number;
  telegram: boolean;
  dataDir: string;
}

export interface TaskDetail {
  task: Task;
  runs: AgentRun[];
  usage: Usage;
  events: BrainEvent[];
  approvals: Approval[];
}

export interface GoalDetail {
  goal: Goal;
  usage: Usage;
  epics: (Epic & { tasks: { id: string; status: Task["status"]; epicPosition: number | null; commitSha: string | null }[] })[];
  approvals: Approval[];
}

export interface Spending {
  dailyBudgetUsd: number | null;
  escalationModel: ModelRef | null;
  visionModel: ModelRef | null;
  spentTodayUsd: number;
  resetsAt: string;
}

export interface MaintenanceStatus {
  backupDir: string;
  keep: number;
  nextBackupAt: string | null;
  backups: { name: string; bytes: number; createdAt: string }[];
  lastCleanup: { at: string; removed: number } | null;
}

export interface DeployStatus {
  repo: string | null;
  workflow: { file: string; found: boolean; url: string | null };
  secrets: { name: string; required: boolean; hint: string; set: boolean; updatedAt: string }[];
  runs: { id: number; title: string; status: string; conclusion: string; branch: string; sha: string; event: string; createdAt: string; url: string }[];
  setupTask: { id: string; sessionId: string; status: Task["status"]; prUrl: string | null; prState: string | null } | null;
  error: string | null;
}

export interface ProjectInput {
  localPath: string;
  name?: string;
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

export interface MemoryInput {
  scope: Scope;
  projectId?: string | null;
  kind?: MemoryKind;
  content: string;
  tags?: string[];
}

export interface FolderEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
  projectId: string | null;
}

export interface FolderListing {
  root: string;
  path: string;
  parent: string | null;
  entries: FolderEntry[];
}

export interface GithubRepo {
  nameWithOwner: string;
  description: string;
  isPrivate: boolean;
  updatedAt: string;
}

export type Visibility = "private" | "public" | "local";

export interface Checks {
  setupCmd?: string;
  testCmd?: string;
  lintCmd?: string;
}

/** Fired when the session is missing or expired so the app can show the login page. */
export const UNAUTHORIZED_EVENT = "aie:unauthorized";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  if (res.status === 401 && !path.startsWith("/auth/")) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (HTTP ${res.status})`);
  return data as T;
}

const q = (params: Record<string, string | undefined>) => {
  const entries = Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined);
  return entries.length ? `?${new URLSearchParams(entries)}` : "";
};

export const api = {
  authStatus: () => request<{ required: boolean; authenticated: boolean }>("GET", "/auth/status"),
  login: (password: string) => request<{ ok: boolean }>("POST", "/auth/login", { password }),
  logout: () => request<{ ok: boolean }>("POST", "/auth/logout"),

  health: () => request<Health>("GET", "/health"),

  projects: () => request<Project[]>("GET", "/projects"),
  createProject: (input: ProjectInput) => request<Project>("POST", "/projects", input),
  cloneProject: (input: { repo: string; folder?: string } & Checks) => request<Project>("POST", "/projects/clone", input),
  newProject: (input: { folder: string; visibility: Visibility; description?: string } & Checks) =>
    request<Project>("POST", "/projects/new", input),
  updateProject: (id: string, input: Partial<ProjectInput>) => request<Project>("PATCH", `/projects/${id}`, input),
  deleteProject: (id: string) => request<void>("DELETE", `/projects/${id}`),
  folders: (path?: string) => request<FolderListing>("GET", `/workspace/folders${q({ path })}`),
  githubRepos: () => request<GithubRepo[]>("GET", "/github/repos"),

  criticStats: (projectId: string) => request<CriticStats[]>("GET", `/projects/${projectId}/critics`),
  deploy: (projectId: string) => request<DeployStatus>("GET", `/projects/${projectId}/deploy`),
  setSecret: (projectId: string, name: string, value: string) =>
    request<{ ok: boolean }>("PUT", `/projects/${projectId}/deploy/secrets/${encodeURIComponent(name)}`, { value }),
  deleteSecret: (projectId: string, name: string) => request<void>("DELETE", `/projects/${projectId}/deploy/secrets/${encodeURIComponent(name)}`),
  setupDeploy: (projectId: string) => request<Task>("POST", `/projects/${projectId}/deploy/setup`),
  sessions: (projectId: string) => request<Session[]>("GET", `/projects/${projectId}/sessions`),
  createSession: (projectId: string, title: string) => request<Session>("POST", `/projects/${projectId}/sessions`, { title }),
  session: (id: string) => request<{ session: Session; project: Project | null }>("GET", `/sessions/${id}`),

  goals: (sessionId: string) => request<GoalDetail[]>("GET", `/sessions/${sessionId}/goals`),
  createGoal: (sessionId: string, input: { prompt: string; budgetUsd?: number | null }) => request<Goal>("POST", `/sessions/${sessionId}/goals`, input),
  continueGoal: (id: string, input: { note?: string; budgetUsd?: number | null }) => request<Goal>("POST", `/goals/${id}/continue`, input),
  cancelGoal: (id: string) => request<{ ok: boolean }>("POST", `/goals/${id}/cancel`),

  tasks: (sessionId: string) => request<Task[]>("GET", `/sessions/${sessionId}/tasks`),
  createTask: (sessionId: string, prompt: string) => request<Task>("POST", `/sessions/${sessionId}/tasks`, { prompt }),
  task: (id: string) => request<TaskDetail>("GET", `/tasks/${id}`),
  cancelTask: (id: string) => request<{ ok: boolean }>("POST", `/tasks/${id}/cancel`),
  continueTask: (id: string, note: string) => request<Task>("POST", `/tasks/${id}/continue`, { note }),

  approvals: (status?: Approval["status"]) => request<Approval[]>("GET", `/approvals${q({ status })}`),
  decide: (id: string, decision: "approved" | "rejected") => request<Approval>("POST", `/approvals/${id}`, { decision }),

  memories: (params: { projectId?: string; q?: string }) => request<Memory[]>("GET", `/memories${q(params)}`),
  createMemory: (input: MemoryInput) => request<Memory>("POST", "/memories", input),
  updateMemory: (id: string, input: Partial<MemoryInput>) => request<Memory>("PATCH", `/memories/${id}`, input),
  deleteMemory: (id: string) => request<void>("DELETE", `/memories/${id}`),

  roles: () => request<RoleSetting[]>("GET", "/settings/roles"),
  setRole: (role: Role, input: { provider: string; model: string; reasoningEffort: string | null }) =>
    request<RoleSetting>("PUT", `/settings/roles/${role}`, input),
  providers: () => request<{ providers: Provider[]; presets: ProviderPreset[] }>("GET", "/providers"),
  createProvider: (input: ProviderInput) => request<Provider>("POST", "/providers", input),
  updateProvider: (id: string, input: Partial<ProviderInput>) => request<Provider>("PATCH", `/providers/${encodeURIComponent(id)}`, input),
  deleteProvider: (id: string) => request<void>("DELETE", `/providers/${encodeURIComponent(id)}`),
  providerModels: (id: string) => request<{ models: CatalogModel[]; error?: string }>("GET", `/providers/${encodeURIComponent(id)}/models`),
  testProvider: (id: string) => request<{ ok: true; models: number } | { ok: false; error: string }>("POST", `/providers/${encodeURIComponent(id)}/test`),
  prices: () => request<{ models: PriceRow[] }>("GET", "/prices"),
  setPrice: (input: ModelRef & { input: number; output: number; cacheRead: number | null }) => request<{ models: PriceRow[] }>("PUT", "/prices", input),
  clearPrice: (ref: ModelRef) =>
    request<{ models: PriceRow[] }>("DELETE", `/prices?provider=${encodeURIComponent(ref.provider)}&model=${encodeURIComponent(ref.model)}`),

  spending: () => request<Spending>("GET", "/settings/spending"),
  setSpending: (input: { dailyBudgetUsd: number | null; escalationModel: ModelRef | null; visionModel?: ModelRef | null }) => request<Spending>("PUT", "/settings/spending", input),
  maintenance: () => request<MaintenanceStatus>("GET", "/maintenance"),
  backupNow: () => request<{ name: string; removed: string[] }>("POST", "/maintenance/backup"),
  cleanupNow: () => request<{ removed: number }>("POST", "/maintenance/cleanup"),

  notifications: () => request<{ telegram: boolean }>("GET", "/notifications"),
  testNotification: () => request<{ ok: boolean }>("POST", "/notifications/test"),
};
