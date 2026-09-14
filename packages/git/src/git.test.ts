import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addWorktree,
  commitLog,
  conflictMarkers,
  createBranchAt,
  freshStartPoint,
  isAncestor,
  mergeInto,
  moveBranch,
  resolveCommit,
  branchName,
  commitAll,
  createBranch,
  currentBranch,
  diffAgainst,
  hasCommitsSince,
  isClean,
  isGitRepo,
  openWorktree,
  removeWorktree,
  runCommand,
} from "./index.ts";

let repo: string;
beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "ai-employee-git-"));
  await runCommand("git", ["init", "-b", "main", "-q"], repo);
  await runCommand("git", ["config", "user.email", "test@example.com"], repo);
  await runCommand("git", ["config", "user.name", "Test"], repo);
  writeFileSync(join(repo, "a.txt"), "one\n");
  await commitAll(repo, "init");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

it("builds safe branch names", () => {
  expect(branchName("1234567890ab", "Fix the failing test! (auth)")).toBe("ai/12345678-fix-the-failing-test-auth");
  expect(branchName("1234567890ab", "  ")).toBe("ai/12345678");
});

it("branches, diffs new files and commits", async () => {
  expect(await isGitRepo(repo)).toBe(true);
  await createBranch(repo, "ai/test", "main");
  expect(await currentBranch(repo)).toBe("ai/test");

  writeFileSync(join(repo, "b.txt"), "new file\n");
  const { diff, stat } = await diffAgainst(repo, "main");
  expect(diff).toContain("+new file");
  expect(stat).toContain("b.txt");

  await commitAll(repo, "feat: add b");
  expect(await isClean(repo)).toBe(true);
  expect(await hasCommitsSince(repo, "main")).toBe(true);
});

it("refuses to branch from a dirty tree", async () => {
  writeFileSync(join(repo, "a.txt"), "changed\n");
  await expect(createBranch(repo, "ai/x", "main")).rejects.toThrow(/uncommitted/);
});

it("works in a worktree without trusting its .git file", async () => {
  const path = `${repo}-wt-task1`;
  try {
    const worktree = await addWorktree(repo, path, "ai/task1", "main");
    expect(await currentBranch(repo)).toBe("main");

    writeFileSync(join(path, "c.txt"), "from the agent\n");
    // An agent points the worktree's .git file somewhere else; the server still uses the real metadata.
    rmSync(join(path, ".git"));
    writeFileSync(join(path, ".git"), "gitdir: /nonexistent/evil\n");
    const { diff } = await diffAgainst(worktree, "main");
    expect(diff).toContain("+from the agent");
    const sha = await commitAll(worktree, "feat: add c");
    expect((await runCommand("git", ["rev-parse", "ai/task1"], repo)).trim()).toBe(sha);
    expect(await isClean(repo)).toBe(true);

    expect(await openWorktree(repo, path)).toEqual(worktree);
    await removeWorktree(repo, worktree);
    expect(existsSync(path)).toBe(false);
    expect(await hasCommitsSince(repo, "main")).toBe(false);
    expect((await runCommand("git", ["branch", "--list", "ai/task1"], repo)).trim()).toContain("ai/task1");
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("branches that build on each other", () => {
  let origin: string;
  let other: string;
  beforeEach(async () => {
    origin = mkdtempSync(join(tmpdir(), "ai-employee-origin-"));
    other = mkdtempSync(join(tmpdir(), "ai-employee-other-"));
    await runCommand("git", ["init", "--bare", "-q", "-b", "main"], origin);
    await runCommand("git", ["remote", "add", "origin", origin], repo);
    await runCommand("git", ["push", "-q", "origin", "main"], repo);
    await runCommand("git", ["clone", "-q", origin, other], tmpdir());
    await runCommand("git", ["config", "user.email", "other@example.com"], other);
    await runCommand("git", ["config", "user.name", "Other"], other);
  });
  afterEach(() => {
    rmSync(origin, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });

  const pushFromOther = async (file: string, content: string) => {
    writeFileSync(join(other, file), content);
    await commitAll(other, `change ${file}`);
    await runCommand("git", ["push", "-q", "origin", "main"], other);
    return (await runCommand("git", ["rev-parse", "HEAD"], other)).trim();
  };

  it("starts from origin when it is ahead, without moving the local branch", async () => {
    const local = (await runCommand("git", ["rev-parse", "main"], repo)).trim();
    expect(await freshStartPoint(repo, "main")).toMatchObject({ sha: local, source: "local", diverged: false, fetched: true });

    const remote = await pushFromOther("b.txt", "from GitHub\n");
    expect(await freshStartPoint(repo, "main")).toMatchObject({ sha: remote, source: "origin", diverged: false });
    expect((await runCommand("git", ["rev-parse", "main"], repo)).trim()).toBe(local);

    writeFileSync(join(repo, "c.txt"), "local only\n");
    const mine = await commitAll(repo, "local change");
    expect(await freshStartPoint(repo, "main")).toMatchObject({ sha: mine, source: "local", diverged: true });
  });

  it("moves a branch only from the commit the caller expects", async () => {
    const start = (await runCommand("git", ["rev-parse", "main"], repo)).trim();
    await createBranchAt(repo, "epic/one", start);
    writeFileSync(join(repo, "d.txt"), "task\n");
    const next = await commitAll(repo, "task");
    await moveBranch(repo, "epic/one", next, start);
    expect(await resolveCommit(repo, "epic/one")).toBe(next);
    await expect(moveBranch(repo, "epic/one", start, start)).rejects.toThrow();
    expect(await commitLog(repo, start, "epic/one")).toEqual([expect.stringMatching(/ task$/)]);
  });

  it("reports merge conflicts and leftover markers", async () => {
    await pushFromOther("a.txt", "theirs\n");
    await freshStartPoint(repo, "main");
    const path = `${repo}-wt-merge`;
    try {
      const worktree = await addWorktree(repo, path, "ai/merge", "main");
      writeFileSync(join(path, "a.txt"), "ours\n");
      await commitAll(worktree, "ours");
      expect(await mergeInto(worktree, "origin/main", "Merge origin/main")).toEqual(["a.txt"]);
      expect(await conflictMarkers(worktree, ["a.txt"])).toEqual(["a.txt"]);

      writeFileSync(join(path, "a.txt"), "ours and theirs\n");
      expect(await conflictMarkers(worktree, ["a.txt"])).toEqual([]);
      await commitAll(worktree, "Merge origin/main");
      expect(await isAncestor(repo, "origin/main", "ai/merge")).toBe(true);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });
});
