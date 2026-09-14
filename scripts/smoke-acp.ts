/**
 * Keyless smoke test: boots dsh over ACP, opens a session in this repo and lists the advertised models.
 * No model request is made.   npm run smoke:acp
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DshAgent } from "@ai-employee/dsh-client";

const root = fileURLToPath(new URL("../", import.meta.url));
const started = Date.now();
const agent = await DshAgent.start({
  dshHome: join(root, ".dsh-home"),
  mode: "read-only",
  cwd: root,
  onLog: (line) => console.error(`[dsh] ${line}`),
});
console.log(`dsh ACP initialized in ${Date.now() - started}ms`);

const session = await agent.newSession(root, [], {});
console.log(`session ${session.sessionId}`);
for (const option of session.configOptions) {
  const values =
    option.type === "select"
      ? (option.options as { value?: string; options?: { value: string }[] }[])
          .flatMap((o) => (o.options ? o.options.map((x) => x.value) : [o.value]))
          .join(", ")
      : String(option.currentValue);
  console.log(`- ${option.id} (${option.category ?? "no category"}): current=${String(option.currentValue)} options=[${values}]`);
}
await agent.closeSession(session.sessionId);
await agent.stop();
console.log("ok");
