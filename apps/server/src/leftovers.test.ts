import { describe, expect, it } from "vitest";
import { leftoverProcesses, parseProcessList, stopLeftovers, type ProcessInfo } from "./leftovers.ts";

const AGENT = 1001;
const SERVER = 1000;

// A server with its DeepSeek Harness running through sudo (with sudo's pty monitor), a check in progress, the agent
// user's systemd manager, a zombie, and three leftovers: a dev server and a nohup job whose shells exited, and a user
// service.
const PS = `
    1     0     0 S /sbin/init
  500     1  1000 S node /home/server/ai-employee/node_modules/.bin/tsx src/main.ts
  510   500     0 S sudo -n -u aiagent /usr/local/bin/ai-agent-dsh workspace-write
  511   510     0 S sudo -n -u aiagent /usr/local/bin/ai-agent-dsh workspace-write
  512   511  1001 S node /home/aiagent/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile acp
  513   512  1001 S bash -c npm test
  520   500     0 S /usr/bin/sudo -n -u aiagent /usr/local/bin/ai-agent-run /srv/ai-projects/.worktrees/t1 npm run lint
  521   520  1001 S bash -c npm run lint
  600     1  1001 S /lib/systemd/systemd --user
  601   600  1001 S (sd-pam)
  700     1  1001 S node node_modules/.bin/vite --port 5173
  701   700  1001 S esbuild --service=0.25.0 --ping
  710     1  1001 S sleep 100000
  720   600  1001 S /usr/bin/python3 -m http.server 8000
  800     1  1000 S -bash
  810     1  1001 Z [sleep] <defunct>
`;

describe("leftoverProcesses", () => {
  it("reads ps output", () => {
    const list = parseProcessList(PS);
    expect(list).toHaveLength(16);
    expect(list.find((p) => p.pid === 512)).toEqual({
      pid: 512,
      ppid: 511,
      uid: AGENT,
      stat: "S",
      args: "node /home/aiagent/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile acp",
    });
  });

  it("finds the agent user's processes that no sudo launcher runs, keeping its systemd manager and skipping zombies", () => {
    expect(leftoverProcesses(parseProcessList(PS), AGENT).sort((a, b) => a - b)).toEqual([700, 701, 710, 720]);
  });

  it("never picks another user's processes", () => {
    expect(leftoverProcesses(parseProcessList(PS), SERVER)).toEqual([500, 800]);
    const list = parseProcessList(PS);
    expect(leftoverProcesses(list, 4242)).toEqual([]);
  });

  it("does not trust a sudo that is not root's, and survives a parent loop", () => {
    const list: ProcessInfo[] = [
      { pid: 10, ppid: 1, uid: AGENT, stat: "S", args: "sudo fake" },
      { pid: 11, ppid: 10, uid: AGENT, stat: "S", args: "sleep 1" },
      { pid: 20, ppid: 21, uid: AGENT, stat: "S", args: "a" },
      { pid: 21, ppid: 20, uid: AGENT, stat: "S", args: "b" },
    ];
    expect(leftoverProcesses(list, AGENT)).toEqual([10, 11, 20, 21]);
  });
});

describe("stopLeftovers", () => {
  it("sends SIGTERM, then SIGKILL to what is still left", async () => {
    let listing = parseProcessList(PS);
    const commands: string[] = [];
    const count = await stopLeftovers({
      agentUser: "aiagent",
      agentUid: async () => AGENT,
      listProcesses: async () => listing,
      runAsAgent: async (command) => {
        commands.push(command);
        // The vite server and its esbuild child stop on SIGTERM; the others ignore it.
        if (command.startsWith("kill -TERM")) listing = listing.filter((p) => p.pid !== 700 && p.pid !== 701);
      },
      graceMs: 1,
    });
    expect(count).toBe(4);
    expect(commands).toEqual(["kill -TERM 700 701 710 720 2>/dev/null; true", "kill -KILL 710 720 2>/dev/null; true"]);
  });

  it("does nothing without leftovers", async () => {
    const commands: string[] = [];
    const count = await stopLeftovers({
      agentUser: "aiagent",
      agentUid: async () => AGENT,
      listProcesses: async () => parseProcessList(PS).filter((p) => ![700, 701, 710, 720].includes(p.pid)),
      runAsAgent: async (command) => void commands.push(command),
    });
    expect(count).toBe(0);
    expect(commands).toEqual([]);
  });

  it("refuses to act for root", async () => {
    await expect(
      stopLeftovers({ agentUser: "root", agentUid: async () => 0, listProcesses: async () => [], runAsAgent: async () => {} }),
    ).rejects.toThrow(/Refusing/);
  });
});
