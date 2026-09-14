import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Project, Usage } from "@ai-employee/brain";
import { runCapture, runShellCommand } from "./checks.ts";
import type { CriticFinding } from "./critics.ts";
import { fromAnthropicUsage, usageCost, type AnthropicUsage, type PriceBook } from "./llm.ts";
import { isLocalProvider, type GatewayProvider } from "./providers.ts";
import type { ModelRef } from "./spending.ts";

/*
 * The visual check for UI changes: start the task's app, open it on a phone and a desktop screen, and let a vision model
 * judge the screenshots, next to free checks (the page loads, no uncaught errors, no serious accessibility violations).
 * The app and the browser run as the agent user, because both execute agent-written code.
 */

export interface AppCommand {
  command: string;
  url: string;
  source: string;
}

export interface Screenshot {
  name: string;
  width: number;
  height: number;
  jpegBase64: string;
}

export interface AxeViolation {
  id: string;
  impact: string;
  help: string;
  nodes: number;
  target: string;
}

export interface Capture {
  shots: Screenshot[];
  consoleErrors: string[];
  axe: AxeViolation[];
  loadError: string | null;
}

/** Local addresses only, so a project setting can never point the browser at another machine. `{port}` is filled in. */
export const APP_URL = /^http:\/\/(127\.0\.0\.1|localhost)(:(\d{2,5}|\{port\}))?(\/[\w\-./?=&%#~+]*)?$/;

/** The app command from project settings (`{port}` is replaced), or one guessed from package.json scripts. */
export function appCommand(project: Pick<Project, "startCmd" | "appUrl">, packageJson: string | null, port: number): AppCommand | null {
  const fill = (text: string) => text.replaceAll("{port}", String(port));
  if (project.startCmd?.trim() && project.appUrl?.trim() && APP_URL.test(project.appUrl.trim())) {
    return { command: `PORT=${port} ${fill(project.startCmd.trim())}`, url: fill(project.appUrl.trim()), source: "project settings" };
  }
  if (!packageJson) return null;
  let scripts: Record<string, unknown> = {};
  try {
    scripts = (JSON.parse(packageJson) as { scripts?: Record<string, unknown> }).scripts ?? {};
  } catch {
    return null;
  }
  const url = `http://127.0.0.1:${port}/`;
  const dev = typeof scripts.dev === "string" ? scripts.dev : null;
  if (dev) {
    if (/\bvite\b/.test(dev)) return { command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`, url, source: "package.json scripts.dev (Vite)" };
    if (/\bnext\b/.test(dev)) return { command: `npm run dev -- -p ${port} -H 127.0.0.1`, url, source: "package.json scripts.dev (Next.js)" };
    if (/\bastro\b/.test(dev)) return { command: `npm run dev -- --host 127.0.0.1 --port ${port}`, url, source: "package.json scripts.dev (Astro)" };
    return { command: `PORT=${port} HOST=127.0.0.1 npm run dev`, url, source: "package.json scripts.dev" };
  }
  if (typeof scripts.start === "string") return { command: `PORT=${port} HOST=127.0.0.1 npm start`, url, source: "package.json scripts.start" };
  return null;
}

/** Findings nobody has to guess about: the page did not load, it threw errors, or axe found serious violations. */
export function captureFindings(capture: Capture, url: string): CriticFinding[] {
  const findings: CriticFinding[] = [];
  if (capture.loadError) {
    findings.push({ file: url, problem: `The app did not load: ${capture.loadError}`, scenario: "A user opening the page sees an error or nothing at all.", confidence: 100 });
  }
  if (capture.consoleErrors.length) {
    findings.push({
      file: url,
      problem: `The page logs errors in the browser: ${capture.consoleErrors.slice(0, 5).join(" | ")}`,
      scenario: "Part of the page may not work or not render for users.",
      confidence: 90,
    });
  }
  for (const violation of capture.axe.slice(0, 3)) {
    findings.push({
      file: url,
      problem: `Accessibility (${violation.impact}): ${violation.help} (axe rule ${violation.id}, ${violation.nodes} element${violation.nodes === 1 ? "" : "s"}, first: ${violation.target})`,
      scenario: "People using a screen reader or keyboard, or with low vision, cannot use this part.",
      confidence: 90,
    });
  }
  return findings;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("No free port"))));
    });
  });
}

export interface VisionReply {
  text: string;
  usage: Usage;
  model: string;
}

export type VisionReviewer = (model: ModelRef, prompt: string, shots: Screenshot[], signal: AbortSignal) => Promise<VisionReply>;

/**
 * Sends the screenshots to a vision model at its provider with the provider's key, and prices the call. Anthropic
 * takes image blocks on the Messages API; OpenAI-compatible and Gemini providers take image URLs on chat completions.
 */
export function gatewayVision(providers: { gateway(id: string): GatewayProvider | null }, prices: Pick<PriceBook, "get">, fetchImpl: typeof fetch = fetch): VisionReviewer {
  return async (ref, prompt, shots, signal) => {
    const provider = providers.gateway(ref.provider);
    if (!provider) throw new Error(`The screenshot model's provider "${ref.provider}" is not set up`);
    if (!provider.apiKey && !isLocalProvider(provider.baseUrl)) throw new Error(`No API key is set for ${provider.name}, so screenshots cannot be reviewed`);
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
    const label = `${provider.id}/${ref.model}`;

    if (provider.type === "anthropic") {
      const res = await fetchImpl(`${provider.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...(provider.apiKey ? { "x-api-key": provider.apiKey } : {}) },
        body: JSON.stringify({
          model: ref.model,
          max_tokens: 2_000,
          messages: [
            {
              role: "user",
              content: [...shots.map((shot) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: shot.jpegBase64 } })), { type: "text", text: prompt }],
            },
          ],
        }),
        signal: timeout,
      });
      if (!res.ok) throw new Error(`The vision model ${label} answered HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as { content?: { type?: string; text?: string }[]; usage?: AnthropicUsage };
      const text = (body.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
      return { text, usage: usageCost(fromAnthropicUsage(body.usage ?? {}), await prices.get(provider.id, ref.model)), model: label };
    }

    const content = [
      { type: "text", text: prompt },
      ...shots.map((shot) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${shot.jpegBase64}` } })),
    ];
    const res = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}) },
      body: JSON.stringify({ model: ref.model, messages: [{ role: "user", content }], max_tokens: 2_000 }),
      signal: timeout,
    });
    if (!res.ok) throw new Error(`The vision model ${label} answered HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: Parameters<typeof usageCost>[0] };
    return { text: body.choices?.[0]?.message?.content ?? "", usage: usageCost(body.usage ?? {}, await prices.get(provider.id, ref.model)), model: label };
  };
}

const RUNNER_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "visual-runner.mjs");

/**
 * The browser script and its two packages, where the agent user can read them. Without an agent user the script runs
 * from the repository, which finds the packages in node_modules.
 */
export function prepareVisualTools(rootDir: string, projectsDir: string, agentUser: string | undefined): string {
  if (!agentUser) return RUNNER_SOURCE;
  const modules = join(rootDir, "node_modules");
  const version = (name: string) => (JSON.parse(readFileSync(join(modules, name, "package.json"), "utf8")) as { version: string }).version;
  // Any change to one of the three files gets a fresh folder, so the agent user never runs a stale copy.
  const target = join(projectsDir, ".tools", `visual-${version("playwright-core")}-axe-${version("axe-core")}-${statSync(RUNNER_SOURCE).mtimeMs.toFixed(0)}`);
  const runner = join(target, "visual-runner.mjs");
  if (existsSync(runner)) return runner;
  mkdirSync(join(target, "node_modules"), { recursive: true });
  cpSync(join(modules, "playwright-core"), join(target, "node_modules", "playwright-core"), { recursive: true });
  cpSync(join(modules, "axe-core", "axe.min.js"), join(target, "axe.min.js"));
  cpSync(RUNNER_SOURCE, runner);
  openUp(join(projectsDir, ".tools"));
  return runner;
}

/** Readable (and folders enterable) by everyone, writable only by the server. */
function openUp(path: string): void {
  const stat = statSync(path);
  chmodSync(path, stat.isDirectory() ? 0o755 : 0o644);
  if (stat.isDirectory()) for (const entry of readdirSync(path)) openUp(join(path, entry));
}

/** What the pipeline needs for the visual check; tests pass a fake. */
export interface VisualTools {
  capture(options: { command: AppCommand; cwd: string; signal: AbortSignal; runner?: string[]; log: (message: string) => void }): Promise<CaptureResult>;
  review: VisionReviewer;
}

export function visualTools(browser: { runnerScript: string; chromePath?: string }, review: VisionReviewer): VisualTools {
  return { capture: (options) => captureApp({ ...options, ...browser }), review };
}

export interface CaptureOptions {
  command: AppCommand;
  cwd: string;
  signal: AbortSignal;
  runner?: string[];
  runnerScript: string;
  chromePath?: string;
  log: (message: string) => void;
}

export type CaptureResult = { ok: true; capture: Capture } | { ok: false; reason: string };

const START_TIMEOUT_MS = 90_000;
const CAPTURE_TIMEOUT_MS = 150_000;

/** Starts the app, waits for its URL to answer, captures it, and stops the app again. */
export async function captureApp(options: CaptureOptions): Promise<CaptureResult> {
  const { command, cwd, signal, runner } = options;
  const port = Number(new URL(command.url).port) || 80;
  let output = "";
  const child: ChildProcess = runner?.length
    ? spawn(runner[0]!, [...runner.slice(1), cwd, `exec ${command.command}`], { env: { ...process.env, CI: "1" }, windowsHide: true })
    : spawn(command.command, { cwd, shell: true, windowsHide: true, detached: process.platform !== "win32", env: { ...process.env, CI: "1" } });
  const keep = (data: Buffer) => (output = (output + data.toString("utf8")).slice(-4_000));
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  let exited = false;
  child.on("exit", () => (exited = true));

  try {
    const started = Date.now();
    for (;;) {
      if (signal.aborted) return { ok: false, reason: "The task was stopped" };
      if (exited) return { ok: false, reason: `The app stopped before it answered at ${command.url}. Its last output:\n${output.trim() || "(none)"}` };
      if (Date.now() - started > START_TIMEOUT_MS) return { ok: false, reason: `The app did not answer at ${command.url} within ${START_TIMEOUT_MS / 1000}s. Its last output:\n${output.trim() || "(none)"}` };
      try {
        await fetch(command.url, { signal: AbortSignal.timeout(3_000), redirect: "manual" });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    const script = `node "${options.runnerScript}" "${command.url}"${options.chromePath ? ` "${options.chromePath}"` : ""}`;
    const result = await runCapture(script, cwd, CAPTURE_TIMEOUT_MS, signal, runner, 12_000_000);
    if (!result.ok) return { ok: false, reason: `The browser could not open the app: ${result.stderr.trim().split("\n").slice(-3).join(" ") || `exit ${result.exitCode}`}` };
    const line = result.stdout.trim().split("\n").at(-1) ?? "";
    try {
      return { ok: true, capture: JSON.parse(line) as Capture };
    } catch {
      return { ok: false, reason: `The browser check printed something unexpected: ${line.slice(0, 200) || "(nothing)"}` };
    }
  } finally {
    stopApp(child, port, cwd, runner, options.log);
  }
}

function stopApp(child: ChildProcess, port: number, cwd: string, runner: string[] | undefined, log: (message: string) => void): void {
  try {
    if (runner?.length || !child.pid) child.kill("SIGTERM");
    // The shell's children (the dev server itself) must go too: a process group on Unix, the whole tree on Windows.
    else if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  // Dev servers often leave a child process holding the port; end whatever the agent user still runs there.
  if (runner?.length) {
    void runShellCommand(`fuser -k -TERM ${port}/tcp >/dev/null 2>&1 || true`, cwd, 15_000, new AbortController().signal, runner).then((r) => {
      if (!r.ok) log(`could not stop the app on port ${port}: ${r.output}`);
    });
  }
}
