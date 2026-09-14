import { useEffect, useState } from "react";
import { api, type DeployStatus, type Project } from "../api.ts";
import { timeAgo } from "../format.ts";
import { useAction, useData, useLive } from "../hooks.ts";

const MULTI_LINE = new Set(["SSH_PRIVATE_KEY", "SSH_KNOWN_HOSTS"]);
const FINISHED = new Set(["done", "rejected", "needs_human", "failed", "cancelled"]);
const SECRET_NAME = /^(?!GITHUB_)[A-Z_][A-Z0-9_]{0,99}$/;

function runTone(run: DeployStatus["runs"][number]): [label: string, tone: string] {
  if (run.status !== "completed") return [run.status === "queued" || run.status === "waiting" ? "Waiting" : "Running", "status-working"];
  if (run.conclusion === "success") return ["Deployed", "status-done"];
  if (run.conclusion === "skipped") return ["Skipped", ""];
  if (run.conclusion === "cancelled") return ["Cancelled", ""];
  return ["Failed", "status-failed"];
}

/** GitHub Actions deploy for one project: the secrets the workflow needs, the workflow itself, and its latest runs. */
export function DeployPanel({ project }: { project: Project }) {
  const taskVersion = useLive((c) => c.kind === "task" || c.kind === "approval");
  const status = useData(() => api.deploy(project.id), [project.id, project.githubRepo, taskVersion]);
  const [editing, setEditing] = useState<string | null>(null);
  const setup = useAction();
  const remove = useAction();
  const s = status.data;
  const running = s?.runs.some((r) => r.status !== "completed") ?? false;

  // A deploy that is still running changes on GitHub, not in the brain, so poll until it finishes.
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(status.reload, 15_000);
    return () => window.clearInterval(timer);
  }, [running, status.reload]);

  const onSetup = async () => {
    let task: { id: string; sessionId: string } | undefined;
    if (await setup.run(async () => (task = await api.setupDeploy(project.id)))) window.location.hash = `#/session/${task!.sessionId}/${task!.id}`;
  };

  const onDelete = async (name: string) => {
    if (!window.confirm(`Delete ${name} from GitHub? A deploy that needs it fails until you set it again.`)) return;
    if (await remove.run(() => api.deleteSecret(project.id, name))) status.reload();
  };

  const missing = s?.secrets.filter((x) => x.required && !x.set) ?? [];
  const setupTask = s?.setupTask;
  const setupRunning = setupTask && !FINISHED.has(setupTask.status);
  // A finished task's pull request still has to be merged before the workflow is on the base branch.
  const waitingPr = setupTask?.prUrl && setupTask.prState === "OPEN" && !s?.workflow.found ? setupTask.prUrl : null;

  return (
    <section className="section deploy" aria-label="Deploy">
      <div className="section-head">
        <h2>Deploy</h2>
        <button type="button" className="button-quiet button-small" onClick={status.reload}>
          Refresh
        </button>
      </div>
      <p className="muted">
        When a pull request is merged into <code>{project.defaultBranch}</code>, GitHub builds and tests the project on each version in the matrix, then
        copies it to your server over SSH. Secret values go straight to GitHub; AI Employee does not keep them and cannot show them again.
      </p>

      {!s && !status.error && <p className="muted">Reading GitHub Actions…</p>}
      {(status.error || s?.error) && <p className="notice notice-danger">{status.error ?? s?.error}</p>}

      {s?.repo && !s.error && (
        <>
          <div className="deploy-workflow">
            {s.workflow.found ? (
              <p className="notice notice-ok">
                The workflow{" "}
                <a href={s.workflow.url ?? undefined} target="_blank" rel="noreferrer">
                  <code>{s.workflow.file}</code>
                </a>{" "}
                is on GitHub.
                {missing.length > 0 && ` It cannot deploy until you set ${missing.map((m) => m.name).join(", ")}.`}
              </p>
            ) : (
              <p className="notice notice-needs">
                <code>{s.workflow.file}</code> is not on <code>{project.defaultBranch}</code> yet. The team can write it: you approve the pull request, then
                merge it.
              </p>
            )}
            {setupRunning ? (
              <a className="button-quiet button-small" href={`#/session/${setupTask.sessionId}/${setupTask.id}`}>
                Open the workflow task ({setupTask.status.replace("_", " ")})
              </a>
            ) : waitingPr ? (
              <a className="button-primary" href={waitingPr} target="_blank" rel="noreferrer">
                Review and merge the workflow pull request
              </a>
            ) : (
              <button type="button" className={s.workflow.found ? "button-quiet button-small" : "button-primary"} onClick={() => void onSetup()} disabled={setup.busy}>
                {s.workflow.found ? "Ask the team to update the workflow" : "Set up the deploy workflow"}
              </button>
            )}
            {setup.error && <p className="error-text">{setup.error}</p>}
          </div>

          <h3>Secrets</h3>
          <ul className="rows">
            {s.secrets.map((secret) => (
              <li key={secret.name} className="row deploy-secret">
                <div className="row-main">
                  <span className="row-title mono">
                    {secret.name}
                    {!secret.required && !secret.hint && <span className="muted"> (your own)</span>}
                    {!secret.required && secret.hint && <span className="muted"> (optional)</span>}
                  </span>
                  {secret.hint && <span className="row-sub">{secret.hint}</span>}
                  {editing === secret.name && (
                    <SecretForm
                      project={project}
                      name={secret.name}
                      onDone={(saved) => {
                        setEditing(null);
                        if (saved) status.reload();
                      }}
                    />
                  )}
                </div>
                <span className="row-side deploy-secret-side">
                  {secret.set ? (
                    <span>Set {secret.updatedAt ? timeAgo(secret.updatedAt) : ""}</span>
                  ) : (
                    <span className={`tag status ${secret.required ? "status-needs" : ""}`}>Not set</span>
                  )}
                  {editing !== secret.name && (
                    <button type="button" className="button-quiet button-small" onClick={() => setEditing(secret.name)}>
                      {secret.set ? "Replace" : "Set"}
                    </button>
                  )}
                  {secret.set && (
                    <button type="button" className="button-quiet button-small" onClick={() => void onDelete(secret.name)} disabled={remove.busy}>
                      Delete
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {remove.error && <p className="error-text">{remove.error}</p>}
          {editing === "" ? (
            <SecretForm
              project={project}
              name=""
              onDone={(saved) => {
                setEditing(null);
                if (saved) status.reload();
              }}
            />
          ) : (
            <div>
              <button type="button" className="button-quiet button-small" onClick={() => setEditing("")}>
                Add another secret
              </button>
            </div>
          )}

          {s.workflow.found && (
            <>
              <h3>Latest runs</h3>
              {s.runs.length === 0 ? (
                <p className="empty">No runs yet. Merge a pull request into {project.defaultBranch} to start the first deploy.</p>
              ) : (
                <ul className="rows">
                  {s.runs.map((run) => {
                    const [label, tone] = runTone(run);
                    return (
                      <li key={run.id} className="row">
                        <span className={`tag status ${tone}`}>{label}</span>
                        <div className="row-main">
                          <a className="row-title" href={run.url} target="_blank" rel="noreferrer">
                            {run.title}
                          </a>
                          <span className="row-sub">
                            {run.event === "push" ? "Merged into" : run.event === "pull_request" ? "Checks for a pull request on" : run.event} <code>{run.branch}</code>,{" "}
                            <code>{run.sha.slice(0, 7)}</code>
                          </span>
                        </div>
                        <span className="row-side">{timeAgo(run.createdAt)}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function SecretForm({ project, name: fixedName, onDone }: { project: Project; name: string; onDone: (saved: boolean) => void }) {
  const [name, setName] = useState(fixedName);
  const [value, setValue] = useState("");
  const save = useAction();
  const multiLine = !fixedName || MULTI_LINE.has(fixedName);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const upper = name.trim().toUpperCase();
    if (!SECRET_NAME.test(upper)) {
      save.setError("Use letters, digits and underscores for the name, not starting with a digit or GITHUB_");
      return;
    }
    if (!value) {
      save.setError("Paste the value first");
      return;
    }
    if (await save.run(() => api.setSecret(project.id, upper, value))) {
      setValue("");
      onDone(true);
    }
  };

  return (
    <form className="form deploy-secret-form" onSubmit={submit}>
      {!fixedName && (
        <label className="field">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="API_TOKEN" autoComplete="off" spellCheck={false} />
        </label>
      )}
      <label className="field field-wide">
        {fixedName ? `New value for ${fixedName}` : "Value"}
        {multiLine ? (
          <textarea rows={fixedName ? 4 : 2} value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" spellCheck={false} className="mono" />
        ) : (
          <input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" spellCheck={false} />
        )}
      </label>
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={save.busy}>
          {save.busy ? "Saving to GitHub…" : "Save to GitHub"}
        </button>
        <button type="button" className="button-quiet" onClick={() => onDone(false)} disabled={save.busy}>
          Cancel
        </button>
        {save.error && <span className="error-text">{save.error}</span>}
      </div>
    </form>
  );
}
