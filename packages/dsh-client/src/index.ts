import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import type {
  McpServer,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionConfigSelectOption,
  SessionUpdate,
  StopReason,
} from "@agentclientprotocol/sdk";

export type {
  McpServer,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionUpdate,
  StopReason,
};

/** dsh sandbox presets: planners/reviewers get read-only, the coder gets workspace-write. */
export type PermissionMode = "read-only" | "workspace-write";

export interface DshAgentOptions {
  dshHome: string;
  mode: PermissionMode;
  /** Working directory of the dsh process itself; each session still gets its own cwd. */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Command that starts `dsh --profile acp` as another OS user; the mode is appended. Defaults to running dsh directly. */
  launcher?: string[];
  onLog?: (line: string) => void;
  onExit?: (code: number | null) => void;
}

export interface SessionHandlers {
  onUpdate?: (update: SessionUpdate) => void;
  onPermission?: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
}

export interface OpenedSession {
  sessionId: string;
  configOptions: SessionConfigOption[];
}

export interface PromptResult {
  stopReason: StopReason;
  /** Concatenated assistant text streamed during this prompt. */
  text: string;
}

/** Locates the installed dsh CLI entry so it can be run with the current Node binary (no .cmd shim). */
export function findDshBin(from = dirname(fileURLToPath(import.meta.url))): string {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) throw new Error("Cannot find @deepseek-ai/dsh. Run npm install.");
  }
}

function flattenSelectOptions(options: unknown[]): SessionConfigSelectOption[] {
  return options.flatMap((o) =>
    o && typeof o === "object" && "options" in o
      ? ((o as { options: SessionConfigSelectOption[] }).options ?? [])
      : [o as SessionConfigSelectOption],
  );
}

