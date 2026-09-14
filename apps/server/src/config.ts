import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  rootDir: string;
  dataDir: string;
  brainPath: string;
  dshHome: string;
  dshSettingsPath: string;
  /** The copy of settings.yaml the agent user's DeepSeek Harness reads (a link to it); unset without an agent user. */
  dshSharedSettingsPath: string | undefined;
  dashboardDist: string;
  port: number;
  cheaperInferenceBaseUrl: string;
  cheaperInferenceKey: string | undefined;
  /** Unprivileged Linux user the agents run as; unset runs them as the server's own user. */
  agentUser: string | undefined;
  /** Group shared by the server user and the agent user for task worktrees. */
  agentGroup: string;
  dshLauncher: string[] | undefined;
  checkRunner: string[] | undefined;
  /** Public dashboard URL behind the reverse proxy, e.g. https://ai.example.com. Requires a password. */
  publicUrl: URL | undefined;
  /** Password hash + session secret written by `npm run set-password`. */
  authFile: string;
  /** Nightly brain copies. */
  backupDir: string;
  /** Where projects are cloned or created; the only folder the dashboard can browse. */
  projectsDir: string;
  /** One git worktree per task lives here; the only place agents can write. */
  worktreesDir: string;
  /** How many tasks may run at the same time. */
  maxParallelTasks: number;
  telegramBotToken: string | undefined;
  telegramChatId: string | undefined;
  /** Chrome for the visual check; unset lets Playwright look for an installed Chrome. */
  chromePath: string | undefined;
}

export function loadConfig(): Config {
  const rootDir = fileURLToPath(new URL("../../../", import.meta.url));
  const dataDir = process.env.AI_EMPLOYEE_DATA_DIR ?? join(rootDir, "data");
  const dshHome = join(rootDir, ".dsh-home");
  const agentUser = process.env.AI_EMPLOYEE_AGENT_USER || undefined;
  const projectsDir = resolve(process.env.AI_EMPLOYEE_PROJECTS_DIR || (agentUser ? "/srv/ai-projects" : join(homedir(), "ai-projects")));
  mkdirSync(dataDir, { recursive: true });
  return {
    rootDir,
    dataDir,
    brainPath: join(dataDir, "brain.db"),
    dshHome,
    dshSettingsPath: join(dshHome, "settings.yaml"),
    dshSharedSettingsPath: agentUser ? join(projectsDir, ".tools", "dsh", "settings.yaml") : undefined,
    dashboardDist: join(rootDir, "apps", "dashboard", "dist"),
    // 7717 sits outside the port ranges Windows commonly reserves for Hyper-V/WSL.
    port: Number(process.env.AI_EMPLOYEE_PORT || 7717),
    cheaperInferenceBaseUrl: "https://api.cheaperinference.com/v1",
    cheaperInferenceKey: process.env.CHEAPERINFERENCE_API_KEY || undefined,
    agentUser,
    agentGroup: validGroup(process.env.AI_EMPLOYEE_AGENT_GROUP || "aiwork"),
    // Launchers installed by scripts/vps/setup-agent-user.sh
    dshLauncher: agentUser ? ["sudo", "-n", "-u", agentUser, "/usr/local/bin/ai-agent-dsh"] : undefined,
    checkRunner: agentUser ? ["sudo", "-n", "-u", agentUser, "/usr/local/bin/ai-agent-run"] : undefined,
    publicUrl: process.env.AI_EMPLOYEE_PUBLIC_URL ? new URL(process.env.AI_EMPLOYEE_PUBLIC_URL) : undefined,
    authFile: join(dataDir, "auth.json"),
    backupDir: resolve(process.env.AI_EMPLOYEE_BACKUP_DIR || join(dataDir, "backups")),
    projectsDir,
    worktreesDir: join(projectsDir, ".worktrees"),
    maxParallelTasks: Math.min(8, Math.max(1, Math.floor(Number(process.env.AI_EMPLOYEE_MAX_TASKS || 1)) || 1)),
    telegramBotToken: process.env.AI_EMPLOYEE_TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: process.env.AI_EMPLOYEE_TELEGRAM_CHAT_ID || undefined,
    chromePath: process.env.AI_EMPLOYEE_CHROME || ["/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p)),
  };
}

export const hasDshSettings = (config: Config) => existsSync(config.dshSettingsPath);

/** The group name is interpolated into a shell command, so only allow plain Linux group names. */
function validGroup(name: string): string {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(name)) throw new Error(`Invalid AI_EMPLOYEE_AGENT_GROUP: ${name}`);
  return name;
}
