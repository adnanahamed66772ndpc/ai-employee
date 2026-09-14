import { useEffect, useState } from "react";
import { api, type CriticKind, type Project } from "../api.ts";
import { DeployPanel } from "../components/DeployPanel.tsx";
import { MemoryPanel } from "../components/MemoryPanel.tsx";
import { timeAgo, tokens, usd } from "../format.ts";
import { useAction, useData, useLive } from "../hooks.ts";

const CRITICS: { kind: CriticKind; name: string; job: string }[] = [
  { kind: "ui", name: "UI critic", job: "Loading and error states, phone layouts, labels and focus, reuse of existing components" },
  { kind: "security", name: "Security critic", job: "Login checks on endpoints, secrets in code, unsafe use of user input, leaked data" },
];

export function ProjectPage({ projectId }: { projectId: string }) {
  const projectVersion = useLive((c) => c.kind === "project" && c.id === projectId);
  const sessionVersion = useLive((c) => c.kind === "session" && c.projectId === projectId);
  const project = useData(async () => (await api.projects()).find((p) => p.id === projectId) ?? null, [projectVersion]);
  const sessions = useData(() => api.sessions(projectId), [sessionVersion]);
  const [title, setTitle] = useState("");
  const create = useAction();

  if (project.data === null) return <div className="page empty">This project no longer exists.</div>;
  if (!project.data) return <div className="page empty">{project.error ?? "Loading…"}</div>;
  const p = project.data;
  const checks = [p.testCmd, p.lintCmd].filter((c): c is string => Boolean(c));
  const activeCritics = CRITICS.filter((c) => !p.disabledCritics.includes(c.kind));

  const startSession = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      create.setError("Name the session first");
      return;
    }
    let id: string | undefined;
    if (await create.run(async () => (id = (await api.createSession(projectId, title.trim())).id))) window.location.hash = `#/session/${id}`;
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1>{p.name}</h1>
        <dl className="facts facts-inline">
          <div>
            <dt>Folder</dt>
            <dd className="mono">{p.localPath}</dd>
          </div>
          <div>
            <dt>GitHub</dt>
            <dd>
              {p.githubRepo ? (
                <a href={`https://github.com/${p.githubRepo}`} target="_blank" rel="noreferrer">
                  {p.githubRepo}
                </a>
              ) : (
                "Not connected"
              )}
            </dd>
          </div>
          <div>
            <dt>Base branch</dt>
            <dd>
              <code>{p.defaultBranch}</code>
            </dd>
          </div>
          <div>
            <dt>Setup</dt>
            <dd>{p.setupCmd ? <code>{p.setupCmd}</code> : "None"}</dd>
          </div>
          <div>
            <dt>Checks</dt>
            <dd>{checks.length ? checks.map((c) => <code key={c}>{c}</code>) : "None set"}</dd>
          </div>
          <div>
            <dt>App check</dt>
            <dd>{p.startCmd ? <code>{p.startCmd}</code> : "From package.json"}</dd>
          </div>
          <div>
            <dt>Critics</dt>
            <dd>{activeCritics.length ? activeCritics.map((c) => c.name).join(", ") : "Off"}</dd>
          </div>
          <div>
            <dt>Budget per task</dt>
            <dd>{p.taskBudgetUsd ? usd(p.taskBudgetUsd) : "No limit"}</dd>
          </div>
        </dl>
      </header>

      <section className="section">
        <h2>Sessions</h2>
        <form className="inline-form" onSubmit={startSession}>
          <input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              create.setError(null);
            }}
            placeholder="Name a session, for example Checkout page"
            aria-label="Session name"
          />
          <button type="submit" className="button-primary" disabled={create.busy}>
            Start session
          </button>
        </form>
        {create.error && <p className="error-text">{create.error}</p>}
        {sessions.data?.length === 0 ? (
          <p className="empty">Start a session to group related tasks.</p>
        ) : (
          <ul className="rows">
            {sessions.data?.map((s) => (
              <li key={s.id} className="row">
                <div className="row-main">
                  <a className="row-title" href={`#/session/${s.id}`}>
                    {s.title}
                  </a>
                </div>
                <span className="row-side">Started {timeAgo(s.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <CriticsPanel project={p} />

      <DeployPanel project={p} />

      <MemoryPanel scope="project" projectId={projectId} title="Project memory" description="Facts about this repository that every agent reads before it works." />

      <details className="sheet settings">
        <summary>
          <h2 style={{ display: "inline" }}>Project settings</h2>
        </summary>
        <ProjectSettings project={p} />
      </details>
    </div>
  );
}

function CriticsPanel({ project }: { project: Project }) {
  const version = useLive((c) => c.kind === "event" || c.kind === "run");
  const stats = useData(() => api.criticStats(project.id), [project.id, version]);
  const byKind = new Map((stats.data ?? []).map((s) => [s.critic, s]));

  return (
    <section className="section">
      <h2>Critics</h2>
      <p className="muted">
        They check a change right before it is committed, and only when it touches UI or security-sensitive files. A problem goes back to the Coder
        for up to two fix rounds; after that, nothing is committed and the task waits for you.
      </p>
      <ul className="rows">
        {CRITICS.map((critic) => {
          const s = byKind.get(critic.kind);
          const off = project.disabledCritics.includes(critic.kind);
          return (
            <li key={critic.kind} className="row role-critic">
              <div className="row-main">
                <span className="row-title">
                  {critic.name}
                  {off && <span className="muted"> (off)</span>}
                </span>
                <span className="row-sub">{critic.job}</span>
              </div>
              <span className="row-side">
                {s && s.checks > 0
                  ? `${s.checks} ${s.checks === 1 ? "check" : "checks"}, ${s.findings} found, ${s.fixed} fixed, ${usd(s.costUsd)} for ${tokens(s.tokens)} tokens`
                  : "Has not checked a change yet"}
              </span>
            </li>
          );
        })}
      </ul>
      {stats.error && <p className="error-text">{stats.error}</p>}
    </section>
  );
}

interface SettingsForm {
  name: string;
  defaultBranch: string;
  githubRepo: string;
  setupCmd: string;
  testCmd: string;
  lintCmd: string;
  budget: string;
  startCmd: string;
  appUrl: string;
  disabledCritics: CriticKind[];
}

const toForm = (project: Project): SettingsForm => ({
  name: project.name,
  defaultBranch: project.defaultBranch,
  githubRepo: project.githubRepo ?? "",
  setupCmd: project.setupCmd ?? "",
  testCmd: project.testCmd ?? "",
  lintCmd: project.lintCmd ?? "",
  budget: project.taskBudgetUsd ? String(project.taskBudgetUsd) : "",
  startCmd: project.startCmd ?? "",
  appUrl: project.appUrl ?? "",
  disabledCritics: project.disabledCritics,
});

function ProjectSettings({ project }: { project: Project }) {
  const [form, setForm] = useState(() => toForm(project));
  const save = useAction();
  const remove = useAction();
  const [saved, setSaved] = useState(false);
  useEffect(() => setForm(toForm(project)), [project]);
  const set = (key: Exclude<keyof SettingsForm, "disabledCritics">) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm({ ...form, [key]: e.target.value });
    setSaved(false);
  };
  const toggleCritic = (kind: CriticKind, on: boolean) => {
    setForm({ ...form, disabledCritics: on ? form.disabledCritics.filter((k) => k !== kind) : [...form.disabledCritics, kind] });
    setSaved(false);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.defaultBranch.trim()) {
      save.setError("Name and base branch are required");
      return;
    }
    const budget = form.budget.trim() ? Number(form.budget) : null;
    if (budget !== null && !(budget > 0)) {
      save.setError("Budget must be a number of dollars above 0, or empty for no limit");
      return;
    }
    const ok = await save.run(() =>
      api.updateProject(project.id, {
        name: form.name.trim(),
        githubRepo: form.githubRepo.trim() || null,
        defaultBranch: form.defaultBranch.trim(),
        setupCmd: form.setupCmd,
        testCmd: form.testCmd,
        lintCmd: form.lintCmd,
        taskBudgetUsd: budget,
        startCmd: form.startCmd,
        appUrl: form.appUrl.trim(),
        disabledCritics: form.disabledCritics,
      }),
    );
    setSaved(ok);
  };

  const onRemove = async () => {
    if (!window.confirm(`Remove "${project.name}"? Its sessions, tasks and project memory are deleted from the brain. The folder on the server stays.`)) return;
    if (await remove.run(() => api.deleteProject(project.id))) window.location.hash = "#/";
  };

  return (
    <form className="form" onSubmit={submit}>
      <label className="field">
        Name
        <input value={form.name} onChange={set("name")} />
      </label>
      <label className="field">
        Base branch
        <span className="field-hint">Agents branch from here and open pull requests into it</span>
        <input value={form.defaultBranch} onChange={set("defaultBranch")} />
      </label>
      <label className="field field-wide">
        GitHub repository
        <span className="field-hint">owner/name. Needed to push and open pull requests.</span>
        <input value={form.githubRepo} onChange={set("githubRepo")} placeholder="owner/repository" />
      </label>
      <label className="field field-wide">
        Setup command
        <span className="field-hint">Runs in each task's fresh copy of the repository before coding starts, for example to install dependencies</span>
        <input value={form.setupCmd} onChange={set("setupCmd")} placeholder="npm ci" />
      </label>
      <label className="field">
        Test command
        <input value={form.testCmd} onChange={set("testCmd")} placeholder="npm test" />
      </label>
      <label className="field">
        Lint command
        <input value={form.lintCmd} onChange={set("lintCmd")} placeholder="npm run lint" />
      </label>
      <label className="field field-wide">
        Start command for the app check
        <span className="field-hint">
          Starts the app in a task&apos;s copy when UI files change, so its screens can be checked. Use {"{port}"} for the port. Empty: taken from the
          package.json dev or start script.
        </span>
        <input value={form.startCmd} onChange={set("startCmd")} placeholder="npm run dev -- --host 127.0.0.1 --port {port}" />
      </label>
      <label className="field field-wide">
        App address
        <span className="field-hint">Where the started app answers. Local addresses only.</span>
        <input value={form.appUrl} onChange={set("appUrl")} placeholder="http://127.0.0.1:{port}/" />
      </label>
      <label className="field">
        Budget per task (US dollars)
        <span className="field-hint">A task stops once its model calls cost this much. Leave empty for no limit.</span>
        <input value={form.budget} onChange={set("budget")} inputMode="decimal" placeholder="0.50" />
      </label>
      <fieldset className="choices field-wide">
        <legend>Critics before each commit</legend>
        {CRITICS.map((critic) => (
          <label key={critic.kind} className="choice">
            <input type="checkbox" checked={!form.disabledCritics.includes(critic.kind)} onChange={(e) => toggleCritic(critic.kind, e.target.checked)} />
            <span>
              <strong>{critic.name}</strong>
              <span className="field-hint">{critic.job}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={save.busy}>
          {saved ? "Saved" : "Save settings"}
        </button>
        <span className="spacer" />
        <button type="button" className="button-danger" onClick={() => void onRemove()} disabled={remove.busy}>
          Remove project
        </button>
        {(save.error || remove.error) && <span className="error-text">{save.error ?? remove.error}</span>}
      </div>
    </form>
  );
}
