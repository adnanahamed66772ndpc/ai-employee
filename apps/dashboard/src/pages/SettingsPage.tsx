import { useEffect, useState } from "react";
import { api, type RoleSetting } from "../api.ts";
import { timeAgo, usd } from "../format.ts";
import { useAction, useData, useLive } from "../hooks.ts";

const ROLE_INFO: Record<RoleSetting["role"], { name: string; glyph: string; job: string }> = {
  planner: { name: "Planner", glyph: "P", job: "Reads the code and writes the plan" },
  coder: { name: "Coder", glyph: "C", job: "Makes the change and runs tests" },
  reviewer: { name: "Reviewer", glyph: "R", job: "Checks logic and backend: requirements, crashes, frontend and backend agreement, tests" },
  critic: { name: "Critics", glyph: "K", job: "UI and security critics check the change right before it is committed" },
  git: { name: "Git agent", glyph: "G", job: "Writes commit messages and pull request text" },
  memory: { name: "Memory writer", glyph: "M", job: "Decides what the team remembers" },
};
const ORDER: RoleSetting["role"][] = ["planner", "coder", "reviewer", "critic", "git", "memory"];

export function SettingsPage() {
  const version = useLive((c) => c.kind === "settings");
  const roles = useData(() => api.roles(), [version]);
  const models = useData(() => api.models(), []);
  const sorted = [...(roles.data ?? [])].sort((a, b) => ORDER.indexOf(a.role) - ORDER.indexOf(b.role));

  return (
    <div className="page">
      <header className="page-head">
        <h1>Models</h1>
        <p className="lede">Choose the model each agent uses through CheaperInference. Changes apply to the next task.</p>
      </header>

      <p className="notice">
        <span>
          A model must also be listed for DeepSeek Harness on the server: <code>npm run setup:dsh -- --models=deepseek-v4-flash,another-model --force</code>
        </span>
        {models.data?.error && <span className="error-text">{models.data.error}</span>}
      </p>

      <datalist id="models">
        {models.data?.models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>

      <div className="roles">
        {sorted.map((setting) => (
          <RoleRow key={setting.role} setting={setting} />
        ))}
      </div>

      <SpendingSection />

      <Notifications />

      <Housekeeping />
    </div>
  );
}

function SpendingSection() {
  const version = useLive((c) => c.kind === "settings" || c.kind === "run");
  const data = useData(() => api.spending(), [version]);
  const [budget, setBudget] = useState("");
  const [model, setModel] = useState("");
  const [vision, setVision] = useState("");
  const [saved, setSaved] = useState(false);
  const save = useAction();
  const d = data.data;
  // Fill the form from the saved values only when those change, not on every cost update.
  useEffect(() => {
    if (!d) return;
    setBudget(d.dailyBudgetUsd === null ? "" : String(d.dailyBudgetUsd));
    setModel(d.escalationModel ?? "");
    setVision(d.visionModel ?? "");
  }, [d?.dailyBudgetUsd, d?.escalationModel, d?.visionModel]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amount = budget.trim() ? Number(budget) : null;
    if (amount !== null && !(amount > 0)) {
      save.setError("The daily budget must be a number of dollars above 0, or empty for no limit");
      return;
    }
    setSaved(await save.run(() => api.setSpending({ dailyBudgetUsd: amount, escalationModel: model.trim() || null, visionModel: vision.trim() || null })));
  };

  return (
    <section className="section">
      <h2>Spending</h2>
      <form className="sheet form" onSubmit={submit}>
        <p className="field-wide">
          {d
            ? `All projects spent ${usd(d.spentTodayUsd)} today${d.dailyBudgetUsd ? ` of the ${usd(d.dailyBudgetUsd)} daily budget` : ""}. The count starts over at midnight.`
            : (data.error ?? "Loading…")}
        </p>
        <label className="field">
          Daily budget for all projects (US dollars)
          <span className="field-hint">When it is reached, running tasks stop and new ones wait until midnight. Empty for no limit.</span>
          <input
            value={budget}
            onChange={(e) => {
              setBudget(e.target.value);
              setSaved(false);
            }}
            inputMode="decimal"
            placeholder="2.00"
          />
        </label>
        <label className="field">
          Stronger model for a second try
          <span className="field-hint">When the Coder's rounds do not get a change accepted, it tries once more with this model. Empty turns it off.</span>
          <input
            list="models"
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              setSaved(false);
            }}
            placeholder="deepseek-v4-pro"
          />
        </label>
        <label className="field">
          Model that looks at app screenshots
          <span className="field-hint">When UI files change, the running app is captured on a phone and a desktop and this model judges it. It must understand images. Empty skips it; the free page checks still run.</span>
          <input
            list="models"
            value={vision}
            onChange={(e) => {
              setVision(e.target.value);
              setSaved(false);
            }}
            placeholder="glm-5.3-flash"
          />
        </label>
        <div className="form-actions">
          <button type="submit" className="button-primary" disabled={save.busy}>
            {saved ? "Saved" : "Save spending"}
          </button>
          {save.error && <span className="error-text">{save.error}</span>}
        </div>
      </form>
    </section>
  );
}

const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

