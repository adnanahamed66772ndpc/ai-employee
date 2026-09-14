import { useState } from "react";
import { api, type Task } from "../api.ts";
import { ApprovalCard } from "../components/ApprovalCard.tsx";
import { RunLog } from "../components/RunLog.tsx";
import { GoalList } from "../components/GoalList.tsx";
import { StationRail } from "../components/StationRail.tsx";
import { StatusPill } from "../components/StatusPill.tsx";
import { timeAgo, tokens, usd } from "../format.ts";
import { useAction, useData, useLive } from "../hooks.ts";

const ACTIVE = new Set<Task["status"]>(["queued", "planning", "coding", "checking", "reviewing", "pushing"]);
const CANCELLABLE = new Set<Task["status"]>(["queued", "planning", "coding", "checking", "reviewing", "awaiting_approval", "needs_human"]);

export function SessionPage({ sessionId, taskId }: { sessionId: string; taskId?: string }) {
  const info = useData(() => api.session(sessionId), [sessionId]);
  const tasksVersion = useLive((c) => c.kind === "task" && c.sessionId === sessionId);
  const tasks = useData(() => api.tasks(sessionId), [tasksVersion]);
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"task" | "goal">("task");
  const [budget, setBudget] = useState("");
  const submit = useAction();

  const list = [...(tasks.data ?? [])].reverse();
  const selectedId = taskId ?? list[0]?.id;

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) {
      submit.setError("Describe the task first");
      return;
    }
    if (mode === "goal") {
      const amount = budget.trim() ? Number(budget) : null;
      if (amount !== null && !(amount > 0)) {
        submit.setError("The budget must be a number of dollars above 0, or empty for no limit");
        return;
      }
      if (await submit.run(() => api.createGoal(sessionId, { prompt: prompt.trim(), budgetUsd: amount }))) {
        setPrompt("");
        window.location.hash = `#/session/${sessionId}`;
      }
      return;
    }
    let id: string | undefined;
    if (await submit.run(async () => (id = (await api.createTask(sessionId, prompt.trim())).id))) {
      setPrompt("");
      window.location.hash = `#/session/${sessionId}/${id}`;
    }
  };

  return (
    <div className="page page-wide">
      <header className="page-head">
        {info.data?.project && (
          <p className="crumb">
            <a href={`#/project/${info.data.project.id}`}>{info.data.project.name}</a>
          </p>
        )}
        <h1>{info.data?.session.title ?? "Session"}</h1>
      </header>

      <form className="sheet composer" onSubmit={start}>
        <div className="segmented" role="tablist" aria-label="What to start">
          <button type="button" role="tab" aria-selected={mode === "task"} onClick={() => setMode("task")}>
            One task
          </button>
          <button type="button" role="tab" aria-selected={mode === "goal"} onClick={() => setMode("goal")}>
            Big goal
          </button>
        </div>
        <label className="visually-hidden" htmlFor="task-prompt">
          Describe the task
        </label>
        <textarea
          id="task-prompt"
          rows={3}
          value={prompt}
          placeholder={
            mode === "goal"
              ? "Describe the whole thing to build, for example an online shop with sign-in, a product list, a cart and checkout."
              : "Describe what to build or fix. Be as specific as you would be with a teammate."
          }
          onChange={(e) => {
            setPrompt(e.target.value);
            submit.setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void start(e);
          }}
        />
        <div className="composer-foot">
          <span className="muted small">
            {mode === "goal"
              ? "The project manager splits it into epics for you to approve, then works through them one small task at a time. You approve every epic before it is pushed."
              : "The team plans, codes, tests and reviews it. You decide whether it is pushed."}
          </span>
          {mode === "goal" && (
            <input
              className="composer-budget"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              inputMode="decimal"
              placeholder="Budget in $, optional"
              aria-label="Budget for the whole goal in US dollars"
            />
          )}
          <span className="spacer" />
          {submit.error && <span className="error-text">{submit.error}</span>}
          <span className="muted small">
            <kbd>Ctrl</kbd> + <kbd>Enter</kbd>
          </span>
          <button type="submit" className="button-primary" disabled={submit.busy}>
            {submit.busy ? "Starting…" : mode === "goal" ? "Plan the goal" : "Start task"}
          </button>
        </div>
      </form>

      <GoalList sessionId={sessionId} />

      <div className="work">
        <nav className="orders" aria-label="Tasks in this session">
          {list.map((task) => (
            <a key={task.id} href={`#/session/${sessionId}/${task.id}`} className="order-item" aria-current={task.id === selectedId ? "true" : undefined}>
              <span className="order-prompt">{task.prompt}</span>
              <span className="order-foot">
                <StatusPill status={task.status} />
                <span>{timeAgo(task.createdAt)}</span>
              </span>
            </a>
          ))}
          {tasks.data?.length === 0 && <p className="empty">No tasks yet. Describe one above to get started.</p>}
        </nav>
        {selectedId && <TaskView key={selectedId} taskId={selectedId} root={info.data?.project?.localPath} />}
      </div>
    </div>
  );
}

