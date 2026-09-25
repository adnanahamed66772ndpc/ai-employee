import { runCommand } from "@ai-employee/git";

/*
 * Processes the agent user leaves behind. Agent-written code can start a background process (`npm run dev &`, `nohup`,
 * a daemon) that outlives its command: once its shell exits, it is re-parented away from the server and keeps running,
 * for example calling the model gateway. The server starts every agent-user process through a `sudo` launcher, and
 * `sudo` waits for its command, so once no task runs, an agent-user process without a `sudo` ancestor is a leftover.
 * The agent user's systemd manager stays: lingering keeps its runtime folder, which the browser check needs.
 */

export interface ProcessInfo {
  pid: number;
  ppid: number;
  uid: number;
  /** ps state, e.g. S, R or Z (a zombie, already dead). */
  stat: string;
  args: string;
}

/** Parses `ps -e -ww -o pid=,ppid=,uid=,stat=,args=`. */
export function parseProcessList(text: string): ProcessInfo[] {
  const processes: ProcessInfo[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match) processes.push({ pid: Number(match[1]), ppid: Number(match[2]), uid: Number(match[3]), stat: match[4]!, args: match[5]!.trim() });
  }
  return processes;
}

const isSudo = (p: ProcessInfo) => p.uid === 0 && /^(\S*\/)?sudo(\s|$)/.test(p.args);
const isUserManager = (p: ProcessInfo) => /^(\S*\/)?systemd --user(\s|$)/.test(p.args) || p.args === "(sd-pam)";

/** The agent user's processes that no `sudo` launcher is running, apart from its systemd user manager. */
export function leftoverProcesses(processes: ProcessInfo[], agentUid: number): number[] {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const launched = (p: ProcessInfo): boolean => {
    const seen = new Set<number>();
    for (let parent = byPid.get(p.ppid); parent && !seen.has(parent.pid); parent = byPid.get(parent.ppid)) {
      if (isSudo(parent)) return true;
      seen.add(parent.pid);
    }
    return false;
  };
  // A zombie has already exited; only its parent can clear it.
  return processes.filter((p) => p.uid === agentUid && !p.stat.startsWith("Z") && !isUserManager(p) && !launched(p)).map((p) => p.pid);
}

export interface LeftoverDeps {
  agentUser: string;
  /** Runs a shell command as the agent user (the check runner); only the agent user can signal its own processes. */
  runAsAgent(command: string): Promise<unknown>;
  listProcesses?: () => Promise<ProcessInfo[]>;
  agentUid?: () => Promise<number>;
  /** How long leftovers get to exit after SIGTERM before SIGKILL. */
  graceMs?: number;
}

const psList = async () => parseProcessList(await runCommand("ps", ["-e", "-ww", "-o", "pid=,ppid=,uid=,stat=,args="], "/"));

/**
 * Stops the agent user's leftover processes: SIGTERM, then SIGKILL for whatever is still left after the grace period.
 * Call it only while no task runs, because a task's own background process (a dev server the Coder started) looks the
 * same. Returns how many leftovers were found.
 */
export async function stopLeftovers(deps: LeftoverDeps): Promise<number> {
  const uid = await (deps.agentUid ?? (async () => Number((await runCommand("id", ["-u", deps.agentUser], "/")).trim())))();
  if (!Number.isInteger(uid) || uid === 0) throw new Error(`Refusing to stop processes of ${deps.agentUser} (uid ${uid})`);
  const list = deps.listProcesses ?? psList;
  const found = leftoverProcesses(await list(), uid);
  if (found.length === 0) return 0;
  // Process ids are numbers from ps, so the command holds nothing but digits.
  await deps.runAsAgent(`kill -TERM ${found.join(" ")} 2>/dev/null; true`);
  await new Promise((resolve) => setTimeout(resolve, deps.graceMs ?? 3_000));
  const remaining = leftoverProcesses(await list(), uid);
  if (remaining.length) await deps.runAsAgent(`kill -KILL ${remaining.join(" ")} 2>/dev/null; true`);
  return found.length;
}
