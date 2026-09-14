import { DshAgent, type PermissionMode } from "@ai-employee/dsh-client";
import type { Config } from "./config.ts";
import { GATEWAY_TOKEN_ENV, GATEWAY_TOKEN_PLACEHOLDER } from "./dshSettings.ts";

/** Keeps one dsh ACP process per permission mode and restarts it if it dies. */
export class AgentPool {
  private readonly agents = new Map<PermissionMode, Promise<DshAgent>>();

  constructor(
    private readonly config: Config,
    private readonly log: (message: string) => void,
  ) {}

  async get(mode: PermissionMode): Promise<DshAgent> {
    const existing = this.agents.get(mode);
    if (existing) {
      const agent = await existing.catch(() => null);
      if (agent?.alive) return agent;
    }
    this.log(`starting DeepSeek Harness (${mode})`);
    const starting = DshAgent.start({
      dshHome: this.config.dshHome,
      mode,
      cwd: this.config.dataDir,
      // DeepSeek Harness needs a non-empty key variable; the gateway replaces it with the provider's real key.
      env: { [GATEWAY_TOKEN_ENV]: GATEWAY_TOKEN_PLACEHOLDER },
      launcher: this.config.dshLauncher,
      onLog: (line) => this.log(`[dsh:${mode}] ${line}`),
      onExit: (code) => this.log(`DeepSeek Harness (${mode}) exited with code ${code}`),
    });
    this.agents.set(mode, starting);
    starting.catch((error: Error) => {
      this.log(`DeepSeek Harness (${mode}) failed to start: ${error.message}`);
      if (this.agents.get(mode) === starting) this.agents.delete(mode);
    });
    return starting;
  }

  async status(): Promise<Record<PermissionMode, boolean>> {
    const alive = async (mode: PermissionMode) => {
      const agent = await this.agents.get(mode)?.catch(() => null);
      return agent?.alive ?? false;
    };
    return { "read-only": await alive("read-only"), "workspace-write": await alive("workspace-write") };
  }

  async stopAll(): Promise<void> {
    const running = [...this.agents.values()];
    this.agents.clear();
    await Promise.all(running.map((p) => p.then((agent) => agent.stop()).catch(() => {})));
  }
}
