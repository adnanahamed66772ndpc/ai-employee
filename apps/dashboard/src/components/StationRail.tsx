import type { CSSProperties } from "react";
import type { BrainEvent, Task } from "../api.ts";

export type StationState = "done" | "active" | "attention" | "needs" | "failed" | "skipped" | "waiting";

export interface Station {
  key: string;
  name: string;
  state: StationState;
  note: string;
}

const STATE_LABEL: Record<StationState, string> = {
  done: "done",
  active: "in progress",
  attention: "needs another pass",
  needs: "waiting for you",
  failed: "stopped here",
  skipped: "skipped",
  waiting: "not started",
};

const STATION_OF_STATUS: Partial<Record<Task["status"], string>> = {
  planning: "plan",
  coding: "code",
  checking: "checks",
  reviewing: "review",
  pushing: "decision",
};

/** Where a task is in the Plan → … → Your call sequence, derived from its event log. */
export function deriveStations(task: Task, events: BrainEvent[]): Station[] {
  const ofType = (type: string) => events.filter((e) => e.type === type);
  const lastOf = (type: string) => ofType(type).at(-1);

  const rounds = Math.max(0, ...ofType("round_started").map((e) => Number(e.payload.round) || 0));
  const planned = lastOf("plan_ready");
  const branch = lastOf("branch_created");
  const check = lastOf("check_finished");
  const quick = lastOf("quick_checks");
  const quickFailed = Boolean(quick && !quick.payload.ok);
  const skippedChecks = ofType("checks_skipped").length > 0;
  const review = lastOf("review_verdict");
  const commit = lastOf("committed");
  const criticVerdicts = ofType("critic_verdict");
  const skipped = lastOf("critics_skipped");
  const criticsSkipped = Boolean(skipped);
  const criticsOff = Array.isArray(skipped?.payload.turnedOff) && skipped.payload.turnedOff.length > 0;
  // The latest verdict of each critic decides whether the final round passed.
  const latestByCritic = new Map(criticVerdicts.map((e) => [String(e.payload.critic), e]));
  const criticsPassed = [...latestByCritic.values()].every((e) => e.payload.passed);

  const stations: Station[] = [
    { key: "plan", name: "Plan", state: planned ? "done" : "waiting", note: planned ? "Plan ready" : "" },
    { key: "branch", name: "Branch", state: branch ? "done" : "waiting", note: branch ? `From ${String(branch.payload.base ?? "")}` : "" },
    {
      key: "code",
      name: "Code",
      state: rounds > 0 && (check || quick || skippedChecks || commit) ? "done" : "waiting",
      note: rounds === 0 ? "" : rounds === 1 ? "1 round" : `${rounds} rounds`,
    },
    {
      key: "checks",
      name: "Checks",
      state: quickFailed ? "attention" : check ? (check.payload.ok ? "done" : "attention") : quick ? "done" : skippedChecks ? "skipped" : "waiting",
      note: quickFailed ? "Quick checks failed" : check ? (check.payload.ok ? "Passed" : "Failed") : quick ? "Quick checks passed" : skippedChecks ? "None set" : "",
    },
    {
      key: "review",
      name: "Review",
      state: review ? (review.payload.approved ? "done" : "attention") : "waiting",
      note: review ? (review.payload.approved ? "Approved" : "Changes asked") : "",
    },
    {
      key: "critics",
      name: "Critics",
      state: criticVerdicts.length ? (criticsPassed ? "done" : "attention") : criticsSkipped || commit ? "skipped" : "waiting",
      note: criticVerdicts.length ? (criticsPassed ? "Passed" : "Problems found") : criticsOff ? "Turned off" : criticsSkipped ? "Not needed" : "",
    },
    { key: "commit", name: "Commit", state: commit ? "done" : "waiting", note: commit ? String(commit.payload.sha ?? "").slice(0, 7) : "" },
    { key: "decision", name: "Your call", state: "waiting", note: "" },
  ];

  const decision = stations.find((s) => s.key === "decision")!;
  if (task.status === "awaiting_approval") Object.assign(decision, { state: "needs", note: "Waiting for you" });
  if (task.status === "done") Object.assign(decision, { state: "done", note: task.prUrl ? "Pull request opened" : "Done" });
  if (task.status === "rejected") Object.assign(decision, { state: "skipped", note: "Kept local" });

  const activeKey = task.status === "reviewing" && review?.payload.approved ? "critics" : STATION_OF_STATUS[task.status];
  const active = stations.find((s) => s.key === activeKey);
  if (active) active.state = "active";

  if (task.status === "failed" || task.status === "cancelled" || task.status === "needs_human") {
    const stuck = stations.find((s) => s.state !== "done" && s.state !== "skipped");
    if (stuck) {
      stuck.state = task.status === "needs_human" ? "attention" : "failed";
      stuck.note = task.status === "needs_human" ? "Needs your help" : task.status === "cancelled" ? "Cancelled" : "Stopped here";
    }
  }
  return stations;
}

export const EXAMPLE_STATIONS: Station[] = [
  { key: "plan", name: "Plan", state: "done", note: "Reads the code and memory" },
  { key: "branch", name: "Branch", state: "done", note: "Works on its own branch" },
  { key: "code", name: "Code", state: "done", note: "Coder makes the change" },
  { key: "checks", name: "Checks", state: "done", note: "Your tests run" },
  { key: "review", name: "Review", state: "done", note: "A second model reviews" },
  { key: "critics", name: "Critics", state: "done", note: "UI and security checks" },
  { key: "commit", name: "Commit", state: "done", note: "Git agent commits" },
  { key: "decision", name: "Your call", state: "needs", note: "You approve the push" },
];

export function StationList({ stations, label }: { stations: Station[]; label: string }) {
  return (
    <div className="rail-wrap">
      <ol className="rail" aria-label={label} style={{ "--stations": stations.length } as CSSProperties}>
        {stations.map((station) => (
          <li key={station.key} className={`station is-${station.state}`}>
            <span className="station-dot" aria-hidden="true" />
            <span className="station-name">{station.name}</span>
            <span className="station-note">{station.note}</span>
            <span className="visually-hidden">, {STATE_LABEL[station.state]}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function StationRail({ task, events }: { task: Task; events: BrainEvent[] }) {
  return <StationList stations={deriveStations(task, events)} label="Task progress" />;
}