/** One `dsh --profile acp` process speaking ACP over stdio; hosts many concurrent sessions. */
export class DshAgent {
  private readonly sessions = new Map<string, SessionHandlers & { text: string }>();
  private exited = false;
  private exitPromise!: Promise<never>;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly connection: acp.ClientConnection,
    readonly mode: PermissionMode,
  ) {}

  get alive(): boolean {
    return !this.exited;
  }

  /** Agent-side ACP methods for this connection. */
  private get agent(): acp.ClientContext {
    return this.connection.agent;
  }

  static async start(options: DshAgentOptions): Promise<DshAgent> {
    // A launcher (e.g. `sudo -n -u aiagent /usr/local/bin/ai-agent-dsh`) owns DSH_HOME, credentials and
    // telemetry for the agent user; the permission mode is appended as its last argument.
    const [file, ...args] = options.launcher?.length
      ? [...options.launcher, options.mode]
      : [process.execPath, findDshBin(), "--profile", "acp"];
    const child = spawn(file!, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        DSH_HOME: options.dshHome,
        DSH_PERMISSION_MODE: options.mode,
        // Never upload session content (code, prompts, tool output) to DeepSeek's telemetry endpoint.
        DSH_TELEMETRY_MODE: "DISABLED",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let agent: DshAgent | undefined;
    const app = acp
      .client({ name: "ai-employee" })
      .onRequest("session/request_permission", async ({ params }) => {
        const handler = agent?.sessions.get(params.sessionId)?.onPermission;
        return handler ? handler(params) : { outcome: { outcome: "cancelled" } };
      })
      .onNotification("session/update", ({ params }) => {
        agent?.handleUpdate(params.sessionId, params.update);
      });

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    );
    const connection = app.connect(stream);
    agent = new DshAgent(child, connection, options.mode);

    let stderrTail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const lines = (stderrTail + chunk).split(/\r?\n/);
      stderrTail = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) options.onLog?.(line);
    });

    const started = agent;
    started.exitPromise = new Promise<never>((_, reject) => {
      child.once("error", (error) => {
        started.exited = true;
        connection.close(error);
        reject(error);
      });
      child.once("exit", (code) => {
        started.exited = true;
        const error = new Error(`dsh (${options.mode}) exited with code ${code}`);
        connection.close(error);
        options.onExit?.(code);
        reject(error);
      });
    });
    started.exitPromise.catch(() => {});

    await started.untilExit(
      started.agent.request("initialize", {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "ai-employee", version: "0.1.0" },
      }),
    );
    return started;
  }

  /** Rejects as soon as the dsh process dies instead of waiting forever. */
  private untilExit<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([promise, this.exitPromise]);
  }

  private handleUpdate(sessionId: string, update: SessionUpdate): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") session.text += update.content.text;
    session.onUpdate?.(update);
  }

  async newSession(cwd: string, mcpServers: McpServer[], handlers: SessionHandlers): Promise<OpenedSession> {
    const response = await this.untilExit(this.agent.request("session/new", { cwd, mcpServers }));
    this.sessions.set(response.sessionId, { ...handlers, text: "" });
    return { sessionId: response.sessionId, configOptions: response.configOptions ?? [] };
  }

  /** Picks the advertised model (and optionally reasoning effort) matching provider/model. */
  async selectModel(session: OpenedSession, provider: string, model: string, reasoningEffort?: string | null): Promise<void> {
    const selects = session.configOptions.filter((o) => o.type === "select");
    const modelOption = selects.find((o) => o.id === "model" || o.category === "model");
    if (!modelOption || modelOption.type !== "select") throw new Error("dsh did not advertise a model selector");

    const choices = flattenSelectOptions(modelOption.options as unknown[]);
    const haystack = (c: SessionConfigSelectOption) => `${c.value} ${c.name} ${c.description ?? ""}`.toLowerCase();
    // dsh encodes each choice as a JSON [provider, model] pair; fall back to fuzzy matching for other encodings.
    const isExact = (c: SessionConfigSelectOption) => {
      try {
        const value: unknown = JSON.parse(c.value);
        if (Array.isArray(value)) return value[0] === provider && value[1] === model;
      } catch {
        // not JSON
      }
      return c.value === `${provider}/${model}`;
    };
    const matches = choices.filter((c) => haystack(c).includes(model.toLowerCase()));
    const pick = choices.find(isExact) ?? matches.find((c) => haystack(c).includes(provider.toLowerCase())) ?? matches[0];
    if (!pick) {
      throw new Error(
        `Model "${provider}/${model}" is not configured in dsh. Available: ${choices.map((c) => c.value).join(", ") || "none"}. Run npm run setup:dsh.`,
      );
    }
    let response = await this.untilExit(
      this.agent.request("session/set_config_option", { sessionId: session.sessionId, configId: modelOption.id, value: pick.value }),
    );
    session.configOptions = response.configOptions ?? session.configOptions;

    if (!reasoningEffort) return;
    const effortOption = session.configOptions.find((o) => o.type === "select" && (o.id === "reasoning_effort" || o.category === "thought_level"));
    if (!effortOption || effortOption.type !== "select") return;
    const effort = flattenSelectOptions(effortOption.options as unknown[]).find(
      (c) => c.value.toLowerCase() === reasoningEffort.toLowerCase() || c.name.toLowerCase() === reasoningEffort.toLowerCase(),
    );
    if (!effort) return;
    response = await this.untilExit(
      this.agent.request("session/set_config_option", { sessionId: session.sessionId, configId: effortOption.id, value: effort.value }),
    );
    session.configOptions = response.configOptions ?? session.configOptions;
  }

  async prompt(sessionId: string, text: string): Promise<PromptResult> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown dsh session ${sessionId}`);
    session.text = "";
    const response = await this.untilExit(this.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }));
    return { stopReason: response.stopReason, text: session.text };
  }

  async cancel(sessionId: string): Promise<void> {
    await this.agent.notify("session/cancel", { sessionId });
  }

  async closeSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    if (this.exited) return;
    await this.untilExit(this.agent.request("session/close", { sessionId }));
  }

  async stop(): Promise<void> {
    if (this.exited) return;
    this.child.stdin.end();
    const killer = setTimeout(() => this.child.kill(), 5000);
    await this.exitPromise.catch(() => {});
    clearTimeout(killer);
  }
}
