import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { containsSecret } from "./secrets.ts";

/**
 * The `.ai/` handoff notes every managed project keeps in its repository. HANDOFF.md is the current state and is
 * read first; the previous HANDOFF.md is archived into history/ each time a task rewrites it.
 */
export const AI_DIR = ".ai";
export const AI_FILES = ["HANDOFF.md", "ARCHITECTURE.md", "DECISIONS.md", "TASKS.md", "CONVENTIONS.md"] as const;
export type AiFile = (typeof AI_FILES)[number];
export type AiFiles = Partial<Record<AiFile, string>>;

/** Largest file the handoff step writes; bigger replies are refused rather than committed. */
export const MAX_AI_FILE_CHARS = 60_000;

const pad = (n: number) => String(n).padStart(2, "0");
export const dayStamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeStamp = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function templateFiles(projectName: string, branch: string, date: Date): Record<AiFile, string> {
  const nothing = "Nothing recorded yet.";
  return {
    "HANDOFF.md": `# Handoff

_Last updated: ${dayStamp(date)}, when AI Employee added ${projectName}._
Read this first. Open the other files in \`.ai/\` only when the task needs them.

## Current state

- Base branch: \`${branch}\`
- No task has run yet.

## Current objective

Not set yet. The next task fills this in.

## Completed recently

${nothing}

## Tests already run

${nothing}

## Not yet verified

${nothing}

## Known issues

${nothing}

## Next exact action

Wait for the next task.
`,
    "ARCHITECTURE.md": `# Architecture

How ${projectName} is put together. Keep it short and current, and update it when a change moves things around.

## Overview

Not described yet.

## Components

Not described yet.

## Data and configuration

Not described yet.

## Commands

Not described yet.
`,
    "DECISIONS.md": `# Decisions

Newest last. Each entry: what was decided, why, and what was rejected.
`,
    "TASKS.md": `# Tasks

## In progress

_Nothing._

## Todo

_Nothing yet._

## Done

_Nothing yet._
`,
    "CONVENTIONS.md": `# Conventions

## Code

Not recorded yet. Follow the style of the existing code.

## Git

- Changes are made on branches and opened as pull requests. The owner approves every push.

## AI assistant rules

1. Read \`.ai/HANDOFF.md\` first. Open ARCHITECTURE, DECISIONS, TASKS or CONVENTIONS only when the task needs them, and \`.ai/history/\` only for old context.
2. Report honestly what was verified and what was not.
3. Never put secrets in \`.ai/\`.

## Updating the handoff

At the end of every task:

1. Append the current \`HANDOFF.md\` to \`.ai/history/YYYY-MM-DD.md\` under a \`## Handoff archived at HH:MM\` heading.
2. Rewrite \`HANDOFF.md\` with these sections: Current state, Current objective, Completed recently, Tests already run, Not yet verified, Known issues, Next exact action.
3. Update \`TASKS.md\`.
4. Add to \`DECISIONS.md\`, and update \`CONVENTIONS.md\` or \`ARCHITECTURE.md\`, only when something changed.

AI Employee does this automatically after a task passes review, in the same commit as the change.
`,
  };
}

/**
 * Writes the template into a trusted checkout (the project folder, never an agent worktree). Anything already at
 * `.ai` is left alone, including a symlink, so an existing folder is never overwritten. Returns the created paths.
 */
export function writeTemplate(dir: string, projectName: string, branch: string, date = new Date()): string[] {
  const aiDir = join(dir, AI_DIR);
  if (exists(aiDir)) return [];
  mkdirSync(aiDir);
  const created: string[] = [];
  for (const [name, content] of Object.entries(templateFiles(projectName, branch, date))) {
    writeFileSync(join(aiDir, name), content, { flag: "wx" });
    created.push(`${AI_DIR}/${name}`);
  }
  return created;
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export const hasTemplateSpace = (dir: string) => !existsSync(join(dir, AI_DIR));

export interface HandoffReply {
  /** Full new contents, keyed by file name. DECISIONS.md is appended instead of replaced. */
  files: AiFiles;
}

const BLOCK = /^=== \.ai\/([A-Z]+\.md) ===[ \t]*\r?\n([\s\S]*?)\r?\n=== end ===[ \t]*$/gm;

/** Parses the file blocks of the handoff agent's reply. Unknown files are ignored; the last block of a file wins. */
export function parseHandoffReply(text: string): HandoffReply {
  const files: AiFiles = {};
  for (const match of text.matchAll(BLOCK)) {
    const name = match[1] as AiFile;
    if (AI_FILES.includes(name)) files[name] = `${(match[2] ?? "").trim()}\n`;
  }
  return { files };
}

export interface FileOp {
  /** Path relative to the worktree, always under `.ai/`. */
  path: string;
  content: string;
  mode: "write" | "append";
  /** For appends: written first when the file does not exist yet. */
  header?: string;
}

/** Moves every Markdown heading down two levels so an archived handoff nests under its archive heading. */
function nestHeadings(markdown: string): string {
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced) return line;
      return line.replace(/^(#{1,4})(\s)/, "$1##$2");
    })
    .join("\n");
}

/**
 * Turns a parsed reply into file writes: archive the current HANDOFF.md, replace HANDOFF.md and TASKS.md, append to
 * DECISIONS.md, and replace CONVENTIONS.md or ARCHITECTURE.md when given. Throws when the reply is unusable.
 */
export function planHandoffWrite(current: AiFiles, reply: HandoffReply, now = new Date()): { ops: FileOp[]; skipped: string[] } {
  const { files } = reply;
  if (!files["HANDOFF.md"]?.trim()) throw new Error("The reply has no HANDOFF.md block");
  for (const [name, content] of Object.entries(files)) {
    if (content.length > MAX_AI_FILE_CHARS) throw new Error(`${name} is longer than ${MAX_AI_FILE_CHARS} characters`);
    if (containsSecret(content)) throw new Error(`${name} looks like it contains a secret`);
  }

  const ops: FileOp[] = [];
  const skipped: string[] = [];
  const oldHandoff = current["HANDOFF.md"]?.trim();
  if (oldHandoff) {
    ops.push({
      path: `${AI_DIR}/history/${dayStamp(now)}.md`,
      mode: "append",
      header: `# ${dayStamp(now)}\n`,
      content: `\n## Handoff archived at ${timeStamp(now)}\n\n${nestHeadings(oldHandoff)}\n`,
    });
  }
  ops.push({ path: `${AI_DIR}/HANDOFF.md`, mode: "write", content: files["HANDOFF.md"] });
  if (files["TASKS.md"]?.trim()) ops.push({ path: `${AI_DIR}/TASKS.md`, mode: "write", content: files["TASKS.md"] });

  const decisions = files["DECISIONS.md"]?.trim();
  if (decisions) {
    ops.push({ path: `${AI_DIR}/DECISIONS.md`, mode: "append", header: templateFiles("", "", now)["DECISIONS.md"], content: `\n${decisions}\n` });
  }

  for (const name of ["CONVENTIONS.md", "ARCHITECTURE.md"] as const) {
    const next = files[name];
    if (!next?.trim()) continue;
    const before = current[name] ?? "";
    // A rewrite that drops more than half of a real file is far more likely a truncated reply than an edit.
    if (before.length > 400 && next.length < before.length / 2) {
      skipped.push(name);
      continue;
    }
    ops.push({ path: `${AI_DIR}/${name}`, mode: "write", content: next });
  }
  return { ops, skipped };
}
