import { isAbsolute, relative, resolve } from "node:path";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@ai-employee/dsh-client";

export type PermissionDecision = "allow" | "reject";

/** Commands agents must never run themselves: the Git agent owns commits/pushes/PRs, and nothing destructive. */
const FORBIDDEN_COMMANDS: RegExp[] = [
  /\bgit\s+push\b/i,
  /\bgit\s+commit\b/i,
  /\bgit\s+remote\s+(add|set-url|remove|rm)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-\w*f/i,
  /\bgit\s+(checkout|switch)\s+(-\S+\s+)*(main|master|develop)\b/i,
  /\bgit\s+branch\s+-D\b/,
  /(^|[\s;&|("'`])gh\s+\w/i,
  /\bnpm\s+publish\b/i,
  /\b(curl|wget|iwr|Invoke-WebRequest)\b[^|\n]*\|\s*(ba|z)?sh\b/i,
  /\brm\s+-\w*r\w*\s+(\/|~|[A-Za-z]:[\\/]?)(\s|$)/i,
  /\bRemove-Item\b[^\n]*-Recurse[^\n]*\s['"]?[A-Za-z]:\\?['"]?(\s|$)/i,
  /\b(format\s+[A-Za-z]:|diskpart|shutdown|reg\s+delete|Set-ExecutionPolicy)\b/i,
];

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) collectStrings(v, out);
  return out;
}

export function isInside(root: string, path: string): boolean {
  const rel = relative(root, resolve(root, path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * DeepSeek Harness only raises `session/request_permission` when a sandboxed call is retried with wider
 * `sandbox_permissions`, and the request carries little more than the tool call id. Confinement comes from
 * the dsh sandbox and the OS user the agents run as, so escalations are rejected unless the request proves
 * it is a plain edit inside the project by a writable agent.
 */
export function decidePermission(request: RequestPermissionRequest, context: { cwd: string; writable: boolean }): PermissionDecision {
  const { kind, title, rawInput, locations } = request.toolCall;
  const text = [title ?? "", ...collectStrings(rawInput)].join("\n");
  if (FORBIDDEN_COMMANDS.some((pattern) => pattern.test(text))) return "reject";

  const paths = (locations ?? []).map((l) => l.path);
  const isEdit = kind === "edit" || kind === "delete" || kind === "move";
  if (context.writable && isEdit && paths.length > 0 && paths.every((p) => isInside(context.cwd, p))) return "allow";
  return "reject";
}

export function permissionResponse(request: RequestPermissionRequest, allow: boolean): RequestPermissionResponse {
  const preferred = allow ? (["allow_once", "allow_always"] as const) : (["reject_once", "reject_always"] as const);
  for (const kind of preferred) {
    const option = request.options.find((o) => o.kind === kind);
    if (option) return { outcome: { outcome: "selected", optionId: option.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}
