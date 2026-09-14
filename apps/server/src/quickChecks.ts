import { parseAllDocuments } from "yaml";
import { SECRET_PATTERN } from "./secrets.ts";

/*
 * Free, deterministic checks on every change before any model looks at it: secrets, broken JSON/YAML/JavaScript,
 * debug leftovers and files that do not belong in a commit. Anything a script can decide never costs a model call.
 * Everything here is pure; the pipeline gathers the files from git's object store (never the agent-writable folder).
 */

/** `dependency` findings come from the npm registry (packages.ts); the others from the change itself. */
export type QuickFindingKind = "secret" | "syntax" | "debug" | "file" | "dependency";

export interface QuickFinding {
  kind: QuickFindingKind;
  file: string;
  line?: number;
  message: string;
}

/** A file changed against the base, as staged in the index. */
export interface ChangedFile {
  path: string;
  /** git's status letter: A added, M modified, D deleted, T type changed. */
  status: string;
  /** 100644 or 100755 for regular files, 120000 for symlinks, 160000 for submodules. */
  mode: string;
  blob: string | null;
  size: number;
}

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PARSE_BYTES = 2 * 1024 * 1024;
const MAX_SCRIPT_CHECKS = 30;

const REGULAR = /^1006[0-7]{2}$/;
const present = (f: ChangedFile) => f.status !== "D" && REGULAR.test(f.mode);

export interface AddedLine {
  file: string;
  line: number;
  text: string;
}

/** Added lines of a unified diff with their line numbers in the new file. */
export function addedLines(diff: string): AddedLine[] {
  const lines: AddedLine[] = [];
  let file: string | null = null;
  let inHunk = false;
  let next = 0;
  for (const raw of diff.split("\n")) {
    const header = /^diff --git a\/.+ b\/(.+)$/.exec(raw);
    if (header) {
      file = header[1]!;
      inHunk = false;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      inHunk = true;
      next = Number(hunk[1]);
      continue;
    }
    if (!file || !inHunk) continue;
    if (raw.startsWith("+")) lines.push({ file, line: next++, text: raw.slice(1) });
    else if (raw.startsWith(" ")) next++;
  }
  return lines;
}

