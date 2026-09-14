import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "@ai-employee/git";

/*
 * Agents write only inside per-task worktrees under `<projects>/.worktrees`. The projects folder, every project
 * checkout and its `.git` stay closed to the agent user: code running as that user (a test, for example) could
 * otherwise swap a checkout's `.git` for one whose config makes the server's own git commands run programs.
 * All of this is Linux only and a no-op without a separate agent user.
 */

async function agentCanWrite(agentUser: string, path: string): Promise<boolean> {
  try {
    await runCommand("sudo", ["-n", "-u", agentUser, "test", "-w", path], "/");
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether this process belongs to `group`. Group membership is fixed when a process starts, so a process manager
 * daemon started before the server user joined the group lacks it, and so does every server it restarts.
 */
export async function processInGroup(group: string): Promise<boolean> {
  if (process.platform === "win32" || !process.getgroups) return true;
  const gid = Number((await runCommand("getent", ["group", group], "/")).trim().split(":")[2]);
  return process.getgroups().includes(gid);
}

/** The projects folder is not writable by the agent group; the worktrees folder inside it is traversable only. */
export async function prepareProjectsDir(projectsDir: string, worktreesDir: string, sharedGroup: string): Promise<void> {
  if (process.platform === "win32") return;
  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(worktreesDir, { recursive: true });
  await runCommand("chmod", ["g-w,o-w", projectsDir], projectsDir);
  await runCommand("chgrp", [sharedGroup, worktreesDir], projectsDir);
  await runCommand("chmod", ["2755", worktreesDir], projectsDir);
}

/**
 * Removes group and other write access from the server user's own files in a project checkout, keeps `.git` in the
 * server user's primary group, and confirms the agent user can no longer write the checkout or its `.git`.
 */
export async function protectCheckout(localPath: string, agentUser: string): Promise<void> {
  if (process.platform === "win32") return;
  const me = (await runCommand("id", ["-un"], localPath)).trim();
  const ownGroup = (await runCommand("id", ["-gn"], localPath)).trim();
  const gitDir = join(localPath, ".git");
  // Files and folders only: chmod and chgrp follow symlinks, and a cloned repository may contain links to the
  // server user's own files elsewhere.
  const realEntries = ["(", "-type", "f", "-o", "-type", "d", ")"];
  await runCommand("find", [localPath, ...realEntries, "-user", me, "-perm", "/022", "-exec", "chmod", "g-w,o-w", "{}", "+"], localPath);
  await runCommand("find", [gitDir, ...realEntries, "-user", me, "!", "-group", ownGroup, "-exec", "chgrp", ownGroup, "{}", "+"], localPath);
  await runCommand("find", [gitDir, "-type", "d", "-perm", "-2000", "-exec", "chmod", "g-s", "{}", "+"], localPath);

  for (const path of [localPath, gitDir]) {
    if (await agentCanWrite(agentUser, path)) {
      throw new Error(
        `The agent user "${agentUser}" can still write ${path}, probably because it owns files there. Ask the server administrator to run: sudo chown -R ${me}:${ownGroup} ${path}`,
      );
    }
  }
}

/** Opens a freshly created task worktree to the agent user (shared group, group-writable, setgid folders). */
export async function prepareWorktree(path: string, agentUser: string, sharedGroup: string): Promise<void> {
  if (process.platform === "win32") return;
  await runCommand("chgrp", ["-R", sharedGroup, path], path);
  await runCommand("chmod", ["-R", "g+rwX", path], path);
  await runCommand("find", [path, "-type", "d", "-exec", "chmod", "g+s", "{}", "+"], path);
  if (!(await agentCanWrite(agentUser, path))) {
    throw new Error(`The agent user "${agentUser}" cannot write the task worktree ${path}. Run scripts/vps/setup-agent-user.sh again.`);
  }
}
