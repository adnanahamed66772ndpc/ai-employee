import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Brain, type Project, type Task } from "@ai-employee/brain";
import { handleMcpRequest, McpTokens } from "./mcp.ts";

let brain: Brain;
let tokens: McpTokens;
let shop: Project;
let blog: Project;
let shopTask: Task;

beforeEach(() => {
  brain = new Brain(":memory:");
  tokens = new McpTokens();
  shop = brain.createProject({ name: "Shop", localPath: "/srv/ai-projects/shop", githubRepo: "o/shop", testCmd: "npm test" });
  blog = brain.createProject({ name: "Blog", localPath: "/srv/ai-projects/blog" });
  shopTask = brain.createTask(brain.createSession(shop.id, "s").id, "Add a cart");
  brain.addMemory({ scope: "global", kind: "preference", content: "The owner prefers small pull requests" });
  brain.addMemory({ scope: "project", projectId: shop.id, kind: "convention", content: "Shop prices are stored in cents" });
  brain.addMemory({ scope: "project", projectId: blog.id, kind: "convention", content: "Blog posts are stored in Markdown" });
});
afterEach(() => brain.close());

/** An MCP client that reaches the endpoint in-process, as an agent with this bearer token would. */
async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:7717/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (url, init) => handleMcpRequest(brain, tokens, new Request(url, init)),
  });
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as { type: string; text: string }[]).map((c) => c.text).join("\n");

describe("brain MCP endpoint", () => {
  it("refuses requests without a token, with an unknown one, or with a revoked one", async () => {
    const call = (authorization?: string) =>
      handleMcpRequest(
        brain,
        tokens,
        new Request("http://127.0.0.1:7717/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(authorization ? { authorization } : {}) },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        }),
      );
    expect((await call()).status).toBe(401);
    expect((await call("Bearer not-a-token")).status).toBe(401);
    const token = tokens.issue(shop.id, shopTask.id);
    tokens.revoke(token);
    expect((await call(`Bearer ${token}`)).status).toBe(401);
  });

  it("searches only the global memory and the token's own project", async () => {
    const client = await connect(tokens.issue(shop.id, shopTask.id));
    const found = text(await client.callTool({ name: "memory_search", arguments: { query: "" } }));
    expect(found).toContain("Shop prices are stored in cents");
    expect(found).toContain("The owner prefers small pull requests");
    expect(found).not.toContain("Blog posts");
    expect(text(await client.callTool({ name: "memory_search", arguments: { query: "Markdown" } }))).toBe("No matching memories.");
  });

  it("writes project memory to the token's project and records it on the task", async () => {
    const client = await connect(tokens.issue(shop.id, shopTask.id));
    const saved = await client.callTool({
      name: "memory_write",
      arguments: { content: "Run the shop tests with npm test", scope: "project", kind: "convention" },
    });
    expect(text(saved)).toBe("Saved project memory.");
    expect(brain.listMemories({ scope: "project", projectId: shop.id }).map((m) => m.content)).toContain("Run the shop tests with npm test");
    expect(brain.listMemories({ scope: "project", projectId: blog.id }).map((m) => m.content)).not.toContain("Run the shop tests with npm test");
    expect(brain.listEvents(shopTask.id).find((e) => e.type === "memory_written")?.payload).toMatchObject({ scope: "project", kind: "convention" });
  });

  it("refuses to save a secret", async () => {
    const client = await connect(tokens.issue(shop.id, shopTask.id));
    const refused = await client.callTool({
      name: "memory_write",
      arguments: { content: "The deploy token is ghp_abcdefghijklmnopqrstuvwxyz123456", scope: "project", kind: "fact" },
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/secret/);
    expect(brain.listMemories({ scope: "project", projectId: shop.id }).map((m) => m.content).join()).not.toContain("ghp_");
  });

  it("describes the token's project without its id or folder", async () => {
    const client = await connect(tokens.issue(shop.id, shopTask.id));
    const info = JSON.parse(text(await client.callTool({ name: "project_info", arguments: {} }))) as Record<string, unknown>;
    expect(info).toMatchObject({ name: "Shop", githubRepo: "o/shop", testCmd: "npm test" });
    expect(info).not.toHaveProperty("id");
    expect(info).not.toHaveProperty("localPath");
  });
});
