import { execFile } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`${command} failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`);
  }
}

/** Runs a program without a shell so arguments are never interpreted. */
export function runCommand(file: string, args: string[], cwd: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { cwd, windowsHide: true, maxBuffer: 50 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof error.code === "number" ? error.code : null;
          reject(new CommandError(`${file} ${args.join(" ")}`, code, stdout, stderr));
        } else {
          resolve(stdout);
        }
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

// Agents can write the work tree, so the server's git calls never run repository hooks or fsmonitor.
const SAFE_GIT_CONFIG = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

/**
 * A linked worktree addressed by its administrative git directory inside the main repository's `.git`.
 * Agents can rewrite the worktree's own `.git` file (to point git at a directory whose config they control),
 * so the server never reads it: every call passes `--git-dir` and `--work-tree` explicitly.
 */
export interface Worktree {
  path: string;
  gitDir: string;
}

/** A plain repository folder (trusted, not writable by agents) or a task worktree. */
export type GitTarget = string | Worktree;

function git(target: GitTarget, ...args: string[]): Promise<string> {
  return gitWithInput(target, undefined, ...args);
}

function gitWithInput(target: GitTarget, input: string | undefined, ...args: string[]): Promise<string> {
  if (typeof target === "string") return runCommand("git", [...SAFE_GIT_CONFIG, ...args], target, input);
  return runCommand("git", [...SAFE_GIT_CONFIG, `--git-dir=${target.gitDir}`, `--work-tree=${target.path}`, ...args], target.path, input);
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, "rev-parse", "--is-inside-work-tree")).trim() === "true";
  } catch {
    return false;
  }
}

export async function currentBranch(cwd: string): Promise<string> {
  return (await git(cwd, "rev-parse", "--abbrev-ref", "HEAD")).trim();
}

export async function isClean(target: GitTarget): Promise<boolean> {
  return (await git(target, "status", "--porcelain")).trim() === "";
}

export async function headSha(target: GitTarget): Promise<string> {
  return (await git(target, "rev-parse", "HEAD")).trim();
}

export async function hasCommits(cwd: string): Promise<boolean> {
  try {
    await git(cwd, "rev-parse", "--verify", "HEAD");
    return true;
  } catch {
    return false;
  }
}

export function branchName(taskId: string, prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `ai/${taskId.slice(0, 8)}${slug ? `-${slug}` : ""}`;
}

/** Creates and switches to `branch` from `base`. Refuses to run on a dirty working tree. */
export async function createBranch(cwd: string, branch: string, base: string): Promise<void> {
  if (!(await isClean(cwd))) throw new Error("Working tree has uncommitted changes; commit or stash them first.");
  await git(cwd, "switch", "-c", branch, base);
}

/**
 * Checks out a new `branch` from `base` into `path` as a linked worktree. The main checkout is untouched,
 * so it may be dirty and several tasks can work on one repository at the same time.
 */
export async function addWorktree(repo: string, path: string, branch: string, base: string): Promise<Worktree> {
  return linkedWorktree(repo, path, ["-b", branch, path, base]);
}

/** Checks out an existing branch into `path`, for example to merge into it. */
export async function checkoutWorktree(repo: string, path: string, branch: string): Promise<Worktree> {
  return linkedWorktree(repo, path, [path, branch]);
}

/** A detached checkout of one commit, for agents that only read. */
export async function detachedWorktree(repo: string, path: string, sha: string): Promise<Worktree> {
  return linkedWorktree(repo, path, ["--detach", path, sha]);
}

async function linkedWorktree(repo: string, path: string, args: string[]): Promise<Worktree> {
  const commonDir = resolve(repo, (await git(repo, "rev-parse", "--git-common-dir")).trim());
  await git(repo, "worktree", "add", "--quiet", ...args);
  const worktree = { path: resolve(path), gitDir: join(commonDir, "worktrees", basename(path)) };
  // git names the administrative directory after the folder; make sure it did (no name collision).
  const reported = resolve(path, (await git(worktree.path, "rev-parse", "--git-dir")).trim());
  if (reported !== worktree.gitDir) {
    await removeWorktree(repo, worktree).catch(() => {});
    throw new Error(`git created the worktree metadata at ${reported}, expected ${worktree.gitDir}`);
  }
  return worktree;
}

