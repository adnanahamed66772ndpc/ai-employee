import { useState } from "react";
import { api, type Epic, type Goal, type GoalDetail } from "../api.ts";
import { tokens, usd } from "../format.ts";
import { useAction, useData, useLive } from "../hooks.ts";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { Markdown } from "./Markdown.tsx";

const GOAL_STATUS: Record<Goal["status"], [label: string, tone: string]> = {
  planning: ["Planning", "status-working"],
  awaiting_approval: ["Needs you", "status-needs"],
  running: ["Working", "status-working"],
  paused: ["Paused", "status-needs"],
  done: ["Done", "status-done"],
  cancelled: ["Cancelled", ""],
  failed: ["Failed", "status-failed"],
};

const EPIC_STATUS: Record<Epic["status"], [label: string, tone: string]> = {
  pending: ["Not started", ""],
  planning: ["Planning", "status-working"],
  running: ["Working", "status-working"],
  awaiting_approval: ["Needs you", "status-needs"],
  pushing: ["Pushing", "status-working"],
  done: ["Done", "status-done"],
  paused: ["Paused", "status-needs"],
  cancelled: ["Cancelled", ""],
};

const firstLine = (text: string) => text.split("\n").find((line) => line.trim()) ?? text;

/** The large goals of a session: the project manager's epics, their tasks, and what waits for the owner. */
export function GoalList({ sessionId }: { sessionId: string }) {
  const version = useLive((c) => c.kind === "goal" || c.kind === "epic" || c.kind === "approval" || c.kind === "run" || (c.kind === "task" && c.sessionId === sessionId));
  const goals = useData(() => api.goals(sessionId), [sessionId, version]);
  if (!goals.data?.length) return null;
  return (
    <section className="section goals" aria-label="Goals">
      {goals.data.map((detail) => (
        <GoalCard key={detail.goal.id} detail={detail} />
      ))}
    </section>
  );
}

function GoalCard({ detail }: { detail: GoalDetail }) {
  const { goal, epics, usage, approvals } = detail;
  const [label, tone] = GOAL_STATUS[goal.status];
  const [note, setNote] = useState("");
  const [budget, setBudget] = useState(goal.budgetUsd ? String(goal.budgetUsd) : "");
  const act = useAction();
  const finished = goal.status === "done" || goal.status === "cancelled";
  const canContinue = goal.status === "paused" || goal.status === "failed";
  const doneEpics = epics.filter((e) => e.status === "done").length;

  const onContinue = async (e: React.FormEvent) => {
    e.preventDefault();
    const amount = budget.trim() ? Number(budget) : null;
    if (amount !== null && !(amount > 0)) {
      act.setError("The budget must be a number of dollars above 0, or empty for no limit");
      return;
    }
    if (await act.run(() => api.continueGoal(goal.id, { note: note.trim() || undefined, budgetUsd: amount }))) setNote("");
  };

  const onCancel = () => {
    if (window.confirm("Cancel this goal? Running tasks stop, and nothing more is planned or pushed. Branches already made stay.")) {
      void act.run(() => api.cancelGoal(goal.id));
    }
  };

  return (
    <article className="sheet goal">
      <header className="goal-head">
        <span className={`tag status ${tone}`}>{label}</span>
        <h2 className="goal-title">{firstLine(goal.prompt)}</h2>
        <span className="spacer" />
        {epics.length > 0 && (
          <span className="muted small">
            {doneEpics} of {epics.length} epics done
          </span>
        )}
        {usage.costUsd > 0 && (
          <span className="muted small" title={`${(usage.inputTokens + usage.outputTokens).toLocaleString()} tokens`}>
            {usd(usage.costUsd)} for {tokens(usage.inputTokens + usage.outputTokens)} tokens
          </span>
        )}
        {!finished && (
          <button type="button" className="button-quiet button-small" onClick={onCancel} disabled={act.busy}>
            Cancel goal
          </button>
        )}
      </header>

      {goal.status === "planning" && epics.length === 0 && <p className="muted">The project manager is splitting the goal into epics.</p>}
      {goal.summary && <Markdown text={goal.summary} />}
      {goal.error && !finished && <p className={`notice ${canContinue ? "notice-needs" : "notice-danger"}`}>{goal.error}</p>}
      {approvals.map((approval) => (
        <ApprovalCard key={approval.id} approval={approval} />
      ))}

      {epics.length > 0 && (
        <ol className="epics">
          {epics.map((epic) => (
            <EpicRow key={epic.id} epic={epic} sessionId={goal.sessionId} />
          ))}
        </ol>
      )}

      {canContinue && (
        <form className="form goal-continue" onSubmit={onContinue}>
          <label className="field field-wide">
            Note for the next try
            <span className="field-hint">Optional. Tell the team what to do differently, for example "Keep the prices in a JSON file instead of a database".</span>
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <label className="field">
            Budget for the whole goal (US dollars)
            <span className="field-hint">Empty for no limit</span>
            <input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" placeholder="2.00" />
          </label>
          <div className="form-actions">
            <button type="submit" className="button-primary" disabled={act.busy}>
              {act.busy ? "Continuing…" : "Continue the goal"}
            </button>
          </div>
        </form>
      )}
      {act.error && <p className="error-text">{act.error}</p>}
    </article>
  );
}

function EpicRow({ epic, sessionId }: { epic: GoalDetail["epics"][number]; sessionId: string }) {
  const [label, tone] = EPIC_STATUS[epic.status];
  const done = new Set(epic.tasks.filter((t) => t.status === "done").map((t) => t.epicPosition));
  const latest = (position: number) => epic.tasks.filter((t) => t.epicPosition === position).at(-1);

  return (
    <li className="epic">
      <div className="epic-head">
        <strong>{epic.title}</strong>
        <span className={`tag status ${tone}`}>{label}</span>
        {epic.plannedTasks.length > 0 && (
          <span className="muted small">
            {done.size} of {epic.plannedTasks.length} tasks
          </span>
        )}
        {epic.prUrl && (
          <a href={epic.prUrl} target="_blank" rel="noreferrer">
            Pull request
          </a>
        )}
      </div>
      {epic.description && <p className="muted small">{epic.description}</p>}
      {epic.plannedTasks.length > 0 && (
        <ol className="epic-tasks">
          {epic.plannedTasks.map((planned, position) => {
            const task = latest(position);
            return (
              <li key={position} className={done.has(position) ? "is-done" : undefined}>
                {task ? <a href={`#/session/${sessionId}/${task.id}`}>{planned.title}</a> : planned.title}
                {done.has(position) ? <span className="visually-hidden">, done</span> : task ? <span className="muted small"> {task.status.replace("_", " ")}</span> : null}
              </li>
            );
          })}
        </ol>
      )}
      {epic.error && epic.status === "paused" && <p className="error-text small">{epic.error}</p>}
    </li>
  );
}
