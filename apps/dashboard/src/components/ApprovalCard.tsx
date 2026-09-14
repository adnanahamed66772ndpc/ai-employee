import { api, type Approval } from "../api.ts";
import { useAction } from "../hooks.ts";
import { Markdown } from "./Markdown.tsx";

interface Payload {
  branch?: string;
  base?: string;
  stat?: string;
  repo?: string | null;
  prTitle?: string;
  prBody?: string;
  reviewSummary?: string;
  role?: string;
  toolCall?: unknown;
  summary?: string;
  epics?: { title: string; description?: string }[];
  commits?: string[];
  tasks?: string[];
}

export function ApprovalCard({ approval, showTaskLink = false }: { approval: Approval; showTaskLink?: boolean }) {
  const action = useAction();
  const p = approval.payload as Payload;
  const { kind } = approval;
  const pushes = kind === "push_and_pr" || kind === "epic_push";
  const decide = (decision: "approved" | "rejected") => void action.run(() => api.decide(approval.id, decision));
  const changes = p.stat?.trim().split("\n").at(-1);

  const heading =
    kind === "push_and_pr"
      ? "Push this branch and open a pull request?"
      : kind === "plan"
        ? "Approve the project plan?"
        : kind === "epic_push"
          ? `${approval.summary}. Push it and open a pull request?`
          : approval.summary;

  return (
    <section className="call" aria-label="Waiting for your decision">
      <div className="call-head">
        <span className="tag status status-needs">Your call</span>
        <h3>{heading}</h3>
      </div>

      {kind === "plan" && (
        <>
          {p.summary && <Markdown text={p.summary} />}
          <ol className="steps">
            {(p.epics ?? []).map((epic, i) => (
              <li key={i}>
                <strong>{epic.title}</strong>
                {epic.description && <span className="muted"> {epic.description}</span>}
              </li>
            ))}
          </ol>
          <p className="muted small">Each epic is split into small tasks when its turn comes. You approve every epic again before it is pushed.</p>
        </>
      )}

      {pushes && (
        <>
          <dl className="facts">
            <dt>Branch</dt>
            <dd>
              <code>{p.branch}</code> into <code>{p.base}</code>
            </dd>
            <dt>Repository</dt>
            <dd>{p.repo ?? <span className="error-text">No GitHub repository is set. Add one in project settings before approving.</span>}</dd>
            {changes && (
              <>
                <dt>Changes</dt>
                <dd>{changes}</dd>
              </>
            )}
            {p.tasks && p.tasks.length > 0 && (
              <>
                <dt>Tasks</dt>
                <dd>{p.tasks.length === 1 ? p.tasks[0] : `${p.tasks.length} tasks: ${p.tasks.join("; ")}`}</dd>
              </>
            )}
            {p.reviewSummary && (
              <>
                <dt>Review</dt>
                <dd>{p.reviewSummary}</dd>
              </>
            )}
          </dl>
          {p.commits && p.commits.length > 0 && (
            <details>
              <summary>{p.commits.length === 1 ? "1 commit" : `${p.commits.length} commits`}</summary>
              <ul className="plain-list mono">
                {p.commits.map((commit) => (
                  <li key={commit}>{commit}</li>
                ))}
              </ul>
            </details>
          )}
          {p.prTitle && (
            <details>
              <summary>Pull request text</summary>
              <div className="pr-sheet">
                <p className="pr-title">{p.prTitle}</p>
                {p.prBody && <Markdown text={p.prBody} />}
              </div>
            </details>
          )}
        </>
      )}

      {kind === "permission" && (
        <details open>
          <summary>Requested tool call from the {p.role}</summary>
          <pre className="pre">{JSON.stringify(p.toolCall, null, 2)}</pre>
        </details>
      )}

      <div className="call-actions">
        <button type="button" className="button-primary" disabled={action.busy || (pushes && !p.repo)} onClick={() => decide("approved")}>
          {kind === "plan" ? "Approve plan" : pushes ? "Push and open pull request" : "Allow once"}
        </button>
        <button type="button" disabled={action.busy} onClick={() => decide("rejected")}>
          {kind === "plan" ? "Reject plan" : pushes ? "Keep it local" : "Deny"}
        </button>
        {showTaskLink && approval.taskId && <TaskLink taskId={approval.taskId} />}
        {action.error && <span className="error-text">{action.error}</span>}
      </div>
    </section>
  );
}

function TaskLink({ taskId }: { taskId: string }) {
  const open = async () => {
    const detail = await api.task(taskId);
    window.location.hash = `#/session/${detail.task.sessionId}/${taskId}`;
  };
  return (
    <button type="button" className="button-quiet" onClick={() => void open()}>
      Open the task
    </button>
  );
}