/** The worktree handle for a folder created by addWorktree, without reading the folder's `.git` file. */
export async function openWorktree(repo: string, path: string): Promise<Worktree> {
  const commonDir = resolve(repo, (await git(repo, "rev-parse", "--git-common-dir")).trim());
  return { path: resolve(path), gitDir: join(commonDir, "worktrees", basename(path)) };
}

/** Deletes the worktree folder (including uncommitted changes) and its metadata; the branch is kept. */
export async function removeWorktree(repo: string, worktree: Worktree): Promise<void> {
  try {
    await git(repo, "worktree", "remove", "--force", worktree.path);
  } catch {
    // git refuses when the folder's `.git` file was changed. The folder is only a checkout; delete it directly
    // (rmSync does not follow symlinks) and let prune drop the metadata.
    rmSync(worktree.path, { recursive: true, force: true });
  } finally {
    await git(repo, "worktree", "prune").catch(() => {});
  }
}

/** Stages everything so new files show up, then returns the diff and stat against `base`. */
export async function diffAgainst(target: GitTarget, base: string): Promise<{ diff: string; stat: string }> {
  await git(target, "add", "-A");
  const [diff, stat] = await Promise.all([
    git(target, "diff", "--no-ext-diff", "--cached", base),
    git(target, "diff", "--no-ext-diff", "--cached", "--stat", base),
  ]);
  return { diff, stat };
}

/** Paths changed against `base`, including new files (stages everything first). */
export async function changedFiles(target: GitTarget, base: string): Promise<string[]> {
  await git(target, "add", "-A");
  return (await git(target, "diff", "--no-ext-diff", "--cached", "--name-only", "-z", base)).split("\0").filter(Boolean);
}

/** The staged diff against `base` for some paths only, with extra context lines around each change. */
export async function diffPaths(target: GitTarget, base: string, paths: string[], contextLines = 8): Promise<string> {
  if (paths.length === 0) return "";
  // Literal pathspecs, so a file name can never be read as pathspec magic.
  return git(target, "diff", "--no-ext-diff", "--cached", `-U${contextLines}`, base, "--", ...paths.map((p) => `:(literal)${p}`));
}

export interface StagedChange {
  path: string;
  /** A added, M modified, D deleted, T type changed. */
  status: string;
  /** Index mode, e.g. 100644; empty for a deleted file. */
  mode: string;
  blob: string | null;
  size: number;
}

/**
 * Files changed against `base` with their staged blob, mode and size (stages everything first). Everything comes from
 * git's index and object store, so a symlink in the worktree is reported as a link, never followed.
 */
export async function stagedChanges(target: GitTarget, base: string): Promise<StagedChange[]> {
  await git(target, "add", "-A");
  const fields = (await git(target, "diff", "--no-ext-diff", "--cached", "--no-renames", "--name-status", "-z", base)).split("\0").filter(Boolean);
  const changes: { status: string; path: string }[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) changes.push({ status: fields[i]!, path: fields[i + 1]! });
  if (changes.length === 0) return [];

  // The whole index rather than pathspecs: an added node_modules folder would not fit on a command line.
  const index = new Map<string, { mode: string; blob: string }>();
  for (const entry of (await git(target, "ls-files", "-s", "-z")).split("\0")) {
    const match = /^(\d+) ([0-9a-f]+) \d+\t([\s\S]+)$/.exec(entry);
    if (match) index.set(match[3]!, { mode: match[1]!, blob: match[2]! });
  }
  const blobs = [...new Set(changes.map((c) => index.get(c.path)?.blob).filter((b): b is string => Boolean(b)))];
  const sizes = new Map<string, number>();
  if (blobs.length) {
    for (const line of (await gitWithInput(target, `${blobs.join("\n")}\n`, "cat-file", "--batch-check")).split("\n")) {
      const [sha, type, size] = line.split(" ");
      if (sha && type === "blob") sizes.set(sha, Number(size));
    }
  }
  return changes.map((c) => {
    const entry = c.status === "D" ? undefined : index.get(c.path);
    return { path: c.path, status: c.status, mode: entry?.mode ?? "", blob: entry?.blob ?? null, size: entry ? (sizes.get(entry.blob) ?? 0) : 0 };
  });
}

