import { Fragment, useMemo, useState } from "react";
import { api, type FolderEntry, type GithubRepo, type Visibility } from "../api.ts";
import { timeAgo } from "../format.ts";
import { useAction, useData } from "../hooks.ts";

type Mode = "folder" | "clone" | "create";

const MODES: { id: Mode; label: string }[] = [
  { id: "folder", label: "Choose a folder" },
  { id: "clone", label: "Clone from GitHub" },
  { id: "create", label: "New repository" },
];

const FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const FOLDER_RULE = "Use letters, numbers, dots, dashes or underscores, starting with a letter or number";

const openProject = (id: string) => {
  window.location.hash = `#/project/${id}`;
};

export function NewProjectPage() {
  const [mode, setMode] = useState<Mode>("folder");
  const root = useData(() => api.folders(), []);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Add a project</h1>
        <p className="lede">
          Projects live in {root.data ? <code>{root.data.root}</code> : "the projects folder"} on the server, and agents can only work inside it.
        </p>
      </header>

      <div className="segmented" role="tablist" aria-label="How to add the project">
        {MODES.map((m) => (
          <button key={m.id} type="button" role="tab" aria-selected={mode === m.id} onClick={() => setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>

      {mode === "folder" && <FolderPanel />}
      {mode === "clone" && <ClonePanel />}
      {mode === "create" && <CreatePanel />}
    </div>
  );
}

interface ChecksValue {
  setupCmd: string;
  testCmd: string;
  lintCmd: string;
}

function ChecksFields({ value, onChange }: { value: ChecksValue; onChange: (value: ChecksValue) => void }) {
  return (
    <>
      <label className="field field-wide">
        Setup command
        <span className="field-hint">Optional. Runs in each task's fresh copy of the repository first, for example to install dependencies</span>
        <input value={value.setupCmd} onChange={(e) => onChange({ ...value, setupCmd: e.target.value })} placeholder="npm ci" />
      </label>
      <label className="field">
        Test command
        <span className="field-hint">Runs after every change</span>
        <input value={value.testCmd} onChange={(e) => onChange({ ...value, testCmd: e.target.value })} placeholder="npm test" />
      </label>
      <label className="field">
        Lint command
        <span className="field-hint">Optional</span>
        <input value={value.lintCmd} onChange={(e) => onChange({ ...value, lintCmd: e.target.value })} placeholder="npm run lint" />
      </label>
    </>
  );
}

function breadcrumbs(root: string, path: string) {
  const separator = root.includes("\\") ? "\\" : "/";
  const crumbs = [{ name: root, path: root }];
  let current = root;
  for (const part of path.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = current.endsWith(separator) ? `${current}${part}` : `${current}${separator}${part}`;
    crumbs.push({ name: part, path: current });
  }
  return crumbs;
}

function FolderPanel() {
  const [path, setPath] = useState<string>();
  const [selected, setSelected] = useState<FolderEntry | null>(null);
  const [checks, setChecks] = useState<ChecksValue>({ setupCmd: "", testCmd: "", lintCmd: "" });
  const listing = useData(() => api.folders(path), [path]);
  const action = useAction();

  const open = (next: string) => {
    setPath(next);
    setSelected(null);
    action.setError(null);
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) {
      action.setError("Choose a git repository from the list first");
      return;
    }
    let id: string | undefined;
    if (await action.run(async () => (id = (await api.createProject({ localPath: selected.path, ...checks })).id))) openProject(id!);
  };

  return (
    <div className="section">
      <div className="sheet picker">
        {listing.data && (
          <div className="picker-bar" aria-label="Current folder">
            {breadcrumbs(listing.data.root, listing.data.path).map((crumb, i) => (
              <Fragment key={crumb.path}>
                {i > 0 && <span aria-hidden="true">/</span>}
                <button type="button" className="button-quiet button-small" onClick={() => open(crumb.path)}>
                  {crumb.name}
                </button>
              </Fragment>
            ))}
          </div>
        )}
        {listing.error && <p className="picker-msg error-text">{listing.error}</p>}
        <ul className="picker-list">
          {listing.data?.parent && (
            <li>
              <button type="button" className="picker-item" onClick={() => open(listing.data!.parent!)}>
                <span className="folder-mark" aria-hidden="true" />
                <span className="picker-name">Up one folder</span>
                <span />
              </button>
            </li>
          )}
          {listing.data?.entries.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                className="picker-item"
                aria-pressed={selected?.path === entry.path}
                disabled={Boolean(entry.projectId)}
                onClick={() => (entry.isGitRepo ? setSelected(entry) : open(entry.path))}
              >
                <span className={entry.isGitRepo ? "folder-mark is-repo" : "folder-mark"} aria-hidden="true" />
                <span className="picker-name">{entry.name}</span>
                <span className="picker-note">{entry.projectId ? "Already a project" : entry.isGitRepo ? "Git repository" : "Open"}</span>
              </button>
            </li>
          ))}
        </ul>
        {listing.data && listing.data.entries.length === 0 && (
          <p className="picker-msg muted">This folder has no subfolders. Clone a repository or create a new one instead.</p>
        )}
      </div>

      <form className="sheet form" onSubmit={add}>
        <p className="field-wide">
          {selected ? (
            <>
              Add <strong>{selected.name}</strong> as a project.
            </>
          ) : (
            "Choose a git repository in the list above."
          )}
        </p>
        <ChecksFields value={checks} onChange={setChecks} />
        <div className="form-actions">
          <button type="submit" className="button-primary" disabled={action.busy}>
            {action.busy ? "Adding…" : "Add project"}
          </button>
          {action.error && <span className="error-text">{action.error}</span>}
        </div>
      </form>
    </div>
  );
}