const CODE_FILE = /\.(m?[jt]sx?|cjs|cts|mts|vue|svelte|astro)$/i;
const ONLY = /\b(?:it|test|describe|context|suite)\.only\s*\(/;
const DEBUGGER = /^\s*debugger\s*;?\s*$/;
const PY_BREAKPOINT = /^\s*(?:breakpoint\(\)|(?:import pdb;\s*)?pdb\.set_trace\(\))/;
const CONFLICT_EDGE = /^(<<<<<<<|>>>>>>>)( |$)/;

/** Environment files with real values; examples and templates are fine to commit. */
const ENV_FILE = /(^|\/)\.env(\.[\w-]+)?$/;
const ENV_EXAMPLE = /\.(example|sample|template|dist|defaults?)$/i;

// Whole path segments only (`rebuild/` is not `build/`); the first such folder names the group.
const ALWAYS_GENERATED = /^((?:[^/]*\/)*?)(node_modules|__pycache__|\.pytest_cache)\//;
/** Build output folders are only a problem when the repository did not already keep them. */
const MAYBE_GENERATED = /^((?:[^/]*\/)*?)(dist|build|coverage|\.next)\//;
const JUNK_FILE = /(^|\/)(\.DS_Store|Thumbs\.db)$|\.pyc$/;

/** JSON files that allow comments, so JSON.parse would wrongly reject them. */
const JSONC = /(^|\/)(tsconfig[^/]*|jsconfig[^/]*|\.eslintrc[^/]*|\.babelrc[^/]*)\.json$|\.jsonc$|(^|\/)\.(vscode|devcontainer)\//i;

const redact = (secret: string) => `${secret.slice(0, 4)}…`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * Build output folders the change touches, e.g. `dist/` or `apps/web/build/`; the pipeline asks git which the base already
 * had. Edited files count too, so a kept `dist/` is recognised (and scanned) even when nothing new is added to it.
 */
export function generatedCandidates(files: ChangedFile[]): string[] {
  const folders = new Set<string>();
  for (const file of files) {
    if (file.status === "D") continue;
    const match = MAYBE_GENERATED.exec(file.path);
    if (match && !ALWAYS_GENERATED.test(file.path)) folders.add(`${match[1]}${match[2]}/`);
  }
  return [...folders];
}

const generatedFolder = (path: string, existingFolders: Set<string>): string | null => {
  const always = ALWAYS_GENERATED.exec(path);
  if (always) return `${always[1]}${always[2]}/`;
  const maybe = MAYBE_GENERATED.exec(path);
  return maybe && !existingFolders.has(`${maybe[1]}${maybe[2]}/`) ? `${maybe[1]}${maybe[2]}/` : null;
};

/** JSON and YAML files whose content the pipeline should read from git and parse. */
export function structuredFiles(files: ChangedFile[]): ChangedFile[] {
  return files.filter((f) => present(f) && f.blob && f.size <= MAX_PARSE_BYTES && !ALWAYS_GENERATED.test(f.path) && /\.(json|ya?ml)$/i.test(f.path) && !JSONC.test(f.path));
}

/** JavaScript files to syntax-check with `node --check`; odd names are skipped rather than quoted. */
export function scriptFiles(files: ChangedFile[]): ChangedFile[] {
  return files
    .filter((f) => present(f) && /\.(js|mjs|cjs)$/i.test(f.path) && /^[\w@+.\/-]+$/.test(f.path) && !f.path.startsWith("-") && !ALWAYS_GENERATED.test(f.path) && !MAYBE_GENERATED.test(f.path))
    .slice(0, MAX_SCRIPT_CHECKS);
}

/** Turns `node --check` output into a finding; tool trouble and JSX in .js files are not the change's fault. */
export function scriptProblem(path: string, ok: boolean, output: string): QuickFinding | null {
  if (ok) return null;
  const error = /^(SyntaxError: .+)$/m.exec(output)?.[1];
  if (!error || /Unexpected token '<'/.test(error)) return null;
  const line = Number(/:(\d+)\r?$/m.exec(output)?.[1]);
  return { kind: "syntax", file: path, ...(line ? { line } : {}), message: `JavaScript does not parse: ${error}` };
}

function structuredProblem(path: string, text: string): QuickFinding | null {
  const body = text.replace(/^﻿/, "");
  if (/\.json$/i.test(path)) {
    try {
      JSON.parse(body);
      return null;
    } catch (error) {
      const line = Number(/line (\d+)/.exec((error as Error).message)?.[1]);
      return { kind: "syntax", file: path, ...(line ? { line } : {}), message: `Not valid JSON: ${(error as Error).message}` };
    }
  }
  for (const doc of parseAllDocuments(body)) {
    const error = doc.errors[0];
    if (error) return { kind: "syntax", file: path, ...(error.linePos ? { line: error.linePos[0].line } : {}), message: `Not valid YAML: ${error.message.split("\n")[0]}` };
  }
  return null;
}

export interface QuickCheckInput {
  diff: string;
  files: ChangedFile[];
  /** Build output folders (from generatedCandidates) the base commit already had. */
  existingFolders: Set<string>;
  /** Content of structuredFiles, by path. */
  contents: Map<string, string>;
}

export function quickFindings({ diff, files, existingFolders, contents }: QuickCheckInput): QuickFinding[] {
  const findings: QuickFinding[] = [];
  const skipped = (path: string) => generatedFolder(path, existingFolders) !== null;

  // Files that do not belong in a commit: one finding per folder, not one per installed package file.
  const byFolder = new Map<string, number>();
  for (const file of files) {
    if (file.status === "D") continue;
    const folder = file.status === "A" ? generatedFolder(file.path, existingFolders) : null;
    if (folder) {
      byFolder.set(folder, (byFolder.get(folder) ?? 0) + 1);
    } else if (file.status === "A" && ENV_FILE.test(file.path) && !ENV_EXAMPLE.test(file.path)) {
      findings.push({ kind: "secret", file: file.path, message: "An environment file with real settings is added. Remove it, add it to .gitignore, and commit a .env.example with placeholder values instead." });
    } else if (file.status === "A" && JUNK_FILE.test(file.path)) {
      findings.push({ kind: "file", file: file.path, message: "An operating system or cache file is added. Remove it and add it to .gitignore." });
    } else if (file.size > MAX_FILE_BYTES) {
      findings.push({ kind: "file", file: file.path, message: `The file is ${megabytes(file.size)}. Files over ${megabytes(MAX_FILE_BYTES)} do not belong in git: remove it or generate it at build time.` });
    }
  }
  for (const [folder, count] of byFolder) {
    findings.push({ kind: "file", file: folder, message: `${plural(count, "file")} added under ${folder}. Installed or generated files do not belong in the commit: remove them and add the folder to .gitignore.` });
  }

  const conflictFiles = new Set<string>();
  for (const { file, line, text } of addedLines(diff)) {
    if (skipped(file)) continue;
    const secret = SECRET_PATTERN.exec(text);
    if (secret) {
      findings.push({ kind: "secret", file, line, message: `This line contains what looks like a secret (${redact(secret[0])}). Remove it and read the value from an environment variable instead.` });
    }
    if (CONFLICT_EDGE.test(text)) conflictFiles.add(file);
    if (CODE_FILE.test(file) && ONLY.test(text)) {
      findings.push({ kind: "debug", file, line, message: "`.only(` makes every other test in the run skip silently. Remove `.only`." });
    }
    if (CODE_FILE.test(file) && DEBUGGER.test(text)) findings.push({ kind: "debug", file, line, message: "A leftover `debugger` statement. Remove it." });
    if (/\.py$/i.test(file) && PY_BREAKPOINT.test(text)) findings.push({ kind: "debug", file, line, message: "A leftover breakpoint. Remove it." });
  }
  for (const file of conflictFiles) {
    const line = addedLines(diff).find((l) => l.file === file && CONFLICT_EDGE.test(l.text))?.line;
    findings.push({ kind: "debug", file, ...(line ? { line } : {}), message: "Merge conflict markers (<<<<<<< / >>>>>>>) are left in the file. Resolve the conflict." });
  }

  for (const [path, text] of contents) {
    const problem = structuredProblem(path, text);
    if (problem) findings.push(problem);
  }
  return findings;
}

const MAX_REPORTED = 30;

export function formatQuickFindings(findings: QuickFinding[]): string {
  if (findings.length === 0) {
    return "Quick checks passed: no secrets, JSON/YAML/JavaScript syntax errors, debug leftovers, unwanted files or package problems in the change. Do not check these again.";
  }
  const lines = findings.slice(0, MAX_REPORTED).map((f) => `- ${f.file}${f.line ? `:${f.line}` : ""}: ${f.message}`);
  if (findings.length > MAX_REPORTED) lines.push(`- …and ${findings.length - MAX_REPORTED} more`);
  return [`Quick checks found ${plural(findings.length, "problem")}. Fix every one:`, ...lines].join("\n");
}

export interface DetectedCheck {
  command: string;
  /** Where the command came from, for the run log. */
  source: string;
}

const TYPECHECK_SCRIPTS = ["typecheck", "type-check", "check-types"];

/**
 * Checks for a project without test or lint commands, taken from its package.json scripts. Returns null without a
 * readable package.json. `install` is set when the scripts need dependencies installed first.
 */
export function detectPackageChecks(packageJson: string | null, options: { lockfile: boolean }): { commands: DetectedCheck[]; install: string | null } | null {
  if (!packageJson) return null;
  let pkg: { scripts?: Record<string, unknown>; dependencies?: object; devDependencies?: object };
  try {
    pkg = JSON.parse(packageJson.replace(/^﻿/, "")) as typeof pkg;
  } catch {
    return null;
  }
  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const has = (name: string) => typeof scripts[name] === "string" && String(scripts[name]).trim() !== "";
  const commands: DetectedCheck[] = [];
  const typecheck = TYPECHECK_SCRIPTS.find(has);
  if (typecheck) commands.push({ command: `npm run --silent ${typecheck}`, source: `package.json scripts.${typecheck}` });
  if (has("lint")) commands.push({ command: "npm run --silent lint", source: "package.json scripts.lint" });
  // npm init writes a test script that always fails; it is not a real test.
  if (has("test") && !/no test specified/i.test(String(scripts.test))) commands.push({ command: "npm test --silent", source: "package.json scripts.test" });

  const dependencies = Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length;
  // No install scripts (they run arbitrary package code) and no lockfile written into the change.
  const install =
    commands.length && dependencies
      ? options.lockfile
        ? "npm ci --ignore-scripts --no-audit --no-fund"
        : "npm install --ignore-scripts --no-audit --no-fund --no-package-lock"
      : null;
  return { commands, install };
}
