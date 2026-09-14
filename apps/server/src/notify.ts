import type { Brain, BrainChange, Epic, Goal, Project, Task } from "@ai-employee/brain";

export interface Notifier {
  readonly configured: boolean;
  send(text: string): Promise<void>;
}

const MAX_MESSAGE = 3_500;

/** Sends plain-text messages to one Telegram chat through a bot. The token never appears in errors or logs. */
export class TelegramNotifier implements Notifier {
  constructor(
    private readonly token: string | undefined,
    private readonly chatId: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get configured(): boolean {
    return Boolean(this.token && this.chatId);
  }

  async send(text: string): Promise<void> {
    if (!this.token || !this.chatId) throw new Error("Telegram is not set up: add AI_EMPLOYEE_TELEGRAM_BOT_TOKEN and AI_EMPLOYEE_TELEGRAM_CHAT_ID to .env.local");
    const hide = (message: string) => message.split(this.token!).join("***");
    let res: Response;
    try {
      res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text: text.slice(0, MAX_MESSAGE), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new Error(`Could not reach Telegram: ${hide((error as Error).message)}`);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { description?: string };
      throw new Error(`Telegram refused the message (HTTP ${res.status})${body.description ? `: ${hide(body.description)}` : ""}`);
    }
  }
}

export type NotificationKind = "approval" | "needs_human" | "failed" | "pr_opened";

const HEADLINE: Record<NotificationKind, string> = {
  approval: "Needs you: approve the push and pull request",
  needs_human: "Needs your help: the review did not pass",
  failed: "Task stopped",
  pr_opened: "Pull request opened",
};

export function notificationText(
  kind: NotificationKind,
  details: { task: Task; project: Project | null; costUsd?: number; publicUrl?: URL; stat?: string },
): string {
  const { task, project } = details;
  const firstLine = task.prompt.split("\n").find((line) => line.trim()) ?? task.prompt;
  const lines = [HEADLINE[kind], "", `Project: ${project?.name ?? "unknown"}`, `Task: ${firstLine.slice(0, 300)}`];
  if (kind === "failed" && task.error) lines.push(`Reason: ${task.error.slice(0, 500)}`);
  if (kind === "needs_human" && task.branch) lines.push(`Changes are left on ${task.branch}`);
  if (kind === "pr_opened" && task.prUrl) lines.push(`Pull request: ${task.prUrl}`);
  const changed = details.stat?.trim().split("\n").at(-1)?.trim();
  if (changed) lines.push(`Changes: ${changed}`);
  if (details.costUsd) lines.push(`Model cost: $${details.costUsd.toFixed(4)}`);
  if (details.publicUrl) lines.push("", `Open: ${new URL(`/#/session/${task.sessionId}/${task.id}`, details.publicUrl).href}`);
  return lines.join("\n");
}

export type GoalNotificationKind = "plan" | "epic_push" | "paused";

const GOAL_HEADLINE: Record<GoalNotificationKind, string> = {
  plan: "Needs you: approve the project plan",
  epic_push: "Needs you: push the finished epic",
  paused: "Goal paused",
};

export function goalNotificationText(
  kind: GoalNotificationKind,
  details: { goal: Goal; project: Project | null; epic?: Epic | null; epics?: Epic[]; stat?: string; costUsd?: number; publicUrl?: URL },
): string {
  const { goal, project, epic } = details;
  const firstLine = goal.prompt.split("\n").find((line) => line.trim()) ?? goal.prompt;
  const lines = [GOAL_HEADLINE[kind], "", `Project: ${project?.name ?? "unknown"}`, `Goal: ${firstLine.slice(0, 300)}`];
  if (kind === "plan" && details.epics?.length) lines.push(`Epics: ${details.epics.map((e) => `${e.position + 1}. ${e.title}`).join(", ")}`);
  if (epic) lines.push(`Epic ${epic.position + 1}: ${epic.title}`);
  if (kind === "paused" && goal.error) lines.push(`Reason: ${goal.error.slice(0, 500)}`);
  const changed = details.stat?.trim().split("\n").at(-1)?.trim();
  if (changed) lines.push(`Changes: ${changed}`);
  if (details.costUsd) lines.push(`Goal cost so far: ${details.costUsd.toFixed(4)}`);
  if (details.publicUrl) lines.push("", `Open: ${new URL(`/#/session/${goal.sessionId}`, details.publicUrl).href}`);
  return lines.join("\n");
}

/** Messages the owner when a task or goal needs a decision, gets stuck, fails or opens a pull request. */
export function watchForNotifications(brain: Brain, notifier: Notifier, options: { publicUrl?: URL; log: (message: string) => void }): void {
  if (!notifier.configured) return;
  const sent = new Set<string>();
  const notify = (key: string, kind: NotificationKind, task: Task, stat?: string) => {
    if (sent.has(key)) return;
    sent.add(key);
    const text = notificationText(kind, {
      task,
      project: brain.getProject(task.projectId),
      costUsd: brain.taskUsage(task.id).costUsd,
      publicUrl: options.publicUrl,
      stat,
    });
    notifier.send(text).catch((error: Error) => options.log(`notification failed: ${error.message}`));
  };

  const notifyGoal = (key: string, kind: GoalNotificationKind, goal: Goal, epic?: Epic | null, stat?: string) => {
    if (sent.has(key)) return;
    sent.add(key);
    const text = goalNotificationText(kind, {
      goal,
      project: brain.getProject(goal.projectId),
      epic,
      epics: brain.listEpics(goal.id),
      stat,
      costUsd: brain.goalUsage(goal.id).costUsd,
      publicUrl: options.publicUrl,
    });
    notifier.send(text).catch((error: Error) => options.log(`notification failed: ${error.message}`));
  };

  brain.on("change", (change: BrainChange) => {
    if (change.kind === "goal") {
      const goal = brain.getGoal(change.id);
      // Paused by a stopped task is already covered by that task's message; this covers budgets and push failures too.
      if (goal?.status === "paused") notifyGoal(`goal:${goal.id}:paused:${goal.error ?? ""}`, "paused", goal);
      return;
    }
    if (change.kind === "approval") {
      const approval = brain.getApproval(change.id);
      if (approval?.status === "pending" && (approval.kind === "plan" || approval.kind === "epic_push") && approval.goalId) {
        const goal = brain.getGoal(approval.goalId);
        const epic = approval.epicId ? brain.getEpic(approval.epicId) : null;
        const stat = typeof approval.payload.stat === "string" ? approval.payload.stat : undefined;
        if (goal) notifyGoal(`approval:${approval.id}`, approval.kind, goal, epic, stat);
        return;
      }
      const task = approval?.taskId ? brain.getTask(approval.taskId) : null;
      if (approval?.kind === "push_and_pr" && approval.status === "pending" && task) {
        notify(`approval:${approval.id}`, "approval", task, typeof approval.payload.stat === "string" ? approval.payload.stat : undefined);
      }
    } else if (change.kind === "task") {
      const task = brain.getTask(change.id);
      if (!task) return;
      if (task.status === "needs_human") notify(`${task.id}:needs_human`, "needs_human", task);
      if (task.status === "failed") notify(`${task.id}:failed`, "failed", task);
      if (task.status === "done" && task.prUrl) notify(`${task.id}:done`, "pr_opened", task);
    }
  });
}
