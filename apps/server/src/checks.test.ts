import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCapture, runShellCommand } from "./checks.ts";

const never = () => new AbortController().signal;
let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "ai-employee-checks-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// The commands are POSIX shell, like the ones projects configure on the server.
describe.skipIf(process.platform === "win32")("runShellCommand", () => {
  it("runs in the folder and reports output and the exit code", async () => {
    expect(await runShellCommand("pwd; echo out; echo err >&2", dir, 10_000, never())).toEqual({ ok: true, exitCode: 0, output: `${dir}\nout\nerr\n` });
    expect(await runShellCommand("echo broken; exit 3", dir, 10_000, never())).toEqual({ ok: false, exitCode: 3, output: "broken\n" });
  });

  it("hands the folder and the command to a runner as its last two arguments", async () => {
    // Like /usr/local/bin/ai-agent-run: cd into the folder, then run the command with bash.
    const runner = ["bash", "-c", 'cd -- "$1" && exec bash -c "$2"', "ai-agent-run"];
    expect(await runShellCommand("pwd", dir, 10_000, never(), runner)).toMatchObject({ ok: true, output: `${dir}\n` });
  });

  it("stops a command at its time limit", async () => {
    const started = Date.now();
    const result = await runShellCommand("sleep 30", dir, 1_000, never());
    expect(result.ok).toBe(false);
    expect(result.output).toContain("[timed out after 1s]");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("stops a command when the task is cancelled", async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 200);
    const started = Date.now();
    expect((await runShellCommand("sleep 30", dir, 60_000, abort.signal)).ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("finishes when the command leaves a background process holding its output", async () => {
    const started = Date.now();
    const result = await runShellCommand("sleep 60 & echo $!", dir, 60_000, never());
    try {
      expect(result).toMatchObject({ ok: true, exitCode: 0 });
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      process.kill(Number(result.output.trim()));
    }
  });
});

describe.skipIf(process.platform === "win32")("runCapture", () => {
  it("keeps stdout whole and stderr apart", async () => {
    const result = await runCapture("printf 'a\\nb'; echo warn >&2", dir, 10_000, never());
    expect(result).toEqual({ ok: true, exitCode: 0, stdout: "a\nb", stderr: "warn\n" });
  });

  it("fails output larger than the limit instead of cutting it", async () => {
    const result = await runCapture("head -c 5000 /dev/zero", dir, 10_000, never(), undefined, 1_000);
    expect(result.ok).toBe(false);
    expect(result.stderr).toBe("output is larger than 1000 bytes");
  });
});