function Housekeeping() {
  const status = useData(() => api.maintenance(), []);
  const backup = useAction();
  const cleanup = useAction();
  const [message, setMessage] = useState<string | null>(null);
  const s = status.data;
  const latest = s?.backups[0];

  const onBackup = async () => {
    setMessage(null);
    let result: { name: string } | undefined;
    if (await backup.run(async () => (result = await api.backupNow()))) {
      setMessage(`Saved ${result!.name}`);
      status.reload();
    }
  };

  const onCleanup = async () => {
    setMessage(null);
    let result: { removed: number } | undefined;
    if (await cleanup.run(async () => (result = await api.cleanupNow()))) {
      setMessage(result!.removed ? `Removed ${result!.removed} old work folder${result!.removed === 1 ? "" : "s"}` : "No work folder was old enough to remove");
      status.reload();
    }
  };

  return (
    <section className="section">
      <h2>Backups and cleanup</h2>
      <div className="sheet notify">
        <p>
          Every night at 03:00 the server copies the brain (projects, tasks and memory) and keeps the newest {s?.keep ?? 7} copies
          {s && (
            <>
              {" "}
              in <code>{s.backupDir}</code>
            </>
          )}
          . Work folders of failed or cancelled tasks are removed after 3 days, and those of tasks that need your help after 14 days. Their branches
          stay.
        </p>
        {status.error && <p className="error-text">{status.error}</p>}
        {s && (
          <dl className="facts">
            <dt>Next backup</dt>
            <dd>{s.nextBackupAt ? new Date(s.nextBackupAt).toLocaleString() : "Not scheduled"}</dd>
            <dt>Latest backup</dt>
            <dd>{latest ? `${latest.name}, ${size(latest.bytes)}, ${timeAgo(latest.createdAt)}` : "None yet"}</dd>
            <dt>Last cleanup</dt>
            <dd>{s.lastCleanup ? `${timeAgo(s.lastCleanup.at)}, removed ${s.lastCleanup.removed}` : "Not run yet"}</dd>
          </dl>
        )}
        <div className="form-actions">
          <button type="button" disabled={backup.busy} onClick={() => void onBackup()}>
            {backup.busy ? "Backing up…" : "Back up now"}
          </button>
          <button type="button" className="button-quiet" disabled={cleanup.busy} onClick={() => void onCleanup()}>
            {cleanup.busy ? "Cleaning up…" : "Clean up old work folders now"}
          </button>
          {message && <span className="muted">{message}</span>}
          {(backup.error || cleanup.error) && <span className="error-text">{backup.error ?? cleanup.error}</span>}
        </div>
      </div>
    </section>
  );
}

function Notifications() {
  const status = useData(() => api.notifications(), []);
  const test = useAction();
  const [sent, setSent] = useState(false);
  const configured = status.data?.telegram;

  return (
    <section className="section">
      <h2>Notifications</h2>
      <div className="sheet notify">
        <p>
          {configured === undefined
            ? "Checking…"
            : configured
              ? "Telegram is on. You get a message when a task needs your approval or your help, fails, or opens a pull request."
              : "Telegram is off."}
        </p>
        {configured === false && (
          <ol className="steps">
            <li>
              Create a bot with <strong>@BotFather</strong> in Telegram and copy its token.
            </li>
            <li>
              Add <code>AI_EMPLOYEE_TELEGRAM_BOT_TOKEN=…</code> to <code>.env.local</code> on the server. Keep the token out of chats and commits.
            </li>
            <li>
              Send any message to your bot, then run <code>npm run telegram:chat-id</code> on the server and add the <code>AI_EMPLOYEE_TELEGRAM_CHAT_ID</code> line it prints.
            </li>
            <li>Restart the server.</li>
          </ol>
        )}
        {configured && (
          <div className="form-actions">
            <button
              type="button"
              disabled={test.busy}
              onClick={async () => {
                setSent(false);
                setSent(await test.run(() => api.testNotification()));
              }}
            >
              {test.busy ? "Sending…" : sent ? "Test message sent" : "Send a test message"}
            </button>
            {test.error && <span className="error-text">{test.error}</span>}
          </div>
        )}
      </div>
    </section>
  );
}

function RoleRow({ setting }: { setting: RoleSetting }) {
  const [form, setForm] = useState(setting);
  const [saved, setSaved] = useState(false);
  const save = useAction();
  const info = ROLE_INFO[setting.role];
  useEffect(() => setForm(setting), [setting]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.provider.trim() || !form.model.trim()) {
      save.setError("Provider and model are both required");
      return;
    }
    setSaved(await save.run(() => api.setRole(setting.role, { provider: form.provider.trim(), model: form.model.trim(), reasoningEffort: form.reasoningEffort })));
  };
  const change = (patch: Partial<RoleSetting>) => {
    setForm({ ...form, ...patch });
    setSaved(false);
  };

  return (
    <form className={`role-row role-${setting.role}`} onSubmit={submit}>
      <div className="role-id">
        <span className="glyph" aria-hidden="true">
          {info.glyph}
        </span>
        <div>
          <strong>{info.name}</strong>
          <div className="muted small">{info.job}</div>
        </div>
      </div>
      <input value={form.provider} onChange={(e) => change({ provider: e.target.value })} aria-label={`${info.name} provider`} />
      <input value={form.model} onChange={(e) => change({ model: e.target.value })} list="models" aria-label={`${info.name} model`} />
      <select value={form.reasoningEffort ?? ""} onChange={(e) => change({ reasoningEffort: e.target.value || null })} aria-label={`${info.name} reasoning effort`}>
        <option value="">Default effort</option>
        <option value="off">No reasoning</option>
        <option value="low">Low effort</option>
        <option value="high">High effort</option>
        <option value="max">Maximum effort</option>
      </select>
      <button type="submit" disabled={save.busy}>
        {saved ? "Saved" : "Save"}
      </button>
      {save.error && <span className="error-text">{save.error}</span>}
    </form>
  );
}
