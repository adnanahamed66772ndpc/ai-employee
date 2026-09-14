// Opens a running app in headless Chrome and prints one JSON line: phone and desktop screenshots (JPEG, base64),
// uncaught page and console errors, and serious accessibility violations found by axe.
// It runs as the unprivileged agent user, because the page is agent-written code.
// Usage: node visual-runner.mjs <url> [chrome-executable]
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const [url, executablePath] = process.argv.slice(2);
const VIEWS = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 800 },
];
const MAX_HEIGHT = 2400;

async function launch() {
  const options = { headless: true, ...(executablePath ? { executablePath } : { channel: "chrome" }) };
  try {
    return await chromium.launch(options);
  } catch (error) {
    // Some servers block the user namespaces Chrome's sandbox needs; the agent user is already unprivileged.
    if (!/sandbox|namespace|zygote/i.test(String(error))) throw error;
    return chromium.launch({ ...options, chromiumSandbox: false });
  }
}

const result = { shots: [], consoleErrors: [], axe: [], loadError: null };
const browser = await launch();
try {
  const axeSource = readFileSync(new URL("./axe.min.js", import.meta.url), "utf8");
  for (const view of VIEWS) {
    const context = await browser.newContext({ viewport: { width: view.width, height: view.height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") result.consoleErrors.push(message.text().slice(0, 300));
    });
    page.on("pageerror", (error) => result.consoleErrors.push(`Uncaught: ${String(error.message ?? error).slice(0, 300)}`));
    try {
      const response = await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      if (response && response.status() >= 400) result.loadError ??= `The page answered HTTP ${response.status()}`;
    } catch (error) {
      result.loadError ??= String(error.message ?? error).split("\n")[0];
    }
    await page.waitForTimeout(500);
    const height = Math.min(MAX_HEIGHT, await page.evaluate(() => document.documentElement.scrollHeight).catch(() => view.height));
    const image = await page.screenshot({ type: "jpeg", quality: 60, fullPage: true, clip: { x: 0, y: 0, width: view.width, height: Math.max(height, 1) } });
    result.shots.push({ name: view.name, width: view.width, height, jpegBase64: image.toString("base64") });
    if (view.name === "desktop" && !result.loadError) {
      await page.addScriptTag({ content: axeSource }).catch(() => {});
      const violations = await page
        .evaluate(async () => (await window.axe.run(document, { resultTypes: ["violations"] })).violations)
        .catch(() => []);
      result.axe = violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .slice(0, 10)
        .map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, target: String(v.nodes[0]?.target?.[0] ?? "") }));
    }
    await context.close();
  }
} finally {
  await browser.close();
}
result.consoleErrors = [...new Set(result.consoleErrors)].slice(0, 20);
process.stdout.write(`${JSON.stringify(result)}\n`);
