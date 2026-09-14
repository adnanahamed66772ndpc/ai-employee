import { resolve } from "node:path";
import { Hono, type MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import { z, ZodError } from "zod";
import type { Brain, BrainChange, Goal, ProviderType, Role } from "@ai-employee/brain";
import { runCommand } from "@ai-employee/git";
import type { AgentPool } from "./agents.ts";
import { setupAuth } from "./auth.ts";
import { hasDshSettings, type Config } from "./config.ts";
import { deleteSecret, DeployError, deployStatus, queueWorkflowSetup, SECRET_VALUE_MAX, setSecret, type Gh } from "./deploy.ts";
import { handleLlmRequest, type LlmProxyDeps, type PriceBook } from "./llm.ts";
import { modelsInUse, PROVIDER_ID, PROVIDER_PRESETS, PROVIDER_TYPES, type ProviderRegistry } from "./providers.ts";
import type { Maintenance } from "./maintenance.ts";
import { nextDay, spendingSettings, todaySpend } from "./spending.ts";
import { APP_URL } from "./visual.ts";
import { handleMcpRequest, type McpTokens } from "./mcp.ts";
import type { Notifier } from "./notify.ts";
import type { AuthFile } from "./password.ts";
import type { Orchestrator } from "./pipeline.ts";
import {
  browseProjectsDir,
  cloneProject,
  createNewProject,
  listGithubRepos,
  ProjectError,
  registerProject,
  REPO_NAME_PATTERN,
} from "./projects.ts";

class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

const ROLES = ["planner", "coder", "reviewer", "critic", "git", "memory"] as const;
const REPO_NAME = z.string().regex(REPO_NAME_PATTERN, "Use owner/name, each starting with a letter or number");

const checks = {
  setupCmd: z.string().max(500).nullable().optional(),
  testCmd: z.string().max(500).nullable().optional(),
  lintCmd: z.string().max(500).nullable().optional(),
  taskBudgetUsd: z.number().positive("The budget must be more than $0").max(1000).nullable().optional(),
  disabledCritics: z.array(z.enum(["ui", "security"])).max(2).optional(),
  startCmd: z.string().max(500).nullable().optional(),
  appUrl: z.union([z.literal(""), z.string().trim().regex(APP_URL, "Use a local address such as http://127.0.0.1:{port}/")]).nullable().optional(),
};

const projectInput = z.object({
  localPath: z.string().min(1),
  name: z.string().min(1).max(100).optional(),
  githubRepo: REPO_NAME.nullable().optional(),
  defaultBranch: z.string().min(1).optional(),
  ...checks,
});

const cloneInput = z.object({ repo: REPO_NAME, folder: z.string().max(100).optional(), ...checks });

const newRepositoryInput = z.object({
  folder: z.string().min(1).max(100),
  visibility: z.enum(["local", "private", "public"]),
  description: z.string().max(350).optional(),
  ...checks,
});

const memoryInput = z.object({
  scope: z.enum(["global", "project"]),
  projectId: z.string().nullable().optional(),
  kind: z.enum(["preference", "convention", "fact", "lesson", "note"]).optional(),
  content: z.string().min(1).max(4000),
  tags: z.array(z.string()).max(12).optional(),
});

/**
 * Only accept requests addressed to this machine or to the configured public URL (via the reverse proxy).
 * This blocks DNS rebinding and cross-site calls.
 */
function hostGuard(port: number, publicUrl: URL | undefined): MiddlewareHandler {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, "127.0.0.1:5173", "localhost:5173"]);
  if (publicUrl) hosts.add(publicUrl.host);
  return async (c, next) => {
    const host = c.req.header("host") ?? "";
    const origin = c.req.header("origin");
    const originOk = !origin || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin) || origin === publicUrl?.origin;
    if (!hosts.has(host) || !originOk) return c.text("Forbidden", 403);
    await next();
  };
}

