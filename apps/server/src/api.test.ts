import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Brain } from "@ai-employee/brain";
import { createApp } from "./api.ts";
import type { Config } from "./config.ts";
import type { Gh } from "./deploy.ts";
import { randomBytes } from "node:crypto";
import { KeyStore } from "./keystore.ts";
import { PriceBook, type LlmProxyDeps } from "./llm.ts";
import { ProviderRegistry } from "./providers.ts";
import { McpTokens } from "./mcp.ts";
import type { Notifier } from "./notify.ts";

let brain: Brain;
let sent: string[];
beforeEach(() => {
  brain = new Brain(":memory:");
  sent = [];
});
afterEach(() => brain.close());

const config = {
  port: 7717,
  publicUrl: undefined,
  dataDir: "data",
  dshSettingsPath: "does-not-exist.yaml",
  maxParallelTasks: 2,
  cheaperInferenceKey: undefined,
  cheaperInferenceBaseUrl: "https://gateway.test/v1",
  projectsDir: "projects",
} as unknown as Config;

function makeApp(options: { telegram?: boolean; gh?: Gh } = {}) {
  const notifier: Notifier = { configured: options.telegram ?? false, send: async (text) => void sent.push(text) };
  const catalog = (async () =>
    Response.json({ data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-v4-flash", pricing: { input_per_million: 0.1, output_per_million: 0.2 } }] })) as unknown as typeof fetch;
  const providers = new ProviderRegistry(brain, KeyStore.fromSecret(randomBytes(32)), catalog);
  const prices = new PriceBook({
    manual: (provider, model) => {
      const price = brain.getModelPrice(provider, model);
      return price ? { input: price.input, output: price.output, cacheRead: price.cacheRead ?? price.input } : null;
    },
    catalog: (id) => providers.catalog(id),
  });
  const llm: LlmProxyDeps = {
    provider: (id) => providers.gateway(id),
    prices,
    resolveRun: () => null,
    refusal: () => null,
    record: () => {},
    log: () => {},
  };
  const app = createApp({
    brain,
    orchestrator: {
      runningTaskIds: ["t1"],
      cancel: () => false,
      continueTask: () => {
        throw new Error("Only a task that needs your help, or stopped before its commit, can continue");
      },
      onApprovalDecided: async () => {},
      manager: {} as never,
    },
    tokens: new McpTokens(),
    pool: { status: async () => ({ "read-only": true, "workspace-write": false }) },
    config,
    auth: null,
    notifier,
    llm,
    providers,
    prices,
    gh: options.gh,
  });
  return (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    app.request(`http://127.0.0.1:7717${path}`, { ...init, headers: { host: "127.0.0.1:7717", ...init.headers } });
}

const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("api", () => {
  it("only answers requests addressed to this server", async () => {
    const call = makeApp();
    expect((await call("/api/health", { headers: { host: "evil.example" } })).status).toBe(403);
    expect((await call("/api/health", { headers: { origin: "https://evil.example" } })).status).toBe(403);
  });

  it("reports running tasks and whether notifications are on", async () => {
    const response = await makeApp()("/api/health");
    expect(await response.json()).toMatchObject({ currentTaskId: "t1", runningTaskIds: ["t1"], maxParallelTasks: 2, telegram: false });
  });

  it("validates the task budget", async () => {
    const response = await makeApp()("/api/projects", json({ localPath: "/srv/ai-projects/shop", taskBudgetUsd: -1 }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/budget/);
  });

  it("keeps the model gateway local", async () => {
    const call = makeApp();
    const proxied = await call("/llm/v1/chat/completions", { ...json({}), headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" } });
    expect(proxied.status).toBe(404);
    expect(await proxied.text()).toBe("Not found");
    // Reached directly, the request gets through to the gateway, which has no key in this test.
    expect((await call("/llm/v1/chat/completions", json({ model: "m", messages: [] }))).status).toBe(503);
  });

  it("sends a test notification only when Telegram is set up", async () => {
    expect((await makeApp()("/api/notifications/test", { method: "POST" })).status).toBe(400);
    const response = await makeApp({ telegram: true })("/api/notifications/test", { method: "POST" });
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("includes the task's token usage and cost", async () => {
    const project = brain.createProject({ name: "Shop", localPath: "/srv/ai-projects/shop" });
    const task = brain.createTask(brain.createSession(project.id, "s").id, "do it");
    const run = brain.startRun(task.id, "coder", "cheaperinference", "deepseek-v4-flash");
    brain.recordUsage(run.id, { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 100, costUsd: 0.0021 });

    const detail = (await (await makeApp()(`/api/tasks/${task.id}`)).json()) as { usage: unknown; runs: unknown[] };
    expect(detail.usage).toMatchObject({ inputTokens: 1200, outputTokens: 300, cacheReadTokens: 100, costUsd: 0.0021 });
    expect(detail.runs[0]).toMatchObject({ costUsd: 0.0021 });
  });
});

describe("deploy", () => {
  const calls: { args: string[]; input?: string }[] = [];
  beforeEach(() => void (calls.length = 0));

  /** A stand-in GitHub CLI: the repository has one required secret, one of the owner's own, and maybe the workflow. */
  const fakeGh =
    (options: { workflow: boolean; prState?: string }): Gh =>
    async (args, input) => {
      calls.push({ args, input });
      if (args[0] === "pr") return `${options.prState ?? "OPEN"}\n`;
      if (args[0] === "secret" && args[1] === "list") {
        return JSON.stringify([
          { name: "SSH_HOST", updatedAt: "2026-09-13T10:00:00Z" },
          { name: "SENTRY_DSN", updatedAt: "2026-09-12T10:00:00Z" },
        ]);
      }
      if (args[0] === "api") {
        if (!options.workflow) throw new Error("gh api repos/o/shop/actions/workflows/matrix-build-deploy.yml failed (exit 1): gh: Not Found (HTTP 404)");
        return JSON.stringify({ html_url: "https://github.com/o/shop/actions/workflows/matrix-build-deploy.yml" });
      }
      if (args[0] === "run") {
        return JSON.stringify([
          {
            databaseId: 7,
            displayTitle: "Merge pull request #5",
            status: "completed",
            conclusion: "success",
            headBranch: "main",
            headSha: "abc1234def",
            event: "push",
            createdAt: "2026-09-13T11:00:00Z",
            url: "https://github.com/o/shop/actions/runs/7",
          },
        ]);
      }
      return "";
    };

  const shop = (githubRepo: string | null = "o/shop") => brain.createProject({ name: "Shop", localPath: "/srv/ai-projects/shop", githubRepo });

  it("shows which secrets are set, the workflow and its runs, without secret values", async () => {
    const project = shop();
    const status = (await (await makeApp({ gh: fakeGh({ workflow: true }) })(`/api/projects/${project.id}/deploy`)).json()) as {
      workflow: { found: boolean };
      secrets: { name: string; set: boolean; required: boolean }[];
      runs: { id: number; conclusion: string }[];
    };
    expect(status.workflow.found).toBe(true);
    expect(status.secrets.find((s) => s.name === "SSH_HOST")).toMatchObject({ set: true, required: true });
    expect(status.secrets.find((s) => s.name === "SSH_PRIVATE_KEY")).toMatchObject({ set: false, required: true });
    expect(status.secrets.find((s) => s.name === "SENTRY_DSN")).toMatchObject({ set: true, required: false });
    expect(status.runs).toEqual([expect.objectContaining({ id: 7, conclusion: "success" })]);
    expect(calls.find((c) => c.args[0] === "run")?.args).toContain("matrix-build-deploy.yml");
  });

  it("does not ask for runs when the workflow is missing", async () => {
    const project = shop();
    const status = (await (await makeApp({ gh: fakeGh({ workflow: false }) })(`/api/projects/${project.id}/deploy`)).json()) as {
      workflow: { found: boolean };
      error: string | null;
    };
    expect(status).toMatchObject({ workflow: { found: false }, error: null });
    expect(calls.some((c) => c.args[0] === "run")).toBe(false);
  });

  it("sends a secret value on standard input only", async () => {
    const project = shop();
    const call = makeApp({ gh: fakeGh({ workflow: true }) });
    const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n";
    const response = await call(`/api/projects/${project.id}/deploy/secrets/ssh_private_key`, { ...json({ value: key }), method: "PUT" });
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ args: ["secret", "set", "SSH_PRIVATE_KEY", "--repo", "o/shop", "--app", "actions"], input: key }]);
    expect(JSON.stringify(await response.json())).not.toContain("abc");
  });

  it("rejects bad secret names and projects without a repository", async () => {
    const call = makeApp({ gh: fakeGh({ workflow: true }) });
    const project = shop();
    for (const name of ["GITHUB_TOKEN", "1KEY", "BAD-NAME"]) {
      expect((await call(`/api/projects/${project.id}/deploy/secrets/${name}`, { ...json({ value: "x" }), method: "PUT" })).status).toBe(400);
    }
    const local = brain.createProject({ name: "Local", localPath: "/srv/ai-projects/local" });
    const response = await call(`/api/projects/${local.id}/deploy/secrets/SSH_HOST`, { ...json({ value: "x" }), method: "PUT" });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/GitHub repository/);
    expect(calls).toHaveLength(0);
  });

  it("queues one workflow task at a time", async () => {
    const project = shop();
    const call = makeApp({ gh: fakeGh({ workflow: false }) });
    const first = await call(`/api/projects/${project.id}/deploy/setup`, { method: "POST" });
    expect(first.status).toBe(201);
    const task = (await first.json()) as { id: string; sessionId: string; prompt: string };
    expect(task.prompt).toMatch(/matrix-build-deploy\.yml/);
    expect(task.prompt).toMatch(/SSH_KNOWN_HOSTS/);
    expect(brain.getSession(task.sessionId)?.title).toBe("Deploy workflow");
    expect((await call(`/api/projects/${project.id}/deploy/setup`, { method: "POST" })).status).toBe(400);

    // Done, but its pull request is not merged yet: a second task would write the same file.
    brain.updateTask(task.id, { status: "done", prUrl: "https://github.com/o/shop/pull/12" });
    const open = await makeApp({ gh: fakeGh({ workflow: false, prState: "OPEN" }) })(`/api/projects/${project.id}/deploy/setup`, { method: "POST" });
    expect(open.status).toBe(400);
    expect(((await open.json()) as { error: string }).error).toMatch(/pull\/12/);
    const status = (await (await makeApp({ gh: fakeGh({ workflow: false, prState: "OPEN" }) })(`/api/projects/${project.id}/deploy`)).json()) as {
      setupTask: { prState: string };
    };
    expect(status.setupTask.prState).toBe("OPEN");

    const closed = makeApp({ gh: fakeGh({ workflow: false, prState: "CLOSED" }) });
    const again = (await (await closed(`/api/projects/${project.id}/deploy/setup`, { method: "POST" })).json()) as { sessionId: string };
    expect(again.sessionId).toBe(task.sessionId);
  });
});

describe("spending settings", () => {
  it("defaults to a $2 day and deepseek-v4-pro, validates, and saves both", async () => {
    const call = makeApp();
    expect(await (await call("/api/settings/spending")).json()).toMatchObject({
      dailyBudgetUsd: 2,
      escalationModel: { provider: "cheaperinference", model: "deepseek-v4-pro" },
      spentTodayUsd: 0,
    });
    const put = (body: unknown) => call("/api/settings/spending", { ...json(body), method: "PUT" });
    expect((await put({ dailyBudgetUsd: -1, escalationModel: null })).status).toBe(400);
    expect((await put({ dailyBudgetUsd: 5, escalationModel: { provider: "cheaperinference", model: "rm -rf /" } })).status).toBe(400);
    expect((await put({ dailyBudgetUsd: 5, escalationModel: { provider: "nobody", model: "glm-5.3" } })).status).toBe(400);
    const saved = await (await put({ dailyBudgetUsd: null, escalationModel: { provider: "cheaperinference", model: "glm-5.3" } })).json();
    expect(saved).toMatchObject({ dailyBudgetUsd: null, escalationModel: { provider: "cheaperinference", model: "glm-5.3" } });
    expect(brain.getAppSetting("dailyBudgetUsd", 2)).toBeNull();
  });
});

describe("model providers", () => {
  it("adds a provider with a hidden key, keeps the key on edit, and refuses to remove one in use", async () => {
    const call = makeApp();
    const post = await call("/api/providers", json({ name: "OpenAI", type: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk-proj-abcdefghijkl1234" }));
    expect(post.status).toBe(201);
    expect(await post.json()).toMatchObject({ id: "openai", hasKey: true, keyLast4: "1234" });
    const listed = await (await call("/api/providers")).text();
    expect(listed).not.toContain("abcdefghijkl");
    expect((JSON.parse(listed) as { presets: { id: string }[] }).presets.map((p) => p.id)).toContain("anthropic");

    const patched = await call("/api/providers/openai", { ...json({ name: "OpenAI work", apiKey: "" }), method: "PATCH" });
    expect(await patched.json()).toMatchObject({ name: "OpenAI work", hasKey: true, keyLast4: "1234" });
    expect((await call("/api/providers", json({ name: "Bad", type: "openai", baseUrl: "ftp://example.com" }))).status).toBe(400);
    expect((await call("/api/providers/nobody", { method: "DELETE" })).status).toBe(404);

    const role = (body: unknown) => call("/api/settings/roles/coder", { ...json(body), method: "PUT" });
    expect((await role({ provider: "missing", model: "m" })).status).toBe(400);
    expect((await role({ provider: "openai", model: "gpt-5.4" })).status).toBe(200);
    const blocked = await call("/api/providers/openai", { method: "DELETE" });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: expect.stringContaining("coder role") });
  });

  it("lists a provider's models and prices every model in use", async () => {
    const call = makeApp();
    expect(await (await call("/api/providers/cheaperinference/models")).json()).toMatchObject({ models: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }] });
    expect(await (await call("/api/providers/cheaperinference/test", { method: "POST" })).json()).toEqual({ ok: true, models: 2 });

    type Row = { model: string; source: string | null; price: unknown };
    const rows = ((await (await call("/api/prices")).json()) as { models: Row[] }).models;
    expect(rows.find((r) => r.model === "deepseek-v4-flash")).toMatchObject({ source: "provider", price: { input: 0.1, output: 0.2 } });
    expect(rows.find((r) => r.model === "glm-5.3-flash")).toMatchObject({ source: null, price: null });

    const put = await call("/api/prices", { ...json({ provider: "cheaperinference", model: "glm-5.3-flash", input: 0.1, output: 0.35 }), method: "PUT" });
    const saved = ((await put.json()) as { models: Row[] }).models;
    expect(saved.find((r) => r.model === "glm-5.3-flash")).toMatchObject({ source: "manual", price: { input: 0.1, output: 0.35, cacheRead: 0.1 } });
    const cleared = ((await (await call("/api/prices?provider=cheaperinference&model=glm-5.3-flash", { method: "DELETE" })).json()) as { models: Row[] }).models;
    expect(cleared.find((r) => r.model === "glm-5.3-flash")).toMatchObject({ source: null });
  });
});

describe("app check settings", () => {
  it("accepts only local app addresses and clears empty values", async () => {
    const call = makeApp();
    const project = brain.createProject({ name: "Shop", localPath: "/srv/ai-projects/shop" });
    const patch = (body: unknown) => call(`/api/projects/${project.id}`, { ...json(body), method: "PATCH" });
    expect((await patch({ appUrl: "http://169.254.169.254/" })).status).toBe(400);
    expect(await (await patch({ startCmd: "npm run dev -- --port {port}", appUrl: "http://127.0.0.1:{port}/" })).json()).toMatchObject({
      startCmd: "npm run dev -- --port {port}",
      appUrl: "http://127.0.0.1:{port}/",
    });
    expect(await (await patch({ startCmd: "", appUrl: "" })).json()).toMatchObject({ startCmd: null, appUrl: null });
  });
});
