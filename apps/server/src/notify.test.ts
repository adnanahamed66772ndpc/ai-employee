import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Brain } from "@ai-employee/brain";
import { notificationText, TelegramNotifier, watchForNotifications, type Notifier } from "./notify.ts";

let brain: Brain;
beforeEach(() => {
  brain = new Brain(":memory:");
});
afterEach(() => brain.close());

const newTask = () => {
  const project = brain.createProject({ name: "Shop", localPath: "/srv/ai-projects/shop" });
  return { project, task: brain.createTask(brain.createSession(project.id, "Checkout").id, "Add a coupon field\nwith validation") };
};

describe("notifications", () => {
  it("says what happened, where, and links to the task", () => {
    const { project, task } = newTask();
    const text = notificationText("approval", { task, project, costUsd: 0.0123, publicUrl: new URL("https://ai.example.com"), stat: " 2 files changed, 10 insertions(+)" });
    expect(text).toContain("Needs you: approve the push and pull request");
    expect(text).toContain("Project: Shop");
    expect(text).toContain("Task: Add a coupon field");
    expect(text).not.toContain("with validation");
    expect(text).toContain("Changes: 2 files changed, 10 insertions(+)");
    expect(text).toContain("Model cost: $0.0123");
    expect(text).toContain(`Open: https://ai.example.com/#/session/${task.sessionId}/${task.id}`);
  });

  it("messages once per approval or state, never for decided approvals", () => {
    const { task } = newTask();
    const sent: string[] = [];
    const notifier: Notifier = { configured: true, send: async (text) => void sent.push(text) };
    watchForNotifications(brain, notifier, { log: () => {} });

    const approval = brain.createApproval(task.id, "push_and_pr", "Push", { stat: "1 file changed" });
    brain.decideApproval(approval.id, "approved");
    brain.updateTask(task.id, { status: "needs_human" });
    brain.updateTask(task.id, { status: "needs_human", reviewRounds: 3 });
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain("Needs you");
    expect(sent[1]).toContain("Needs your help");
  });

  it("never leaks the bot token in errors", async () => {
    const token = "123456789:AAsecretsecretsecretsecretsecret12345";
    const offline = new TelegramNotifier(token, "42", (async (url: string | URL | Request) => {
      throw new Error(`connect failed for ${String(url)}`);
    }) as typeof fetch);
    await expect(offline.send("hi")).rejects.toThrow(/Could not reach Telegram/);
    await offline.send("hi").catch((error: Error) => expect(error.message).not.toContain(token));

    const refused = new TelegramNotifier(token, "42", (async () => Response.json({ ok: false, description: "chat not found" }, { status: 400 })) as unknown as typeof fetch);
    await expect(refused.send("hi")).rejects.toThrow("Telegram refused the message (HTTP 400): chat not found");
    expect(new TelegramNotifier(undefined, "42").configured).toBe(false);
  });
});
