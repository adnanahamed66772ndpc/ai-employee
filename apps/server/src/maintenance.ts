import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Brain, Task } from "@ai-employee/brain";
import type { Orchestrator } from "./pipeline.ts";

/*
 * Housekeeping the owner should never have to remember: old task work folders are removed (their branches stay) and
 * the brain is copied every night.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days a stopped task's work folder is kept. Needs-help tasks get longer, so the owner can still continue them. */
export const WORKTREE_RETENTION_DAYS: Partial<Record<Task["status"], number>> = {
  failed: 3,
  cancelled: 3,
  needs_human: 14,
  // Finished tasks normally lose their folder right away; this catches folders a failed removal left behind.
  done: 1,
  rejected: 1,
};

export const BACKUP_HOUR = 3;
export const BACKUPS_KEPT = 7;
const BACKUP_NAME = /^brain-\d{8}-\d{6}\.db$/;

/** Stopped tasks whose work folder is older than its retention. */
export function staleWorktrees(tasks: Task[], now: Date, running: readonly string[] = []): Task[] {
  return tasks.filter((task) => {
    const days = WORKTREE_RETENTION_DAYS[task.status];
    if (days === undefined || !task.worktreePath || running.includes(task.id)) return false;
    return now.getTime() - new Date(task.updatedAt).getTime() >= days * DAY_MS;
  });
}

const pad = (n: number) => String(n).padStart(2, "0");

export function backupName(now: Date): string {
  return `brain-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.db`;
}

/** Automatic backups beyond the newest `keep`. Copies with other names (for example taken before a deploy) are never touched. */
export function backupsToDelete(names: string[], keep = BACKUPS_KEPT): string[] {
  return names
    .filter((name) => BACKUP_NAME.test(name))
    .sort()
    .reverse()
    .slice(keep);
}

/** The next time the clock shows `hour`:00 (server local time). */
export function nextRunAt(now: Date, hour = BACKUP_HOUR): Date {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

export interface BackupInfo {
  name: string;
  bytes: number;
  createdAt: string;
}

export interface MaintenanceStatus {
  backupDir: string;
  keep: number;
  nextBackupAt: string | null;
  backups: BackupInfo[];
  lastCleanup: { at: string; removed: number } | null;
}

export class Maintenance {
  private readonly now: () => Date;
  private backupTimer: NodeJS.Timeout | undefined;
  private cleanupTimer: NodeJS.Timeout | undefined;
  private nextBackup: Date | null = null;
  private lastCleanup: MaintenanceStatus["lastCleanup"] = null;

  constructor(
    private readonly deps: {
      brain: Brain;
      orchestrator: Pick<Orchestrator, "cleanupWorktree" | "runningTaskIds">;
      backupDir: string;
      log: (message: string) => void;
      now?: () => Date;
    },
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Cleans up now and every hour, and backs up every night at BACKUP_HOUR. */
  start(): void {
    const clean = () => void this.cleanWorktrees().catch((error: Error) => this.deps.log(`cleanup failed: ${error.message}`));
    clean();
    this.cleanupTimer = setInterval(clean, 60 * 60 * 1000);
    this.cleanupTimer.unref();
    this.scheduleBackup();
  }

  stop(): void {
    clearInterval(this.cleanupTimer);
    clearTimeout(this.backupTimer);
  }

  private scheduleBackup(): void {
    this.nextBackup = nextRunAt(this.now());
    this.backupTimer = setTimeout(() => {
      try {
        this.backup();
      } catch (error) {
        this.deps.log(`nightly backup failed: ${(error as Error).message}`);
      }
      this.scheduleBackup();
    }, this.nextBackup.getTime() - this.now().getTime());
    this.backupTimer.unref();
  }

  async cleanWorktrees(): Promise<number> {
    const stale = staleWorktrees(this.deps.brain.listTasksWithWorktree(), this.now(), this.deps.orchestrator.runningTaskIds);
    let removed = 0;
    for (const candidate of stale) {
      // Look again right before removing: the owner may have continued the task while earlier folders were removed.
      const task = this.deps.brain.getTask(candidate.id);
      if (!task || staleWorktrees([task], this.now(), this.deps.orchestrator.runningTaskIds).length === 0) continue;
      try {
        await this.deps.orchestrator.cleanupWorktree(task.id, "cleanup");
        if (!this.deps.brain.getTask(task.id)?.worktreePath) removed++;
      } catch (error) {
        this.deps.log(`cleanup: could not remove the work folder of task ${task.id.slice(0, 8)}: ${(error as Error).message}`);
      }
    }
    this.lastCleanup = { at: this.now().toISOString(), removed };
    if (removed) this.deps.log(`cleanup: removed ${removed} old task work folder${removed === 1 ? "" : "s"}`);
    return removed;
  }

  /** Copies the brain and drops automatic copies beyond the newest BACKUPS_KEPT. */
  backup(): { name: string; removed: string[] } {
    mkdirSync(this.deps.backupDir, { recursive: true, mode: 0o700 });
    const name = backupName(this.now());
    const path = join(this.deps.backupDir, name);
    if (existsSync(path)) rmSync(path);
    this.deps.brain.backupTo(path);
    // The brain holds task logs and memory; only the server's user should read a copy.
    chmodSync(path, 0o600);
    const removed = backupsToDelete(readdirSync(this.deps.backupDir));
    for (const old of removed) rmSync(join(this.deps.backupDir, old), { force: true });
    this.deps.log(`backup: saved ${name}${removed.length ? `, removed ${removed.length} older` : ""}`);
    return { name, removed };
  }

  status(): MaintenanceStatus {
    const dir = this.deps.backupDir;
    const backups = existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => name.endsWith(".db"))
          .map((name) => {
            const stat = statSync(join(dir, name));
            return { name, bytes: stat.size, createdAt: stat.mtime.toISOString() };
          })
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      : [];
    return { backupDir: dir, keep: BACKUPS_KEPT, nextBackupAt: this.nextBackup?.toISOString() ?? null, backups, lastCleanup: this.lastCleanup };
  }
}
