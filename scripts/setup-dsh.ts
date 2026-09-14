/**
 * Writes a first .dsh-home/settings.yaml before the server has run. The server rewrites the file from the Models page
 * on every start and every change, so this is only needed for a fresh checkout or `npm run smoke:acp`.
 *
 *   npm run setup:dsh
 *   npm run setup:dsh -- --models=deepseek-v4-flash,deepseek-v4-pro --force
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderDshSettings } from "../apps/server/src/dshSettings.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const dshHome = join(root, ".dsh-home");
const settingsPath = join(dshHome, "settings.yaml");
const port = Number(process.env.AI_EMPLOYEE_PORT || 7717);
const force = process.argv.includes("--force");
const modelsArg = process.argv.find((a) => a.startsWith("--models="));
const models = modelsArg
  ? modelsArg.slice("--models=".length).split(",").map((m) => m.trim()).filter(Boolean)
  : ["deepseek-v4-flash"];

const yaml = renderDshSettings(
  [{ id: "cheaperinference", name: "CheaperInference", type: "openai", baseUrl: "https://api.cheaperinference.com/v1" }],
  models.map((model) => ({ provider: "cheaperinference", model })),
  port,
);

if (existsSync(settingsPath) && !force) {
  console.log(`${settingsPath} already exists. Re-run with --force to overwrite (the server rewrites it on start anyway).`);
} else {
  mkdirSync(dshHome, { recursive: true });
  writeFileSync(settingsPath, yaml);
  console.log(`Wrote ${settingsPath} with CheaperInference models: ${models.join(", ")}. Set up other providers on the Models page.`);
}