function ClonePanel() {
  const repos = useData(() => api.githubRepos(), []);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<GithubRepo | null>(null);
  const [folder, setFolder] = useState("");
  const [checks, setChecks] = useState<ChecksValue>({ setupCmd: "", testCmd: "", lintCmd: "" });
  const action = useAction();

  const visible = useMemo(
    () => (repos.data ?? []).filter((r) => `${r.nameWithOwner} ${r.description}`.toLowerCase().includes(filter.trim().toLowerCase())),
    [repos.data, filter],
  );

  const choose = (repo: GithubRepo) => {
    setSelected(repo);
    setFolder(repo.nameWithOwner.split("/")[1] ?? "");
    action.setError(null);
  };

  const clone = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) {
      action.setError("Choose a repository from the list first");
      return;
    }
    if (!FOLDER_NAME.test(folder)) {
      action.setError(FOLDER_RULE);
      return;
    }
    let id: string | undefined;
    if (await action.run(async () => (id = (await api.cloneProject({ repo: selected.nameWithOwner, folder, ...checks })).id))) openProject(id!);
  };

  return (
    <div className="section">
      <div className="sheet picker">
        <div className="picker-bar">
          <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter your GitHub repositories" aria-label="Filter repositories" />
        </div>
        {repos.error && <p className="picker-msg error-text">{repos.error}</p>}
        {!repos.data && !repos.error && <p className="picker-msg muted">Loading your repositories from GitHub…</p>}
        <ul className="picker-list">
          {visible.map((repo) => (
            <li key={repo.nameWithOwner}>
              <button type="button" className="picker-item" aria-pressed={selected?.nameWithOwner === repo.nameWithOwner} onClick={() => choose(repo)}>
                <span className="folder-mark is-repo" aria-hidden="true" />
                <span className="picker-name">
                  {repo.nameWithOwner}
                  <span className="picker-desc">{repo.description || `Updated ${timeAgo(repo.updatedAt)}`}</span>
                </span>
                <span className="picker-note">{repo.isPrivate ? "Private" : "Public"}</span>
              </button>
            </li>
          ))}
        </ul>
        {repos.data && visible.length === 0 && <p className="picker-msg muted">No repositories match that filter.</p>}
      </div>

      <form className="sheet form" onSubmit={clone}>
        <label className="field field-wide">
          Folder name
          <span className="field-hint">The repository is cloned into this folder inside the projects folder</span>
          <input
            value={folder}
            onChange={(e) => {
              setFolder(e.target.value);
              action.setError(null);
            }}
            placeholder="Choose a repository first"
            disabled={!selected}
          />
        </label>
        <ChecksFields value={checks} onChange={setChecks} />
        <div className="form-actions">
          <button type="submit" className="button-primary" disabled={action.busy}>
            {action.busy ? "Cloning…" : "Clone and add project"}
          </button>
          {action.error && <span className="error-text">{action.error}</span>}
        </div>
      </form>
    </div>
  );
}

const VISIBILITY: { id: Visibility; label: string; hint: string }[] = [
  { id: "private", label: "Private GitHub repository", hint: "Created on your GitHub account, visible only to you" },
  { id: "public", label: "Public GitHub repository", hint: "Anyone can see the code" },
  { id: "local", label: "Only on this server", hint: "Connect it to GitHub later in project settings" },
];

function CreatePanel() {
  const [folder, setFolder] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [checks, setChecks] = useState<ChecksValue>({ setupCmd: "", testCmd: "", lintCmd: "" });
  const action = useAction();

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!FOLDER_NAME.test(folder.trim())) {
      action.setError(`Repository name: ${FOLDER_RULE.toLowerCase()}`);
      return;
    }
    let id: string | undefined;
    const ok = await action.run(
      async () => (id = (await api.newProject({ folder: folder.trim(), visibility, description: description.trim() || undefined, ...checks })).id),
    );
    if (ok) openProject(id!);
  };

  return (
    <form className="sheet form" onSubmit={create}>
      <label className="field">
        Repository name
        <span className="field-hint">Also the folder name on the server</span>
        <input
          value={folder}
          onChange={(e) => {
            setFolder(e.target.value);
            action.setError(null);
          }}
          placeholder="my-app"
        />
      </label>
      <label className="field">
        Description
        <span className="field-hint">Optional, one sentence</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this project is for" />
      </label>
      <fieldset className="choices field-wide">
        <legend>Where the repository lives</legend>
        {VISIBILITY.map((option) => (
          <label key={option.id} className="choice">
            <input type="radio" name="visibility" checked={visibility === option.id} onChange={() => setVisibility(option.id)} />
            <span>
              <strong>{option.label}</strong>
              <span className="field-hint">{option.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <ChecksFields value={checks} onChange={setChecks} />
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={action.busy}>
          {action.busy ? "Creating…" : "Create repository"}
        </button>
        {action.error && <span className="error-text">{action.error}</span>}
      </div>
    </form>
  );
}