export function readBlob(target: GitTarget, blob: string): Promise<string> {
  return git(target, "cat-file", "blob", blob);
}

/** A file's content at a commit, or null when it does not exist there. */
export async function showFile(target: GitTarget, rev: string, path: string): Promise<string | null> {
  try {
    return await git(target, "cat-file", "blob", `${rev}:${path}`);
  } catch {
    return null;
  }
}

/** Whether a file or folder exists at a commit. */
export async function pathExists(target: GitTarget, rev: string, path: string): Promise<boolean> {
  try {
    return (await git(target, "ls-tree", "--name-only", rev, "--", `:(literal)${path.replace(/\/$/, "")}`)).trim() !== "";
  } catch {
    return false;
  }
}

/** Whether .gitignore rules ignore `path`. */
export async function isIgnored(target: GitTarget, path: string): Promise<boolean> {
  try {
    await git(target, "check-ignore", "-q", "--", path);
    return true;
  } catch {
    return false;
  }
}

export async function commitAll(target: GitTarget, message: string): Promise<string> {
  await git(target, "add", "-A");
  await git(target, "commit", "--no-verify", "-m", message);
  return headSha(target);
}

/** Commits only `paths`, leaving any other staged or unstaged changes in the checkout alone. */
export async function commitPaths(target: GitTarget, message: string, paths: string[]): Promise<string> {
  await git(target, "add", "--", ...paths);
  await git(target, "commit", "--no-verify", "-m", message, "--", ...paths);
  return headSha(target);
}

/** Creates a repository on branch main with a README as its first commit. */
export async function initRepository(dir: string, readme: string): Promise<string> {
  await git(dir, "init", "-b", "main");
  writeFileSync(join(dir, "README.md"), readme);
  return commitAll(dir, "chore: initial commit");
}

export async function hasCommitsSince(target: GitTarget, base: string): Promise<boolean> {
  return (await git(target, "rev-list", "--count", `${base}..HEAD`)).trim() !== "0";
}

const literal = (path: string) => `:(literal)${path}`;

async function exitsOne<T>(run: () => Promise<T>, whenOne: T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CommandError && error.exitCode === 1) return whenOne;
    throw error;
  }
}

