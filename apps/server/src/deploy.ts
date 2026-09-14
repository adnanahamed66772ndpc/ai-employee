import type { Brain, Project, Task } from "@ai-employee/brain";
import { deployWorkflow } from "./prompts.ts";

/** Deploying a managed project: GitHub Actions secrets set from the dashboard and the matrix-build-deploy workflow's runs. */

export const DEPLOY_WORKFLOW = "matrix-build-deploy.yml";
export const DEPLOY_SESSION_TITLE = "Deploy workflow";

export interface DeploySecretInfo {
  name: string;
  required: boolean;
  hint: string;
}

/** The secrets the generated workflow reads. The workflow prompt and the dashboard checklist both use this list. */
export const DEPLOY_SECRETS: DeploySecretInfo[] = [
  { name: "SSH_HOST", required: true, hint: "The server address, for example 203.0.113.10 or app.example.com" },
  { name: "SSH_USER", required: true, hint: "The user the deploy logs in as, for example deploy. Use a user without sudo." },
  {
    name: "SSH_PRIVATE_KEY",
    required: true,
    hint: "A key made only for deploys: ssh-keygen -t ed25519 -f deploy_key -N \"\". Paste deploy_key here and add deploy_key.pub to the user's ~/.ssh/authorized_keys on the server.",
  },
  {
    name: "SSH_KNOWN_HOSTS",
    required: true,
    hint: "The server's host keys, so a deploy is never sent to a fake server. Get them with: ssh-keyscan -p 22 203.0.113.10",
  },
  { name: "DEPLOY_PATH", required: true, hint: "The folder on the server the app is copied to, for example /home/deploy/apps/shop" },
  { name: "SSH_PORT", required: false, hint: "Only if SSH does not listen on port 22" },
];

// GitHub's rules: letters, digits and underscores, not starting with a digit or GITHUB_. Names are stored upper-case.
export const SECRET_NAME = /^(?!GITHUB_)[A-Z_][A-Z0-9_]{0,99}$/;
/** GitHub rejects secret values over 48 KB. */
export const SECRET_VALUE_MAX = 48 * 1024;

export type Gh = (args: string[], input?: string) => Promise<string>;

export class DeployError extends Error {}

export interface SecretEntry {
  name: string;
  updatedAt: string;
}

export interface WorkflowRun {
  id: number;
  title: string;
  status: string;
  conclusion: string;
  branch: string;
  sha: string;
  event: string;
  createdAt: string;
  url: string;
}

export interface DeployStatus {
  repo: string | null;
  workflow: { file: string; found: boolean; url: string | null };
  secrets: (SecretEntry & { required: boolean; hint: string; set: boolean })[];
  runs: WorkflowRun[];
  setupTask: { id: string; sessionId: string; status: Task["status"]; prUrl: string | null; prState: string | null } | null;
  error: string | null;
}

const repoOf = (project: Project): string => {
  if (!project.githubRepo) throw new DeployError("Connect a GitHub repository in Project settings first");
  return project.githubRepo;
};

const ghMessage = (error: unknown) => (error as Error).message.replace(/^gh .*? failed \(exit [^)]*\): /, "");

export async function listSecrets(gh: Gh, repo: string): Promise<SecretEntry[]> {
  return JSON.parse(await gh(["secret", "list", "--repo", repo, "--json", "name,updatedAt"])) as SecretEntry[];
}

/** The value goes to gh on standard input, never as an argument, so it cannot show up in the process list or an error. */
export async function setSecret(gh: Gh, project: Project, name: string, value: string): Promise<void> {
  if (!SECRET_NAME.test(name)) throw new DeployError("Use capital letters, digits and underscores for the name, not starting with a digit or GITHUB_");
  if (!value) throw new DeployError("The value is empty");
  if (Buffer.byteLength(value) > SECRET_VALUE_MAX) throw new DeployError("GitHub only stores secrets up to 48 KB");
  try {
    await gh(["secret", "set", name, "--repo", repoOf(project), "--app", "actions"], value);
  } catch (error) {
    if (error instanceof DeployError) throw error;
    throw new DeployError(`GitHub did not save ${name}: ${ghMessage(error)}`);
  }
}

export async function deleteSecret(gh: Gh, project: Project, name: string): Promise<void> {
  if (!SECRET_NAME.test(name)) throw new DeployError("That is not a secret name");
  try {
    await gh(["secret", "delete", name, "--repo", repoOf(project), "--app", "actions"]);
  } catch (error) {
    if (error instanceof DeployError) throw error;
    throw new DeployError(`GitHub did not delete ${name}: ${ghMessage(error)}`);
  }
}

