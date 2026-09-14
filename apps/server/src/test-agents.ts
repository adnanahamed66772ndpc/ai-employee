import { randomUUID } from "node:crypto";
import type { McpServer, OpenedSession, PromptResult, SessionHandlers } from "@ai-employee/dsh-client";
import type { AgentHandle } from "./pipeline.ts";

/** Test helpers: a stand-in for DeepSeek Harness and a poll-until helper. */

export type Reply = (text: string, cwd: string) => Promise<PromptResult> | PromptResult;

/** Answers each prompt with a scripted reply, run in the session's folder. */
export class FakeAgent implements AgentHandle {
  readonly prompts: { text: string; cwd: string }[] = [];
  private readonly sessions = new Map<string, string>();

  constructor(private readonly reply: Reply) {}

  async newSession(cwd: string, _servers: McpServer[], _handlers: SessionHandlers): Promise<OpenedSession> {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, cwd);
    return { sessionId, configOptions: [] };
  }

  async selectModel(): Promise<void> {}

  async prompt(sessionId: string, text: string): Promise<PromptResult> {
    const cwd = this.sessions.get(sessionId)!;
    this.prompts.push({ text, cwd });
    return this.reply(text, cwd);
  }

  async cancel(): Promise<void> {}

  async closeSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}

export const said = (text: string): PromptResult => ({ stopReason: "end_turn", text });

export async function waitFor<T>(check: () => T | undefined | null | false, what: string, attempts = 2400): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}
