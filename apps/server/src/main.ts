import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Brain } from "@ai-employee/brain";
import { AgentPool } from "./agents.ts";
import { loadAuthFile } from "./auth.ts";
import { createApp } from "./api.ts";
import { hasDshSettings, loadConfig } from "./config.ts";
import { PriceBook } from "./llm.ts";
import { Maintenance } from "./maintenance.ts";
import { gatewayVision, prepareVisualTools, visualTools, type VisualTools } from "./visual.ts";
import { McpTokens } from "./mcp.ts";
import { TelegramNotifier, watchForNotifications } from "./notify.ts";
import { NpmRegistry } from "./packages.ts";
import { Orchestrator } from "./pipeline.ts";
import { prepareProjectsDir, processInGroup } from "./workspace.ts";

const log = (message: string) => console.log(`${new Date().toLocaleTimeString()} ${message}`);

const config = loadConfig();
const auth = loadAuthFile(config.authFile);
if (config.publicUrl && !auth) {
  log(`AI_EMPLOYEE_PUBLIC_URL is ${config.publicUrl.origin} but no dashboard password is set. Run: npm run set-password`);
  process.exit(1);
}
if (!auth) log("dashboard login is off (no password set); keep this server private to 127.0.0.1");
const brain = new Brain(config.brainPath);
const interrupted = brain.failInterruptedTasks();
if (interrupted.length) log(`marked ${interrupted.length} interrupted task(s) as failed`);

if (config.agentUser) {
  if (!(await processInGroup(config.agentGroup).catch(() => false))) {
    // Changing modes outside the group would also make the kernel drop the folders' setgid bit, so skip that too.
    log(
      `error: this process is not in the "${config.agentGroup}" group, so tasks cannot share their worktree with "${config.agentUser}". ` +
        "Restart the process manager from a new login, for example: pm2 kill && pm2 resurrect",
    );
  } else {
    await prepareProjectsDir(config.projectsDir, config.worktreesDir, config.agentGroup).catch((error: Error) =>
      log(`warning: could not lock down ${config.projectsDir}: ${error.message}`),
    );
  }
  log(`agents and checks run as the "${config.agentUser}" user`);
}

const tokens = new McpTokens();
const pool = new AgentPool(config, log);
const prices = new PriceBook(config.cheaperInferenceBaseUrl, config.cheaperInferenceKey);
let visual: VisualTools | undefined;
try {
  const runnerScript = prepareVisualTools(config.rootDir, config.projectsDir, config.agentUser);
  visual = visualTools({ runnerScript, chromePath: config.chromePath }, gatewayVision(config.cheaperInferenceBaseUrl, config.cheaperInferenceKey, prices));
} catch (error) {
  log(`warning: the visual check is off, its browser tools could not be prepared: ${(error as Error).message}`);
}

const orchestrator = new Orchestrator({
  brain,
  pool,
  tokens,
  mcpUrl: `http://127.0.0.1:${config.port}/mcp`,
  log,
  worktreesDir: config.worktreesDir,
  agentUser: config.agentUser,
  agentGroup: config.agentGroup,
  checkRunner: config.checkRunner,
  maxParallelTasks: config.maxParallelTasks,
  visual,
  packages: new NpmRegistry(),
});
await orchestrator.manager.recover(interrupted);

const notifier = new TelegramNotifier(config.telegramBotToken, config.telegramChatId);
watchForNotifications(brain, notifier, { publicUrl: config.publicUrl, log });
if (notifier.configured) log("Telegram notifications are on");

const maintenance = new Maintenance({ brain, orchestrator, backupDir: config.backupDir, log });

const app = createApp({
  brain,
  orchestrator,
  tokens,
  pool,
  config,
  auth,
  notifier,
  maintenance,
  llm: {
    baseUrl: config.cheaperInferenceBaseUrl,
    apiKey: config.cheaperInferenceKey,
    prices,
    resolveRun: (body) => orchestrator.resolveRun(body),
    refusal: (taskId) => orchestrator.refusal(taskId),
    record: (runId, usage) => orchestrator.recordUsage(runId, usage),
    log,
  },
});

if (existsSync(config.dashboardDist)) {
  const indexHtml = readFileSync(join(config.dashboardDist, "index.html"), "utf8");
  app.use("/*", serveStatic({ root: relative(process.cwd(), config.dashboardDist) }));
  app.get("*", (c) => c.html(indexHtml));
}

if (!config.cheaperInferenceKey) log("warning: CHEAPERINFERENCE_API_KEY is not set in .env.local; agents cannot call models");
if (!hasDshSettings(config)) log("warning: .dsh-home/settings.yaml is missing; run: npm run setup:dsh");

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: config.port }, (info) => {
  log(`AI Employee is running at http://127.0.0.1:${info.port}`);
  log(`brain: ${config.brainPath}`);
  if (config.maxParallelTasks > 1) log(`up to ${config.maxParallelTasks} tasks run at the same time`);
});
server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE" || error.code === "EACCES") {
    log(`cannot listen on 127.0.0.1:${config.port} (${error.code}): another process is using the port, or the OS reserved it.`);
    log("stop the other process, or choose another port with AI_EMPLOYEE_PORT in .env.local");
  } else {
    log(`server error: ${error.message}`);
  }
  void pool.stopAll().finally(() => process.exit(1));
});
orchestrator.start();
maintenance.start();

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  log("shutting down");
  server.close();
  maintenance.stop();
  await pool.stopAll();
  brain.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
