import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Brain } from "@ai-employee/brain";
import { containsSecret } from "./secrets.ts";

interface TokenScope {
  projectId: string;
  taskId: string;
}

/** Short-lived bearer tokens that bind an agent session to one project, so memory access is scoped server-side. */
export class McpTokens {
  private readonly tokens = new Map<string, TokenScope>();

  issue(projectId: string, taskId: string): string {
    const token = randomBytes(24).toString("hex");
    this.tokens.set(token, { projectId, taskId });
    return token;
  }

  resolve(token: string): TokenScope | undefined {
    return this.tokens.get(token);
  }

  revoke(token: string): void {
    this.tokens.delete(token);
  }
}

function buildServer(brain: Brain, scope: TokenScope): McpServer {
  const server = new McpServer({ name: "ai-employee-brain", version: "0.1.0" });
  const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

  server.registerTool(
    "memory_search",
    {
      description:
        "Search the team's long-term memory: the user's global preferences plus memory for the current project only. Use it to find conventions, commands and past lessons before making decisions.",
      inputSchema: {
        query: z.string().describe("Words to search for. An empty string lists the most recent memories."),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => {
      const items = brain.searchMemories(scope.projectId, query, limit ?? 10);
      return text(items.length ? items.map((m) => `- [${m.scope}/${m.kind}] ${m.content}`).join("\n") : "No matching memories.");
    },
  );

  server.registerTool(
    "memory_write",
    {
      description:
        "Save a durable fact for future tasks: something that stays true after this task is finished, such as commands, architecture, conventions or recurring pitfalls. Use scope 'project' for facts about this repository and 'global' only for the user's preferences that apply to every project. Never store bugs you are fixing, failing tests, the current state of your work, one-off task details or secrets.",
      inputSchema: {
        content: z.string().min(1).max(2000),
        scope: z.enum(["project", "global"]),
        kind: z.enum(["preference", "convention", "fact", "lesson"]),
        tags: z.array(z.string().max(40)).max(8).optional(),
      },
    },
    async ({ content, scope: memoryScope, kind, tags }) => {
      if (containsSecret(content)) return { ...text("Refused: the content looks like it contains a secret."), isError: true };
      const { memory, duplicate } = brain.rememberMemory({ scope: memoryScope, projectId: scope.projectId, kind, content, tags, sourceTaskId: scope.taskId });
      if (duplicate) return text(`Not saved: memory already has nearly the same fact: ${memory.content}`);
      brain.addEvent(scope.taskId, "memory_written", { scope: memory.scope, kind: memory.kind, content: memory.content });
      return text(`Saved ${memory.scope} memory.`);
    },
  );

  server.registerTool(
    "project_info",
    { description: "Name, default branch, GitHub repository and check commands of the current project.", annotations: { readOnlyHint: true } },
    async () => {
      const project = brain.getProject(scope.projectId);
      return text(project ? JSON.stringify({ ...project, id: undefined, localPath: undefined }, null, 2) : "Project not found.");
    },
  );

  return server;
}

/** Stateless Streamable HTTP MCP endpoint: a fresh server per request, scoped by the bearer token. */
export async function handleMcpRequest(brain: Brain, tokens: McpTokens, request: Request): Promise<Response> {
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const scope = token ? tokens.resolve(token) : undefined;
  if (!scope) return new Response("Unauthorized", { status: 401 });
  const server = buildServer(brain, scope);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}
