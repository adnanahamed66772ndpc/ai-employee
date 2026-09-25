import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "@ai-employee/git";
import { prepareProjectsDir, prepareWorktree, processInGroup, protectCheckout } from "./workspace.ts";

// No such user exists, so `sudo -u` fails and the agent can never write: the tests check the server's own changes.
const NO_AGENT = "ai-employee-no-such-user";
const mode = (path: string) => statSync(path).mode & 0o7777;
const group = (path: string) => statSync(path).gid;

let root: string;
let ownGroup: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "ai-employee-workspace-"));
  ownGroup = (await runCommand("id", ["-gn"], root)).trim();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(process.platform !== "linux")("workspace permissions", () => {
  it("tells whether this process is in a group", async () => {
    expect(await processInGroup(ownGroup)).toBe(true);
    const mine = new Set(process.getgroups!());
    const other = (await runCommand("getent", ["group"], root))
      .split("\n")
      .map((line) => line.split(":"))
      .find((fields) => fields[0] && !mine.has(Number(fields[2])));
    if (other) expect(await processInGroup(other[0]!)).toBe(false);
  });

  it("closes the projects folder and makes the worktrees folder traversable only", async () => {
    const projects = join(root, "projects");
    const worktrees = join(projects, ".worktrees");
    mkdirSync(worktrees, { recursive: true });
    chmodSync(projects, 0o777);
    chmodSync(worktrees, 0o777);
    await prepareProjectsDir(projects, worktrees, ownGroup);
    expect(mode(projects) & 0o022).toBe(0);
    expect(mode(worktrees)).toBe(0o2755);
  });

  it("takes write access away in a checkout without following symlinks out of it", async () => {
    const checkout = join(root, "shop");
    const outside = join(root, "outside.txt");
    mkdirSync(join(checkout, "src"), { recursive: true });
    mkdirSync(join(checkout, ".git", "objects"), { recursive: true });
    writeFileSync(join(checkout, "src", "app.js"), "");
    writeFileSync(join(checkout, ".git", "config"), "");
    writeFileSync(outside, "");
    symlinkSync(outside, join(checkout, "src", "link-to-outside"));
    for (const folder of [checkout, join(checkout, "src")]) chmodSync(folder, 0o777);
    for (const file of [join(checkout, "src", "app.js"), join(checkout, ".git", "config"), outside]) chmodSync(file, 0o666);
    chmodSync(join(checkout, ".git", "objects"), 0o2777);

    await protectCheckout(checkout, NO_AGENT);

    expect(mode(join(checkout, "src", "app.js"))).toBe(0o644);
    expect(mode(join(checkout, "src"))).toBe(0o755);
    expect(mode(join(checkout, ".git", "config"))).toBe(0o644);
    // The .git folders lose their setgid bit, so files the server writes there keep its own group.
    expect(mode(join(checkout, ".git", "objects")) & 0o2000).toBe(0);
    expect(mode(outside)).toBe(0o666);
  });

  it("opens a new worktree to the shared group, and fails when the agent still cannot write it", async () => {
    const worktree = join(root, "task-1");
    mkdirSync(join(worktree, "src"), { recursive: true });
    writeFileSync(join(worktree, "src", "app.js"), "");
    chmodSync(join(worktree, "src", "app.js"), 0o600);
    chmodSync(join(worktree, "src"), 0o700);

    await expect(prepareWorktree(worktree, NO_AGENT, ownGroup)).rejects.toThrow(/cannot write the task worktree/);
    expect(mode(join(worktree, "src", "app.js")) & 0o060).toBe(0o060);
    expect(mode(join(worktree, "src")) & 0o2070).toBe(0o2070);
    expect(group(join(worktree, "src", "app.js"))).toBe(process.getegid!());
  });
});
