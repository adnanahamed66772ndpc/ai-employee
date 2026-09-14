import { describe, expect, it } from "vitest";
import { APP_URL, appCommand, captureFindings, freePort } from "./visual.ts";

const none = { startCmd: null, appUrl: null };
const pkg = (scripts: Record<string, string>) => JSON.stringify({ scripts });

describe("visual check", () => {
  it("uses the project's own command and fills in the port", () => {
    expect(appCommand({ startCmd: "npm run preview -- --port {port}", appUrl: "http://127.0.0.1:{port}/shop" }, null, 4312)).toEqual({
      command: "PORT=4312 npm run preview -- --port 4312",
      url: "http://127.0.0.1:4312/shop",
      source: "project settings",
    });
  });

  it("only allows local app addresses", () => {
    expect(APP_URL.test("http://localhost:3000/")).toBe(true);
    expect(APP_URL.test("http://127.0.0.1:{port}/a?b=1")).toBe(true);
    expect(APP_URL.test("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(APP_URL.test('http://127.0.0.1:3000/" && rm -rf /')).toBe(false);
    // A rejected URL falls back to package.json instead of opening the address.
    expect(appCommand({ startCmd: "npm start", appUrl: "https://example.com" }, null, 4000)).toBeNull();
  });

  it("guesses the command for common dev servers from package.json", () => {
    expect(appCommand(none, pkg({ dev: "vite" }), 5000)?.command).toBe("npm run dev -- --host 127.0.0.1 --port 5000 --strictPort");
    expect(appCommand(none, pkg({ dev: "next dev" }), 5000)?.command).toBe("npm run dev -- -p 5000 -H 127.0.0.1");
    expect(appCommand(none, pkg({ dev: "nodemon server.js" }), 5000)?.command).toBe("PORT=5000 HOST=127.0.0.1 npm run dev");
    expect(appCommand(none, pkg({ start: "node server.js" }), 5000)).toMatchObject({ command: "PORT=5000 HOST=127.0.0.1 npm start", url: "http://127.0.0.1:5000/" });
    expect(appCommand(none, pkg({ test: "vitest" }), 5000)).toBeNull();
    expect(appCommand(none, "{ broken", 5000)).toBeNull();
  });

  it("turns load failures, page errors and serious axe violations into findings", () => {
    const findings = captureFindings(
      {
        shots: [],
        loadError: "The page answered HTTP 500",
        consoleErrors: ["Uncaught: Cannot read properties of undefined (reading 'price')"],
        axe: [{ id: "color-contrast", impact: "serious", help: "Elements must meet minimum color contrast ratio thresholds", nodes: 3, target: ".total" }],
      },
      "http://127.0.0.1:5000/",
    );
    expect(findings.map((f) => f.problem)).toEqual([
      "The app did not load: The page answered HTTP 500",
      "The page logs errors in the browser: Uncaught: Cannot read properties of undefined (reading 'price')",
      "Accessibility (serious): Elements must meet minimum color contrast ratio thresholds (axe rule color-contrast, 3 elements, first: .total)",
    ]);
    expect(captureFindings({ shots: [], loadError: null, consoleErrors: [], axe: [] }, "http://127.0.0.1:5000/")).toEqual([]);
  });

  it("finds a free local port", async () => {
    expect(await freePort()).toBeGreaterThan(1024);
  });
});