function TaskView({ taskId, root }: { taskId: string; root?: string }) {
  const version = useLive((c) => (c.kind === "task" && c.id === taskId) || ((c.kind === "event" || c.kind === "approval") && c.taskId === taskId));
  const detail = useData(() => api.task(taskId), [version]);
  const cancel = useAction();
  if (!detail.data) return <p className="empty">{detail.error ?? "Loading…"}</p>;
  const { task, events, runs, approvals, usage } = detail.data;
  const pending = approvals.filter((a) => a.status === "pending");
  const totalTokens = usage.inputTokens + usage.outputTokens;
  // Stopped before its commit with its work folder kept: the owner can continue it with a note.
  const stopped =
    task.kind === "code" && Boolean(task.plan && task.worktreePath) && (task.status === "needs_human" || (task.status === "failed" && !task.commitSha));

  const onCancel = () => {
    if (window.confirm("Cancel this task? Work in progress stops and nothing is pushed.")) void cancel.run(() => api.cancelTask(task.id));
  };

  return (
    <article className="order">
      <header className="sheet order-head">
        <h2 className="order-title">{task.prompt}</h2>
        <div className="order-meta">
          <StatusPill status={task.status} />
          {task.branch && <code title="Branch">{task.branch}</code>}
          {task.prUrl && (
            <a href={task.prUrl} target="_blank" rel="noreferrer">
              Open pull request
            </a>
          )}
          <span>Started {timeAgo(task.createdAt)}</span>
          {totalTokens > 0 && (
            <span title={`${usage.inputTokens.toLocaleString()} input tokens (${usage.cacheReadTokens.toLocaleString()} from cache), ${usage.outputTokens.toLocaleString()} output tokens`}>
              {usd(usage.costUsd)} for {tokens(totalTokens)} tokens
            </span>
          )}
          <span className="spacer" />
          {CANCELLABLE.has(task.status) && (
            <button type="button" className="button-danger button-small" onClick={onCancel} disabled={cancel.busy}>
              Cancel task
            </button>
          )}
        </div>
        {task.kind === "code" && <StationRail task={task} events={events} />}
      </header>

      {task.error && task.status !== "needs_human" && <p className="notice notice-danger">{task.error}</p>}
      {cancel.error && <p className="notice notice-danger">{cancel.error}</p>}
      {stopped && (task.goalId ? <p className="muted">This task is part of a goal: continue it from the goal above.</p> : <ContinueTask task={task} />)}
      {pending.map((approval) => (
        <ApprovalCard key={approval.id} approval={approval} />
      ))}

      <RunLog events={events} runs={runs} root={root} active={ACTIVE.has(task.status)} />
    </article>
  );
}

function ContinueTask({ task }: { task: Task }) {
  const [note, setNote] = useState("");
  const act = useAction();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await act.run(() => api.continueTask(task.id, note.trim()))) setNote("");
  };

  return (
    <form className="sheet form continue-task" onSubmit={submit}>
      <label className="field field-wide">
        {task.status === "needs_human" ? "Tell the team how to finish this task" : "Continue this stopped task"}
        <span className="field-hint">
          The work so far stays, and the Coder picks up from there. For example: "Keep the prices in a JSON file and show totals with two decimals".
        </span>
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={4000} />
      </label>
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={act.busy}>
          {act.busy ? "Continuing…" : "Continue the task"}
        </button>
        {act.error && <span className="error-text">{act.error}</span>}
      </div>
    </form>
  );
}
