import { describe, expect, it } from "vitest";
import type { RequestPermissionRequest } from "@ai-employee/dsh-client";
import { decidePermission, isInside, permissionResponse } from "./policy.ts";

const cwd = process.platform === "win32" ? "D:\\work\\app" : "/work/app";

function request(toolCall: Record<string, unknown>): RequestPermissionRequest {
  return {
    sessionId: "s1",
    toolCall: { toolCallId: "t1", ...toolCall },
    options: [
      { optionId: "yes", name: "Allow", kind: "allow_once" },
      { optionId: "always", name: "Always", kind: "allow_always" },
      { optionId: "no", name: "Reject", kind: "reject_once" },
    ],
  } as RequestPermissionRequest;
}

describe("decidePermission", () => {
  it("rejects the bare sandbox escalations DeepSeek Harness sends", () => {
    expect(decidePermission(request({}), { cwd, writable: true })).toBe("reject");
    expect(decidePermission(request({}), { cwd, writable: false })).toBe("reject");
  });

  it("allows an explicit edit inside the project only for a writable agent", () => {
    const inside = request({ kind: "edit", title: "Edit src/a.ts", locations: [{ path: "src/a.ts" }] });
    const outside = request({ kind: "edit", title: "Edit hosts", locations: [{ path: "../../etc/hosts" }] });
    expect(decidePermission(inside, { cwd, writable: true })).toBe("allow");
    expect(decidePermission(inside, { cwd, writable: false })).toBe("reject");
    expect(decidePermission(outside, { cwd, writable: true })).toBe("reject");
  });

  it("rejects push, commit, gh and destructive commands", () => {
    for (const command of ["git push origin main", "git commit -m x", "gh pr create", "rm -rf /", "git reset --hard HEAD~3", "git switch main"]) {
      expect(decidePermission(request({ kind: "execute", title: "Run", rawInput: { command } }), { cwd, writable: true })).toBe("reject");
    }
    const windows = request({ kind: "execute", rawInput: { command: "Remove-Item -Recurse -Force C:\\" } });
    expect(decidePermission(windows, { cwd, writable: true })).toBe("reject");
  });

  it("does not grant wider access for ordinary commands either", () => {
    expect(decidePermission(request({ kind: "execute", rawInput: { command: "npm test" } }), { cwd, writable: true })).toBe("reject");
  });
});

describe("helpers", () => {
  it("detects paths inside a root", () => {
    expect(isInside(cwd, "src/index.ts")).toBe(true);
    expect(isInside(cwd, "..")).toBe(false);
  });

  it("prefers one-time options", () => {
    const req = request({ kind: "read" });
    expect(permissionResponse(req, true)).toEqual({ outcome: { outcome: "selected", optionId: "yes" } });
    expect(permissionResponse(req, false)).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
    expect(permissionResponse({ ...req, options: [] }, false)).toEqual({ outcome: { outcome: "cancelled" } });
  });
});
