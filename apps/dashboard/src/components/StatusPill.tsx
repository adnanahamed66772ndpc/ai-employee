import type { Task } from "../api.ts";

const LABELS: Record<Task["status"], string> = {
  queued: "Queued",
  planning: "Planning",
  coding: "Coding",
  checking: "Running checks",
  reviewing: "In review",
  awaiting_approval: "Needs you",
  pushing: "Pushing",
  done: "Done",
  rejected: "Kept local",
  needs_human: "Needs your help",
  failed: "Failed",
  cancelled: "Cancelled",
};

const TONE: Record<Task["status"], string> = {
  queued: "",
  planning: "status-working",
  coding: "status-working",
  checking: "status-working",
  reviewing: "status-working",
  pushing: "status-working",
  awaiting_approval: "status-needs",
  needs_human: "status-needs",
  done: "status-done",
  failed: "status-failed",
  rejected: "",
  cancelled: "",
};

export function StatusPill({ status }: { status: Task["status"] }) {
  return <span className={`tag status ${TONE[status]}`}>{LABELS[status]}</span>;
}
