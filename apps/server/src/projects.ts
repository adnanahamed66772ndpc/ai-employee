import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Brain, Project } from "@ai-employee/brain";
import { commitPaths, currentBranch, hasCommits, initRepository, isGitRepo, runCommand } from "@ai-employee/git";
import type { Config } from "./config.ts";
import { AI_DIR, writeTemplate } from "./handoff.ts";
import { isInside } from "./policy.ts";
import { protectCheckout } from "./workspace.ts";

export class ProjectError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export interface ProjectOptions {
  name?: string;
  githubRepo?: string | null;
  defaultBranch?: string;
  setupCmd?: string | null;
  testCmd?: string | null;
  lintCmd?: string | null;
  taskBudgetUsd?: number | null;
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

// Both parts must start with a letter or digit so a value can never be read as a command-line flag
// (it is passed to gh as a positional argument) and can never be "." or "..".
export const REPO_NAME_PATTERN = /^[A-Za-z0-9][\w.-]{0,99}\/[A-Za-z0-9][\w.-]{0,99}$/;
const REPO = REPO_NAME_PATTERN;
const FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export const isRepoName = (value: string) => REPO.test(value);
export const isFolderName = (value: string) => FOLDER.test(value);
const blank = (value?: string | null) => (value?.trim() ? value.trim() : null);

export async function detectGithubRepo(localPath: string): Promise<string | null> {
  try {
    return (await runCommand("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], localPath)).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Commits the `.ai/` handoff template on the base branch when the project has no `.ai` yet. Only the new files are
 * committed, so other local changes stay as they are. Returns whether a commit was made.
 */
export async function addHandoffTemplate(localPath: string, name: string, branch: string): Promise<boolean> {
  if (!(await hasCommits(localPath)) || (await currentBranch(localPath)) !== branch) return false;
  if (writeTemplate(localPath, name, branch).length === 0) return false;
  await commitPaths(localPath, "docs(ai): add .ai handoff notes", [AI_DIR]);
  return true;
}

/** Adds an existing git repository as a project. */
export async function registerProject(brain: Brain, config: Config, folder: string, options: ProjectOptions): Promise<Project> {
  const localPath = resolve(folder);
  if (!existsSync(localPath) || !statSync(localPath).isDirectory()) throw new ProjectError(400, `Folder not found: ${localPath}`);
  if (!(await isGitRepo(localPath))) {
    throw new ProjectError(400, `${localPath} is not a git repository. Use "New repository" to create one.`);
  }
  if (brain.listProjects().some((p) => resolve(p.localPath).toLowerCase() === localPath.toLowerCase())) {
    throw new ProjectError(409, "This folder is already a project");
  }
  if (config.agentUser) {
    try {
      await protectCheckout(localPath, config.agentUser);
    } catch (error) {
      throw new ProjectError(400, (error as Error).message);
    }
  }
  const name = options.name?.trim() || basename(localPath);
  const defaultBranch = options.defaultBranch ?? (await currentBranch(localPath));
  try {
    await addHandoffTemplate(localPath, name, defaultBranch);
  } catch {
    // The first task creates the notes instead.
  }
  return brain.createProject({
    localPath,
    name,
    githubRepo: options.githubRepo ?? (await detectGithubRepo(localPath)),
    defaultBranch,
    setupCmd: blank(options.setupCmd),
    testCmd: blank(options.testCmd),
    lintCmd: blank(options.lintCmd),
    taskBudgetUsd: options.taskBudgetUsd ?? null,
  });
}

/** Lists folders inside the projects folder; nothing outside it can be browsed. */
export function browseProjectsDir(brain: Brain, config: Config, requested?: string): FolderListing {
  const root = config.projectsDir;
  if (!existsSync(root)) return { root, path: root, parent: null, entries: [] };
  const rootReal = realpathSync(root);
  const target = realpathSync(resolve(rootReal, requested ?? "."));
  if (!isInside(rootReal, target)) throw new ProjectError(400, "Only folders inside the projects folder can be opened");

  const projectByPath = new Map(brain.listProjects().map((p) => [resolve(p.localPath), p.id]));
  let names: string[];
  try {
    names = readdirSync(target, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
  } catch {
    throw new ProjectError(400, `The server cannot read ${target}`);
  }
  const entries = names
    .map((name) => {
      const path = join(target, name);
      return { name, path, isGitRepo: existsSync(join(path, ".git")), projectId: projectByPath.get(path) ?? null };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { root: rootReal, path: target, parent: target === rootReal ? null : dirname(target), entries };
}

export async function listGithubRepos(config: Config): Promise<GithubRepo[]> {
  try {
    const out = await runCommand("gh", ["repo", "list", "--limit", "200", "--json", "nameWithOwner,description,isPrivate,updatedAt"], config.rootDir);
    return (JSON.parse(out) as GithubRepo[]).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch (error) {
    throw new ProjectError(400, `Could not list GitHub repositories. Is the GitHub CLI signed in on the server? ${(error as Error).message}`);
  }
}

function targetFolder(config: Config, folder: string): string {
  if (!FOLDER.test(folder)) throw new ProjectError(400, "Use letters, numbers, dots, dashes or underscores for the folder name");
  mkdirSync(config.projectsDir, { recursive: true });
  const target = join(config.projectsDir, folder);
  if (existsSync(target)) throw new ProjectError(409, `${target} already exists. Choose it from "Choose a folder" or pick another name.`);
  return target;
}

export async function cloneProject(brain: Brain, config: Config, input: { repo: string; folder?: string } & ProjectOptions): Promise<Project> {
  if (!REPO.test(input.repo)) throw new ProjectError(400, "Use owner/name for the repository");
  const folder = input.folder?.trim() || input.repo.split("/")[1]!;
  const target = targetFolder(config, folder);
  try {
    await runCommand("gh", ["repo", "clone", input.repo, target, "--", "--quiet"], config.projectsDir);
  } catch (error) {
    throw new ProjectError(400, `Could not clone ${input.repo}: ${(error as Error).message}`);
  }
  return registerProject(brain, config, target, { ...input, name: input.name ?? folder, githubRepo: input.repo });
}

export async function createNewProject(
  brain: Brain,
  config: Config,
  input: { folder: string; visibility: "local" | "private" | "public"; description?: string } & ProjectOptions,
): Promise<Project> {
  const folder = input.folder.trim();
  const target = targetFolder(config, folder);
  mkdirSync(target, { recursive: true });
  const description = input.description?.trim();
  await initRepository(target, `# ${folder}\n${description ? `\n${description}\n` : ""}`);
  // Before the first push, so the new repository starts with its handoff notes.
  await addHandoffTemplate(target, input.name ?? folder, "main");

  let githubRepo: string | null = null;
  if (input.visibility !== "local") {
    try {
      const args = ["repo", "create", folder, `--${input.visibility}`, "--source", target, "--remote", "origin", "--push"];
      if (description) args.push("--description", description);
      await runCommand("gh", args, target);
      githubRepo = await detectGithubRepo(target);
    } catch (error) {
      throw new ProjectError(
        400,
        `The repository was created in ${target}, but creating it on GitHub failed: ${(error as Error).message}. Add the folder from "Choose a folder" and connect GitHub later.`,
      );
    }
  }
  return registerProject(brain, config, target, { ...input, name: input.name ?? folder, githubRepo });
}