async function findWorkflow(gh: Gh, repo: string): Promise<string | null> {
  try {
    const workflow = JSON.parse(await gh(["api", `repos/${repo}/actions/workflows/${DEPLOY_WORKFLOW}`])) as { html_url?: string };
    return workflow.html_url ?? `https://github.com/${repo}/actions`;
  } catch (error) {
    if (/HTTP 404|Not Found/.test((error as Error).message)) return null;
    throw error;
  }
}

async function listRuns(gh: Gh, repo: string): Promise<WorkflowRun[]> {
  const fields = "databaseId,displayTitle,status,conclusion,headBranch,headSha,event,createdAt,url";
  const runs = JSON.parse(await gh(["run", "list", "--repo", repo, "--workflow", DEPLOY_WORKFLOW, "--limit", "10", "--json", fields])) as {
    databaseId: number;
    displayTitle: string;
    status: string;
    conclusion: string;
    headBranch: string;
    headSha: string;
    event: string;
    createdAt: string;
    url: string;
  }[];
  return runs.map((r) => ({
    id: r.databaseId,
    title: r.displayTitle,
    status: r.status,
    conclusion: r.conclusion,
    branch: r.headBranch,
    sha: r.headSha,
    event: r.event,
    createdAt: r.createdAt,
    url: r.url,
  }));
}

/** The newest task from "Set up the deploy workflow", so the page can link to it instead of offering a second one. */
function latestSetupTask(brain: Brain, project: Project): DeployStatus["setupTask"] {
  const tasks = brain
    .listSessions(project.id)
    .filter((s) => s.title === DEPLOY_SESSION_TITLE)
    .flatMap((s) => brain.listTasks(s.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const task = tasks.at(-1);
  return task ? { id: task.id, sessionId: task.sessionId, status: task.status, prUrl: task.prUrl, prState: null } : null;
}

export async function deployStatus(gh: Gh, brain: Brain, project: Project): Promise<DeployStatus> {
  const status: DeployStatus = {
    repo: project.githubRepo,
    workflow: { file: DEPLOY_WORKFLOW, found: false, url: null },
    secrets: DEPLOY_SECRETS.map((s) => ({ ...s, set: false, updatedAt: "" })),
    runs: [],
    setupTask: latestSetupTask(brain, project),
    error: null,
  };
  if (!project.githubRepo) {
    status.error = "Connect a GitHub repository in Project settings first";
    return status;
  }
  try {
    const [saved, workflowUrl] = await Promise.all([listSecrets(gh, project.githubRepo), findWorkflow(gh, project.githubRepo)]);
    const byName = new Map(saved.map((s) => [s.name, s]));
    status.secrets = [
      ...DEPLOY_SECRETS.map((s) => ({ ...s, set: byName.has(s.name), updatedAt: byName.get(s.name)?.updatedAt ?? "" })),
      ...saved.filter((s) => !DEPLOY_SECRETS.some((d) => d.name === s.name)).map((s) => ({ ...s, required: false, hint: "", set: true })),
    ];
    status.workflow = { file: DEPLOY_WORKFLOW, found: workflowUrl !== null, url: workflowUrl };
    if (workflowUrl) status.runs = await listRuns(gh, project.githubRepo);
    if (status.setupTask?.prUrl && !workflowUrl) status.setupTask.prState = await pullRequestState(gh, status.setupTask.prUrl);
  } catch (error) {
    status.error = `Could not read GitHub Actions for ${project.githubRepo}: ${ghMessage(error)}`;
  }
  return status;
}

async function pullRequestState(gh: Gh, url: string): Promise<string | null> {
  try {
    return (await gh(["pr", "view", url, "--json", "state", "-q", ".state"])).trim() || null;
  } catch {
    return null;
  }
}

const FINISHED: Task["status"][] = ["done", "rejected", "needs_human", "failed", "cancelled"];

/**
 * Queues a normal task that writes the workflow; it is planned, coded, reviewed, security-checked and pushed after approval.
 * A task that is still running, or whose pull request is still open, blocks a second one writing the same file.
 */
export async function queueWorkflowSetup(gh: Gh, brain: Brain, project: Project): Promise<Task> {
  repoOf(project);
  const latest = latestSetupTask(brain, project);
  if (latest && !FINISHED.includes(latest.status)) throw new DeployError("A deploy workflow task is already running for this project");
  if (latest?.prUrl && (await pullRequestState(gh, latest.prUrl)) === "OPEN") {
    throw new DeployError(`The deploy workflow is waiting in ${latest.prUrl}. Merge or close that pull request first.`);
  }
  const session = brain.listSessions(project.id).find((s) => s.title === DEPLOY_SESSION_TITLE) ?? brain.createSession(project.id, DEPLOY_SESSION_TITLE);
  return brain.createTask(session.id, deployWorkflow(project));
}
