import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Brain, type Task } from "@ai-employee/brain";
import { backupName, backupsToDelete, Maintenance, nextRunAt, staleWorktrees } from "./maintenance.ts";

const NOW = new Date(2026, 8, 14, 12, 0, 0);
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
const task = (status: Task["status"], days: number, patch: Partial<Task> = {}) =>
  ({ id: `${status}-${days}`, status, worktreePath: "/w", updatedAt: daysAgo(days), ...patch }) as Task;

describe("maintenance rules", () => {
  it("keeps stopped work 3 days, needs-help work 14 days, and never touches active or running tasks", () => {
    const tasks = [
      task("failed", 2),
      task("failed", 3),
      task("cancelled", 4),
      task("needs_human", 13),
      task("needs_human", 14),
      task("done", 2),
      task("awaiting_approval", 30),
      task("coding", 30),
      task("failed", 10, { id: "running" }),
      task("failed", 10, { id: "no-folder", worktreePath: null }),
    ];
    expect(staleWorktrees(tasks, NOW, ["running"]).map((t) => t.id)).toEqual(["failed-3", "cancelled-4", "needs_human-14", "done-2"]);
  });

  it("names backups by time and deletes only automatic copies beyond the newest seven", () => {
    expect(backupName(NOW)).toBe("brain-20260914-120000.db");
    const names = Array.from({ length: 9 }, (_, i) => `brain-2026090${i + 1}-030000.db`);
    expect(backupsToDelete([...names, "brain-20260913-182555-before-project-manager.db", "notes.txt"])).toEqual(["brain-20260902-030000.db", "brain-20260901-030000.db"]);
  });

  it("schedules the next 03:00", () => {
    expect(nextRunAt(new Date(2026, 8, 14, 2, 59))).toEqual(new Date(2026, 8, 14, 3, 0));
    expect(nextRunAt(new Date(2026, 8, 14, 3, 0))).toEqual(new Date(2026, 8, 15, 3, 0));
  });
});

describe("Maintenance", () => {
  let dir: string;
  let brain: Brain;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ai-employee-maintenance-"));
    brain = new Brain(join(dir, "brain.db"));
  });
  afterEach(() => {
    brain.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("copies the brain into a readable database and keeps the newest seven automatic copies", () => {
    const project = brain.createProject({ name: "Shop", localPath: "/srv/ai-projects/shop" });
    const backups = join(dir, "backups");
    const maintenance = new Maintenance({ brain, orchestrator: { cleanupWorktree: async () => {}, runningTaskIds: [] }, backupDir: backups, log: () => {}, now: () => NOW });
    maintenance.backup();
    for (let day = 1; day <= 7; day++) writeFileSync(join(backups, `brain-2026090${day}-030000.db`), "");
    writeFileSync(join(backups, "brain-before-deploy.db"), "");

    const { name, removed } = maintenance.backup();
    expect(name).toBe("brain-20260914-120000.db");
    expect(removed).toEqual(["brain-20260901-030000.db"]);
    expect(readdirSync(backups).sort()).toHaveLength(8);

    const copy = new Brain(join(backups, name));
    expect(copy.getProject(project.id)?.name).toBe("Shop");
    copy.close();
    expect(maintenance.status().backups[0]).toMatchObject({ name });
  });

  it("removes only stale work folders through the orchestrator", async () => {
    const project = brain.createProject({ name: "Shop", localPath: "/srv/ai-projects/shop" });
    const session = brain.createSession(project.id, "s");
    const old = brain.createTask(session.id, "old");
    const fresh = brain.createTask(session.id, "fresh");
    brain.updateTask(old.id, { status: "failed", worktreePath: "/w/old" });
    brain.updateTask(fresh.id, { status: "failed", worktreePath: "/w/fresh" });
    const removed: string[] = [];
    const maintenance = new Maintenance({
      brain,
      orchestrator: {
        runningTaskIds: [],
        cleanupWorktree: async (id, reason) => {
          removed.push(`${id}:${reason}`);
          brain.updateTask(id, { worktreePath: null });
        },
      },
      backupDir: join(dir, "backups"),
      log: () => {},
      // Four days after both updates; the fresh task is moved to "now" first.
      now: () => new Date(Date.now() + 4 * 24 * 60 * 60 * 1000),
    });
    brain.db.prepare("update tasks set updated_at = ? where id = ?").run(new Date(Date.now() + 3.5 * 24 * 60 * 60 * 1000).toISOString(), fresh.id);

    expect(await maintenance.cleanWorktrees()).toBe(1);
    expect(removed).toEqual([`${old.id}:cleanup`]);
    expect(maintenance.status().lastCleanup).toMatchObject({ removed: 1 });
  });

  it("keeps going when a folder cannot be removed, and skips a task that was continued meanwhile", async () => {
    const project = brain.createProject({ name: "Shop", localPath: "/srv/ai-projects/shop" });
    const session = brain.createSession(project.id, "s");
    const [broken, continued, old] = ["broken", "continued", "old"].map((name, i) => {
      const t = brain.createTask(session.id, name);
      brain.updateTask(t.id, { status: "failed", worktreePath: `/w/${name}` });
      brain.db.prepare("update tasks set updated_at = ? where id = ?").run(`2000-01-0${i + 1}T00:00:00.000Z`, t.id);
      return t;
    });
    const logs: string[] = [];
    const maintenance = new Maintenance({
      brain,
      orchestrator: {
        runningTaskIds: [],
        cleanupWorktree: async (id) => {
          if (id === broken!.id) {
            brain.updateTask(continued!.id, { status: "queued" });
            throw new Error("not a git repository");
          }
          brain.updateTask(id, { worktreePath: null });
        },
      },
      backupDir: join(dir, "backups"),
      log: (message) => logs.push(message),
    });

    expect(await maintenance.cleanWorktrees()).toBe(1);
    expect(brain.getTask(old!.id)?.worktreePath).toBeNull();
    expect(brain.getTask(continued!.id)?.worktreePath).toBe("/w/continued");
    expect(logs.some((l) => /could not remove the work folder/.test(l))).toBe(true);
  });
});