/** The agents' endpoints (memory and the model gateway) are for local processes only, never through the reverse proxy. */
function directLocalOnly(port: number): MiddlewareHandler {
  return async (c, next) => {
    const proxied = c.req.header("x-forwarded-for") ?? c.req.header("cf-connecting-ip") ?? c.req.header("x-real-ip");
    if (proxied || c.req.header("host") !== `127.0.0.1:${port}`) return c.text("Not found", 404);
    await next();
  };
}

const blank = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);

/** Model ids across providers: deepseek-v4-pro, anthropic/claude-sonnet-4.5, llama3.1:8b. */
const MODEL_ID = z.string().trim().min(1, "Choose a model").max(200).regex(/^[\w.:/@+-]+$/, "Use a model id such as deepseek-v4-pro");
const modelRef = z.object({ provider: z.string().regex(PROVIDER_ID, "Choose a provider"), model: MODEL_ID });

export function createApp(deps: {
  brain: Brain;
  orchestrator: Pick<Orchestrator, "runningTaskIds" | "cancel" | "continueTask" | "onApprovalDecided" | "manager">;
  tokens: McpTokens;
  pool: Pick<AgentPool, "status">;
  config: Config;
  auth: AuthFile | null;
  notifier: Notifier;
  llm: LlmProxyDeps;
  /** Model providers with their encrypted keys. */
  providers: Pick<ProviderRegistry, "list" | "create" | "update" | "remove" | "catalog" | "missingKeys">;
  prices: Pick<PriceBook, "resolve">;
  /** Runs the GitHub CLI; tests pass a fake. */
  gh?: Gh;
  maintenance?: Pick<Maintenance, "status" | "backup" | "cleanWorktrees">;
}) {
  const { brain, orchestrator, tokens, pool, config, auth, notifier, llm, providers, prices } = deps;
  const gh: Gh = deps.gh ?? ((args, input) => runCommand("gh", args, config.rootDir, input));
  const app = new Hono();
  app.use("*", hostGuard(config.port, config.publicUrl));
  app.onError((error, c) => {
    if (error instanceof HttpError || error instanceof ProjectError) return c.json({ error: error.message }, error.status);
    if (error instanceof ZodError) return c.json({ error: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return c.json({ error: "That folder does not exist" }, 404);
    console.error(error);
    return c.json({ error: error.message }, 500);
  });

  app.use("/mcp", directLocalOnly(config.port));
  app.all("/mcp", (c) => handleMcpRequest(brain, tokens, c.req.raw));

  app.use("/llm/*", directLocalOnly(config.port));
  // Settings written before providers existed call /llm/v1 for CheaperInference.
  app.all("/llm/v1/*", (c) => handleLlmRequest(c.req.raw, "cheaperinference", c.req.path.slice("/llm".length), llm));
  app.all("/llm/p/:provider/*", (c) => {
    const provider = c.req.param("provider");
    return handleLlmRequest(c.req.raw, provider, c.req.path.slice(`/llm/p/${provider}`.length), llm);
  });

  app.use("/api/*", setupAuth(app, auth, { secureCookie: config.publicUrl?.protocol === "https:" }));

  const api = new Hono();
  const found = <T>(value: T | null, what: string): T => {
    if (value === null) throw new HttpError(404, `${what} not found`);
    return value;
  };
  const knownProvider = (id: string) => {
    if (!brain.getProvider(id)) throw new HttpError(400, `There is no provider "${id}". Add it on the Models page first.`);
  };

  api.get("/health", async (c) => {
    const running = orchestrator.runningTaskIds;
    return c.json({
      missingKeys: providers.missingKeys(),
      dshSettings: hasDshSettings(config),
      agents: await pool.status(),
      currentTaskId: running[0] ?? null,
      runningTaskIds: running,
      maxParallelTasks: config.maxParallelTasks,
      telegram: notifier.configured,
      dataDir: config.dataDir,
    });
  });

  // ---- projects & sessions
  api.get("/projects", (c) => c.json(brain.listProjects()));

  api.post("/projects", async (c) => {
    const input = projectInput.parse(await c.req.json());
    return c.json(await registerProject(brain, config, input.localPath, input), 201);
  });

  api.post("/projects/clone", async (c) => {
    const input = cloneInput.parse(await c.req.json());
    return c.json(await cloneProject(brain, config, input), 201);
  });

  api.post("/projects/new", async (c) => {
    const input = newRepositoryInput.parse(await c.req.json());
    return c.json(await createNewProject(brain, config, input), 201);
  });

  api.get("/workspace/folders", (c) => c.json(browseProjectsDir(brain, config, c.req.query("path"))));

  api.get("/github/repos", async (c) => c.json(await listGithubRepos(config)));

  api.patch("/projects/:id", async (c) => {
    found(brain.getProject(c.req.param("id")), "Project");
    const input = projectInput.partial().parse(await c.req.json());
    const patch = {
      ...input,
      ...(input.localPath ? { localPath: resolve(input.localPath) } : {}),
      ...("setupCmd" in input ? { setupCmd: blank(input.setupCmd) } : {}),
      ...("testCmd" in input ? { testCmd: blank(input.testCmd) } : {}),
      ...("lintCmd" in input ? { lintCmd: blank(input.lintCmd) } : {}),
      ...("startCmd" in input ? { startCmd: blank(input.startCmd) } : {}),
      ...("appUrl" in input ? { appUrl: blank(input.appUrl) } : {}),
    };
    return c.json(brain.updateProject(c.req.param("id"), patch));
  });

  api.delete("/projects/:id", (c) => {
    brain.deleteProject(c.req.param("id"));
    return c.body(null, 204);
  });

  api.get("/projects/:id/critics", (c) => {
    found(brain.getProject(c.req.param("id")), "Project");
    return c.json(brain.criticStats(c.req.param("id")));
  });

  // ---- deploy (GitHub Actions secrets and the matrix-build-deploy workflow)
  const deployAction = async <T>(action: () => T | Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      if (error instanceof DeployError) throw new HttpError(400, error.message);
      throw error;
    }
  };

  api.get("/projects/:id/deploy", async (c) => {
    const project = found(brain.getProject(c.req.param("id")), "Project");
    return c.json(await deployStatus(gh, brain, project));
  });

  api.put("/projects/:id/deploy/secrets/:name", async (c) => {
    const project = found(brain.getProject(c.req.param("id")), "Project");
    const { value } = z.object({ value: z.string().min(1, "The value is empty").max(SECRET_VALUE_MAX) }).parse(await c.req.json());
    await deployAction(() => setSecret(gh, project, c.req.param("name").toUpperCase(), value));
    return c.json({ ok: true });
  });

  api.delete("/projects/:id/deploy/secrets/:name", async (c) => {
    const project = found(brain.getProject(c.req.param("id")), "Project");
    await deployAction(() => deleteSecret(gh, project, c.req.param("name").toUpperCase()));
    return c.body(null, 204);
  });

  api.post("/projects/:id/deploy/setup", async (c) => {
    const project = found(brain.getProject(c.req.param("id")), "Project");
    return c.json(await deployAction(() => queueWorkflowSetup(gh, brain, project)), 201);
  });

  api.get("/projects/:id/sessions", (c) => c.json(brain.listSessions(c.req.param("id"))));

  api.post("/projects/:id/sessions", async (c) => {
    const project = found(brain.getProject(c.req.param("id")), "Project");
    const { title } = z.object({ title: z.string().min(1).max(200) }).parse(await c.req.json());
    return c.json(brain.createSession(project.id, title), 201);
  });

  api.get("/sessions/:id", (c) => {
    const session = found(brain.getSession(c.req.param("id")), "Session");
    return c.json({ session, project: brain.getProject(session.projectId) });
  });

  // ---- tasks
  api.get("/sessions/:id/tasks", (c) => c.json(brain.listTasks(c.req.param("id"))));

  api.post("/sessions/:id/tasks", async (c) => {
    const session = found(brain.getSession(c.req.param("id")), "Session");
    const { prompt } = z.object({ prompt: z.string().min(1).max(20_000) }).parse(await c.req.json());
    return c.json(brain.createTask(session.id, prompt), 201);
  });

  // ---- goals (the project manager)
  const goalDetail = (goal: Goal) => ({
    goal,
    usage: brain.goalUsage(goal.id),
    epics: brain.listEpics(goal.id).map((epic) => ({
      ...epic,
      tasks: brain.listEpicTasks(epic.id).map((t) => ({ id: t.id, status: t.status, epicPosition: t.epicPosition, commitSha: t.commitSha })),
    })),
    approvals: brain.listApprovals("pending").filter((a) => a.goalId === goal.id),
  });
  const managerAction = async <T>(action: () => T | Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      throw new HttpError(409, (error as Error).message);
    }
  };

  api.get("/sessions/:id/goals", (c) => c.json(brain.listGoals(c.req.param("id")).map(goalDetail)));

  api.post("/sessions/:id/goals", async (c) => {
    const session = found(brain.getSession(c.req.param("id")), "Session");
    const input = z.object({ prompt: z.string().min(1).max(20_000), budgetUsd: checks.taskBudgetUsd }).parse(await c.req.json());
    return c.json(orchestrator.manager.createGoal(session.id, input.prompt, input.budgetUsd ?? null), 201);
  });

  api.get("/goals/:id", (c) => c.json(goalDetail(found(brain.getGoal(c.req.param("id")), "Goal"))));

  api.post("/goals/:id/continue", async (c) => {
    found(brain.getGoal(c.req.param("id")), "Goal");
    const input = z.object({ note: z.string().max(4_000).optional(), budgetUsd: checks.taskBudgetUsd }).parse(await c.req.json().catch(() => ({})));
    const options = { note: input.note, ...("budgetUsd" in input ? { budgetUsd: input.budgetUsd ?? null } : {}) };
    return c.json(await managerAction(() => orchestrator.manager.resumeGoal(c.req.param("id"), options)));
  });

  api.post("/goals/:id/cancel", async (c) => {
    found(brain.getGoal(c.req.param("id")), "Goal");
    await managerAction(() => orchestrator.manager.cancelGoal(c.req.param("id")));
    return c.json({ ok: true });
  });

  api.get("/tasks/:id", (c) => {
    const task = found(brain.getTask(c.req.param("id")), "Task");
    const after = Number(c.req.query("afterEvent") ?? 0);
    return c.json({
      task,
      runs: brain.listRuns(task.id),
      usage: brain.taskUsage(task.id),
      events: brain.listEvents(task.id, Number.isFinite(after) ? after : 0),
      approvals: brain.listApprovals().filter((a) => a.taskId === task.id),
    });
  });

  api.post("/tasks/:id/continue", async (c) => {
    found(brain.getTask(c.req.param("id")), "Task");
    const { note } = z.object({ note: z.string().max(4_000).optional() }).parse(await c.req.json().catch(() => ({})));
    try {
      return c.json(orchestrator.continueTask(c.req.param("id"), note?.trim() ?? ""));
    } catch (error) {
      throw new HttpError(409, (error as Error).message);
    }
  });

  api.post("/tasks/:id/cancel", (c) => {
    found(brain.getTask(c.req.param("id")), "Task");
    if (!orchestrator.cancel(c.req.param("id"))) throw new HttpError(409, "This task can no longer be cancelled");
    return c.json({ ok: true });
  });

  // ---- approvals
  api.get("/approvals", (c) => {
    const status = z.enum(["pending", "approved", "rejected"]).optional().parse(c.req.query("status"));
    return c.json(brain.listApprovals(status));
  });

  api.post("/approvals/:id", async (c) => {
    const { decision } = z.object({ decision: z.enum(["approved", "rejected"]) }).parse(await c.req.json());
    const approval = brain.decideApproval(c.req.param("id"), decision);
    if (!approval) throw new HttpError(409, "This approval was already decided or does not exist");
    void orchestrator.onApprovalDecided(approval);
    return c.json(approval);
  });

  // ---- memory
  api.get("/memories", (c) => {
    const projectId = c.req.query("projectId");
    const q = c.req.query("q");
    if (q !== undefined) return c.json(brain.searchMemories(projectId ?? null, q, 50));
    return c.json(projectId ? brain.listMemories({ scope: "project", projectId }) : brain.listMemories({ scope: "global" }));
  });

  api.post("/memories", async (c) => {
    const input = memoryInput.parse(await c.req.json());
    if (input.scope === "project") found(brain.getProject(input.projectId ?? ""), "Project");
    return c.json(brain.addMemory(input), 201);
  });

  api.patch("/memories/:id", async (c) => {
    found(brain.getMemory(c.req.param("id")), "Memory");
    return c.json(brain.updateMemory(c.req.param("id"), memoryInput.partial().parse(await c.req.json())));
  });

  api.delete("/memories/:id", (c) => {
    brain.deleteMemory(c.req.param("id"));
    return c.body(null, 204);
  });

  // ---- model settings
  api.get("/settings/roles", (c) => c.json(brain.listRoleSettings()));

  api.put("/settings/roles/:role", async (c) => {
    const role = z.enum(ROLES).parse(c.req.param("role")) as Role;
    const input = z
      .object({ provider: z.string().min(1), model: MODEL_ID, reasoningEffort: z.string().nullable().optional() })
      .parse(await c.req.json());
    knownProvider(input.provider);
    return c.json(brain.setRoleSetting(role, input.provider, input.model, blank(input.reasoningEffort)));
  });

  const spendingInput = z.object({
    dailyBudgetUsd: z.number().positive("The daily budget must be more than $0").max(1000).nullable(),
    escalationModel: modelRef.nullable(),
    visionModel: modelRef.nullable().optional(),
  });
  const spending = () => ({ ...spendingSettings(brain), spentTodayUsd: todaySpend(brain), resetsAt: nextDay(new Date()).toISOString() });

  api.get("/settings/spending", (c) => c.json(spending()));

  api.put("/settings/spending", async (c) => {
    const input = spendingInput.parse(await c.req.json());
    if (input.escalationModel) knownProvider(input.escalationModel.provider);
    if (input.visionModel) knownProvider(input.visionModel.provider);
    brain.setAppSetting("dailyBudgetUsd", input.dailyBudgetUsd);
    brain.setAppSetting("escalationModel", input.escalationModel);
    if (input.visionModel !== undefined) brain.setAppSetting("visionModel", input.visionModel);
    return c.json(spending());
  });

  // ---- model providers: keys go in and never come back out
  const providerInput = z.object({
    name: z.string().trim().min(1, "Give the provider a name").max(60),
    type: z.enum(PROVIDER_TYPES as [ProviderType, ...ProviderType[]]),
    baseUrl: z.string().trim().min(1, "Enter the provider's base URL").max(300),
    apiKey: z.string().trim().max(500).nullable().optional(),
  });
  /** Registry errors are the owner's input problems (400), or a provider still in use (409). */
  const providerAction = <T>(action: () => T): T => {
    try {
      return action();
    } catch (error) {
      if (error instanceof HttpError || error instanceof ZodError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpError(/still used/.test(message) ? 409 : 400, message);
    }
  };

  api.get("/providers", (c) => c.json({ providers: providers.list(), presets: PROVIDER_PRESETS }));

  api.post("/providers", async (c) => {
    const input = providerInput.parse(await c.req.json());
    return c.json(providerAction(() => providers.create({ name: input.name, type: input.type, baseUrl: input.baseUrl, apiKey: input.apiKey || undefined })), 201);
  });

  api.patch("/providers/:id", async (c) => {
    const id = c.req.param("id");
    found(brain.getProvider(id), "Provider");
    const input = providerInput.partial().parse(await c.req.json());
    // An empty key field keeps the saved key; null removes it.
    const apiKey = input.apiKey === null ? null : input.apiKey ? input.apiKey : undefined;
    return c.json(providerAction(() => providers.update(id, { name: input.name, type: input.type, baseUrl: input.baseUrl, apiKey })));
  });

  api.delete("/providers/:id", (c) => {
    const id = c.req.param("id");
    found(brain.getProvider(id), "Provider");
    providerAction(() => providers.remove(id));
    return c.body(null, 204);
  });

  api.get("/providers/:id/models", async (c) => {
    const id = c.req.param("id");
    found(brain.getProvider(id), "Provider");
    try {
      return c.json({ models: await providers.catalog(id) });
    } catch (error) {
      return c.json({ models: [], error: (error as Error).message });
    }
  });

  api.post("/providers/:id/test", async (c) => {
    const id = c.req.param("id");
    found(brain.getProvider(id), "Provider");
    try {
      return c.json({ ok: true, models: (await providers.catalog(id)).length });
    } catch (error) {
      return c.json({ ok: false, error: (error as Error).message });
    }
  });

  // ---- model prices for cost tracking: the owner's price, else the provider's list, else the public list
  const priceRows = async () => ({
    models: await Promise.all(
      modelsInUse(brain).map(async (ref) => ({
        ...ref,
        providerName: brain.getProvider(ref.provider)?.name ?? ref.provider,
        ...(await prices.resolve(ref.provider, ref.model)),
      })),
    ),
  });
  const priceInput = z.object({
    provider: z.string().min(1),
    model: MODEL_ID,
    input: z.number().min(0).max(10_000),
    output: z.number().min(0).max(10_000),
    cacheRead: z.number().min(0).max(10_000).nullable().optional(),
  });

  api.get("/prices", async (c) => c.json(await priceRows()));

  api.put("/prices", async (c) => {
    const input = priceInput.parse(await c.req.json());
    knownProvider(input.provider);
    brain.setModelPrice(input.provider, input.model, { input: input.input, output: input.output, cacheRead: input.cacheRead ?? null });
    return c.json(await priceRows());
  });

  api.delete("/prices", async (c) => {
    brain.setModelPrice(c.req.query("provider") ?? "", c.req.query("model") ?? "", null);
    return c.json(await priceRows());
  });

  // ---- backups and cleanup
  const maintenance = () => {
    if (!deps.maintenance) throw new HttpError(404, "Maintenance is not running on this server");
    return deps.maintenance;
  };

  api.get("/maintenance", (c) => c.json(maintenance().status()));

  api.post("/maintenance/backup", (c) => {
    try {
      return c.json(maintenance().backup());
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(409, `The backup failed: ${(error as Error).message}`);
    }
  });

  api.post("/maintenance/cleanup", async (c) => c.json({ removed: await maintenance().cleanWorktrees() }));

  // ---- notifications
  api.get("/notifications", (c) => c.json({ telegram: notifier.configured }));

  api.post("/notifications/test", async (c) => {
    if (!notifier.configured) throw new HttpError(400, "Telegram is not set up yet. Add the bot token and chat id to .env.local on the server, then restart.");
    try {
      await notifier.send("AI Employee test message: notifications work. You will hear from me when a task needs you.");
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
    return c.json({ ok: true });
  });

  // ---- live updates
  api.get("/stream", (c) =>
    streamSSE(c, async (stream) => {
      const onChange = (change: BrainChange) => void stream.writeSSE({ event: "change", data: JSON.stringify(change) });
      brain.on("change", onChange);
      stream.onAbort(() => {
        brain.off("change", onChange);
      });
      while (!stream.aborted) {
        await stream.sleep(15_000);
        if (!stream.aborted) await stream.writeSSE({ event: "ping", data: "" });
      }
    }),
  );

  app.route("/api", api);
  return app;
}