/** The commit a ref points to, or null when it does not exist. */
export async function resolveCommit(target: GitTarget, ref: string): Promise<string | null> {
  try {
    return (await git(target, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`)).trim() || null;
  } catch {
    return null;
  }
}

export async function isAncestor(target: GitTarget, ancestor: string, descendant: string): Promise<boolean> {
  return exitsOne(async () => (await git(target, "merge-base", "--is-ancestor", ancestor, descendant), true), false);
}

export interface StartPoint {
  /** Commit to start from. */
  sha: string;
  /** Where it came from: the local branch, or origin's copy when that is newer. */
  source: "local" | "origin";
  /** Both sides have commits the other lacks; work starts from the local branch. */
  diverged: boolean;
  /** Whether origin could be fetched. */
  fetched: boolean;
}

/**
 * The newest commit to start work on `branch` from. Fetches origin first and uses its copy when it is ahead of the local
 * branch. The local branch itself never moves: it may be checked out in the owner's checkout.
 */
export async function freshStartPoint(repo: string, branch: string): Promise<StartPoint> {
  let fetched = false;
  try {
    await git(repo, "remote", "get-url", "origin");
    await git(repo, "fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
    fetched = true;
  } catch {
    // no origin, offline, or the branch is not on origin yet
  }
  const local = await resolveCommit(repo, `refs/heads/${branch}`);
  const remote = fetched ? await resolveCommit(repo, `refs/remotes/origin/${branch}`) : null;
  if (!local && !remote) throw new Error(`The branch ${branch} does not exist`);
  if (!remote || remote === local) return { sha: local!, source: "local", diverged: false, fetched };
  if (!local || (await isAncestor(repo, local, remote))) return { sha: remote, source: "origin", diverged: false, fetched };
  return { sha: local, source: "local", diverged: !(await isAncestor(repo, remote, local)), fetched };
}

/** Creates `branch` at a commit without checking it out. */
export async function createBranchAt(repo: string, branch: string, sha: string): Promise<void> {
  await git(repo, "branch", "--no-track", branch, sha);
}

/** Moves `branch` to `newSha`, but only if it still points at `expectedSha`, so a concurrent change is never lost. */
export async function moveBranch(repo: string, branch: string, newSha: string, expectedSha: string): Promise<void> {
  await git(repo, "update-ref", `refs/heads/${branch}`, newSha, expectedSha);
}

/**
 * Merges `ref` into the worktree's branch. Returns [] when it merged cleanly (the merge commit is made), or the paths
 * left in conflict, with the merge still in progress.
 */
export async function mergeInto(worktree: Worktree, ref: string, message: string): Promise<string[]> {
  try {
    await git(worktree, "merge", "--no-ff", "--no-edit", "-m", message, ref);
    return [];
  } catch (error) {
    const conflicted = (await git(worktree, "diff", "--name-only", "--diff-filter=U", "-z")).split("\0").filter(Boolean);
    if (conflicted.length === 0) throw error;
    return conflicted;
  }
}

/** Files among `paths` that still contain conflict markers once staged. */
export async function conflictMarkers(worktree: Worktree, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  await git(worktree, "add", "-A");
  const out = await exitsOne(() => git(worktree, "grep", "--cached", "-l", "-E", "^(<<<<<<<|>>>>>>>)( |$)", "--", ...paths.map(literal)), "");
  return out.split("\n").map((line) => line.trim()).filter(Boolean);
}

export async function abortMerge(worktree: Worktree): Promise<void> {
  await git(worktree, "merge", "--abort").catch(() => {});
}

/** Puts the worktree's branch and files back at `sha`, dropping a merge in progress or already committed. */
export async function resetTo(worktree: Worktree, sha: string): Promise<void> {
  await abortMerge(worktree);
  await git(worktree, "reset", "--hard", "--quiet", sha);
}

/** Commits between `base` and `branch`, oldest first, as "sha subject". */
export async function commitLog(repo: string, base: string, branch: string): Promise<string[]> {
  return (await git(repo, "log", "--reverse", "--format=%h %s", `${base}..${branch}`)).split("\n").filter(Boolean);
}

export async function diffStat(repo: string, base: string, branch: string): Promise<string> {
  return git(repo, "diff", "--no-ext-diff", "--stat", `${base}...${branch}`);
}

/** "OPEN", "MERGED" or "CLOSED" for a pull request URL, or null when GitHub cannot tell. */
export async function pullRequestState(cwd: string, url: string): Promise<"OPEN" | "MERGED" | "CLOSED" | null> {
  try {
    const state = (await runCommand("gh", ["pr", "view", url, "--json", "state", "-q", ".state"], cwd)).trim();
    return state === "OPEN" || state === "MERGED" || state === "CLOSED" ? state : null;
  } catch {
    return null;
  }
}

export async function pushBranch(cwd: string, branch: string): Promise<void> {
  await git(cwd, "push", "-u", "origin", branch);
}

export async function createPullRequest(
  cwd: string,
  pr: { base: string; head: string; title: string; body: string; repo?: string | null },
): Promise<string> {
  const args = ["pr", "create", "--base", pr.base, "--head", pr.head, "--title", pr.title, "--body-file", "-"];
  if (pr.repo) args.push("--repo", pr.repo);
  const out = await runCommand("gh", args, cwd, pr.body);
  const url = out.trim().split(/\r?\n/).pop() ?? "";
  if (!/^https:\/\//.test(url)) throw new Error(`gh pr create did not return a URL: ${out}`);
  return url;
}
