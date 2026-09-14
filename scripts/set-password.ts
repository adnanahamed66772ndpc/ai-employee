/**
 * Sets the dashboard password. Required when the dashboard is served on a domain.
 *
 *   npm run set-password
 *
 * Writes data/auth.json (mode 600). Restart the server afterwards; existing sessions are signed out.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { newAuthFile } from "../apps/server/src/password.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const dataDir = process.env.AI_EMPLOYEE_DATA_DIR || join(root, "data");
const authPath = join(dataDir, "auth.json");

async function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    let data = "";
    for await (const chunk of process.stdin) data += chunk;
    return data.split(/\r?\n/)[0] ?? "";
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onData);
      process.stdout.write("\n");
    };
    const onData = (input: string) => {
      for (const ch of input) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (ch === "") {
          cleanup();
          reject(new Error("Cancelled"));
          return;
        }
        value = ch === "" || ch === "\b" ? value.slice(0, -1) : value + ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

const password = await readHidden("New dashboard password (at least 12 characters): ");
if (password.length < 12) {
  console.error("Use at least 12 characters.");
  process.exit(1);
}
if (process.stdin.isTTY && (await readHidden("Repeat the password: ")) !== password) {
  console.error("The passwords do not match.");
  process.exit(1);
}

mkdirSync(dataDir, { recursive: true });
writeFileSync(authPath, `${JSON.stringify(newAuthFile(password), null, 2)}\n`, { mode: 0o600 });
chmodSync(authPath, 0o600);
console.log(`Saved ${authPath}. Restart the server to apply it; everyone is signed out.`);
