import { describe, expect, it } from "vitest";
import {
  addedLines,
  detectPackageChecks,
  formatQuickFindings,
  generatedCandidates,
  quickFindings,
  scriptFiles,
  scriptProblem,
  structuredFiles,
  type ChangedFile,
} from "./quickChecks.ts";

const file = (path: string, patch: Partial<ChangedFile> = {}): ChangedFile => ({ path, status: "A", mode: "100644", blob: "b1", size: 100, ...patch });

/** A diff that adds `lines` as a new file. */
const added = (path: string, lines: string[]) =>
  [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");

const check = (diff: string, files: ChangedFile[], contents = new Map<string, string>(), existingFolders = new Set<string>()) =>
  quickFindings({ diff, files, contents, existingFolders });

// Built at run time, so this test file itself never looks like it holds a key.
const fakeKey = `sk-${"a1B2".repeat(8)}`;

describe("quick checks", () => {
  it("numbers added lines as in the new file", () => {
    const diff = ["diff --git a/a.js b/a.js", "--- a/a.js", "+++ b/a.js", "@@ -3,3 +3,4 @@", " keep", "-old", "+new", "+more", " keep"].join("\n");
    expect(addedLines(diff)).toEqual([
      { file: "a.js", line: 4, text: "new" },
      { file: "a.js", line: 5, text: "more" },
    ]);
  });

  it("finds a secret without repeating it", () => {
    const findings = check(added("src/config.js", ["const a = 1;", `const key = "${fakeKey}";`]), [file("src/config.js")]);
    expect(findings).toEqual([expect.objectContaining({ kind: "secret", file: "src/config.js", line: 2 })]);
    expect(formatQuickFindings(findings)).not.toContain(fakeKey);
  });

  it("flags a real .env file but not an example", () => {
    const findings = check("", [file(".env"), file("apps/web/.env.local"), file(".env.example")]);
    expect(findings.map((f) => f.file)).toEqual([".env", "apps/web/.env.local"]);
  });

  it("finds debug leftovers and conflict markers, not a lone =======", () => {
    const diff = [
      added("test/cart.test.js", ["describe.only(\"cart\", () => {", "  debugger;", "});"]),
      added("src/app.py", ["breakpoint()"]),
      added("src/merge.ts", ["<<<<<<< HEAD", "const a = 1;", "=======", "const a = 2;", ">>>>>>> main"]),
      added("docs/title.md", ["Title", "======="]),
    ].join("\n");
    const findings = check(diff, [file("test/cart.test.js"), file("src/app.py"), file("src/merge.ts"), file("docs/title.md")]);
    expect(findings.map((f) => `${f.kind} ${f.file}:${f.line}`)).toEqual(["debug test/cart.test.js:1", "debug test/cart.test.js:2", "debug src/app.py:1", "debug src/merge.ts:1"]);
  });

  it("groups installed files per folder and allows build folders the repository already keeps", () => {
    const files = [file("node_modules/a/index.js"), file("node_modules/b/index.js"), file("dist/app.js"), file("action/dist/index.js"), file("src/.DS_Store")];
    expect(generatedCandidates(files)).toEqual(["dist/", "action/dist/"]);
    const findings = check("", files, new Map(), new Set(["action/dist/"]));
    expect(findings.map((f) => f.file)).toEqual(["src/.DS_Store", "node_modules/", "dist/"]);
    expect(findings.find((f) => f.file === "node_modules/")?.message).toMatch(/^2 files added/);
  });

  it("matches whole folder names only, and scans edits inside a build folder the repository keeps", () => {
    const files = [file("src/rebuild/index.ts"), file("reports/test-coverage/summary.ts"), file("tools/prebuild/gen.js"), file("action/dist/index.js", { status: "M" })];
    expect(generatedCandidates(files)).toEqual(["action/dist/"]);
    const diff = added("action/dist/index.js", [`const key = "${fakeKey}";`]);
    const findings = check(diff, files, new Map(), new Set(["action/dist/"]));
    expect(findings.map((f) => `${f.kind} ${f.file}`)).toEqual(["secret action/dist/index.js"]);
  });

  it("flags a big file", () => {
    expect(check("", [file("assets/video.mp4", { status: "M", size: 7 * 1024 * 1024 })])[0]?.message).toMatch(/7\.0 MB/);
  });

  it("parses changed JSON and YAML, skipping JSON that allows comments", () => {
    const files = [file("package.json"), file("tsconfig.json"), file(".github/workflows/ci.yml"), file("logo.png"), file("gone.json", { status: "D" })];
    expect(structuredFiles(files).map((f) => f.path)).toEqual(["package.json", ".github/workflows/ci.yml"]);
    const contents = new Map([
      ["package.json", '{\n  "name": "shop",\n}\n'],
      [".github/workflows/ci.yml", "on: push\njobs:\n  build:\n    steps: [\n"],
    ]);
    const findings = check("", [], contents);
    expect(findings.map((f) => `${f.file} ${f.message.split(":")[0]}`)).toEqual(["package.json Not valid JSON", ".github/workflows/ci.yml Not valid YAML"]);
  });

  it("reports JavaScript syntax errors but not JSX or tool trouble", () => {
    expect(scriptFiles([file("src/a.js"), file("src/b.ts"), file("src/it's.js"), file("dist/x.js")]).map((f) => f.path)).toEqual(["src/a.js"]);
    expect(scriptProblem("src/a.js", false, "/w/src/a.js:3\n  foo(;\n      ^\n\nSyntaxError: Unexpected token ';'\n")).toMatchObject({ line: 3, message: "JavaScript does not parse: SyntaxError: Unexpected token ';'" });
    expect(scriptProblem("src/a.js", false, "/w/src/a.js:2\n  return <App />;\n\nSyntaxError: Unexpected token '<'\n")).toBeNull();
    expect(scriptProblem("src/a.js", false, "sudo: node: command not found")).toBeNull();
  });

  it("says what passed, so the models do not check it again", () => {
    expect(formatQuickFindings([])).toMatch(/^Quick checks passed/);
  });
});

describe("checks from package.json", () => {
  it("runs typecheck, lint and test in that order, installing dependencies first", () => {
    const pkg = JSON.stringify({ scripts: { test: "vitest run", lint: "eslint .", "type-check": "tsc --noEmit", build: "vite build" }, devDependencies: { vitest: "^3" } });
    expect(detectPackageChecks(pkg, { lockfile: true })).toEqual({
      commands: [
        { command: "npm run --silent type-check", source: "package.json scripts.type-check" },
        { command: "npm run --silent lint", source: "package.json scripts.lint" },
        { command: "npm test --silent", source: "package.json scripts.test" },
      ],
      install: "npm ci --ignore-scripts --no-audit --no-fund",
    });
  });

  it("skips npm's placeholder test and needs no install without dependencies", () => {
    expect(detectPackageChecks(JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }), { lockfile: false })).toEqual({ commands: [], install: null });
    expect(detectPackageChecks(JSON.stringify({ scripts: { test: "node --test" } }), { lockfile: false })?.install).toBeNull();
    expect(detectPackageChecks(JSON.stringify({ scripts: { lint: "eslint ." }, devDependencies: { eslint: "^9" } }), { lockfile: false })?.install).toMatch(/--no-package-lock/);
    expect(detectPackageChecks("{ broken", { lockfile: false })).toBeNull();
    expect(detectPackageChecks(null, { lockfile: false })).toBeNull();
  });
});
