import { spawn, type ChildProcess } from "node:child_process";

export interface CheckResult {
  ok: boolean;
  exitCode: number | null;
  /** Last part of combined stdout/stderr. */
  output: string;
}

export interface CaptureResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function start(command: string, cwd: string, runner?: string[]): ChildProcess {
  const env = { ...process.env, CI: "1", GIT_TERMINAL_PROMPT: "0" };
  return runner?.length
    ? spawn(runner[0]!, [...runner.slice(1), cwd, command], { env, windowsHide: true })
    : spawn(command, { cwd, shell: true, windowsHide: true, env });
}

/** Stops the child on timeout or abort; returns a cleanup function. */
function supervise(child: ChildProcess, timeoutMs: number, signal: AbortSignal, onTimeout: () => void): () => void {
  const kill = () => {
    if (child.pid === undefined || child.exitCode !== null) return;
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      return;
    }
    // sudo relays SIGTERM to the command; escalate if it does not stop.
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 5000).unref();
  };
  const timer = setTimeout(() => {
    onTimeout();
    kill();
  }, timeoutMs);
  signal.addEventListener("abort", kill, { once: true });
  return () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", kill);
  };
}

/**
 * Runs a project's own test/lint command in its folder. Agent-written code executes here, so on a server
 * `runner` (e.g. `sudo -n -u aiagent /usr/local/bin/ai-agent-run`) runs it as the unprivileged agent user;
 * the runner receives the folder and the command as its last two arguments.
 */
export function runShellCommand(command: string, cwd: string, timeoutMs: number, signal: AbortSignal, runner?: string[]): Promise<CheckResult> {
  return new Promise((resolve) => {
    const child = start(command, cwd, runner);
    let output = "";
    const append = (data: Buffer) => {
      output += data.toString("utf8");
      if (output.length > 200_000) output = output.slice(-100_000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const done = supervise(child, timeoutMs, signal, () => {
      output += `\n[timed out after ${Math.round(timeoutMs / 1000)}s]`;
    });
    const finish = (result: CheckResult) => {
      done();
      resolve(result);
    };
    child.on("error", (error) => finish({ ok: false, exitCode: null, output: error.message }));
    child.on("close", (code) => finish({ ok: code === 0, exitCode: code, output: output.slice(-8000) }));
  });
}

/**
 * Like runShellCommand, but keeps stdout whole for commands whose output is data (for example a file read as the
 * agent user). Output past `maxBytes` fails the command instead of being cut.
 */
export function runCapture(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  runner?: string[],
  maxBytes = 4_000_000,
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    const child = start(command, cwd, runner);
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let overflow = false;
    child.stdout?.on("data", (data: Buffer) => {
      size += data.length;
      if (size > maxBytes) {
        overflow = true;
        child.kill();
        return;
      }
      chunks.push(data);
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString("utf8")).slice(-8000);
    });

    const done = supervise(child, timeoutMs, signal, () => {
      stderr += `\n[timed out after ${Math.round(timeoutMs / 1000)}s]`;
    });
    const finish = (result: CaptureResult) => {
      done();
      resolve(result);
    };
    child.on("error", (error) => finish({ ok: false, exitCode: null, stdout: "", stderr: error.message }));
    child.on("close", (code) =>
      finish({
        ok: code === 0 && !overflow,
        exitCode: code,
        stdout: Buffer.concat(chunks).toString("utf8"),
        stderr: overflow ? `output is larger than ${maxBytes} bytes` : stderr,
      }),
    );
  });
}
