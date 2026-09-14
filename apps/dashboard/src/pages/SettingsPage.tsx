import { useEffect, useState } from "react";
import { api, type CatalogModel, type ModelRef, type PriceRow, type Provider, type ProviderPreset, type ProviderType, type RoleSetting } from "../api.ts";
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

const TYPE_LABEL: Record<ProviderType, string> = { openai: "OpenAI-compatible", anthropic: "Anthropic Messages", gemini: "Google Gemini" };

type CatalogState = { models: CatalogModel[]; error?: string } | "loading";

/** Each provider's model list for the pickers, fetched once while the page is open. */
interface Catalogs {
  lists: Record<string, CatalogState>;
  load(providerId: string): void;
}

function useCatalogs(): Catalogs {
  const [lists, setLists] = useState<Record<string, CatalogState>>({});
  const load = (providerId: string) => {
    if (!providerId || lists[providerId]) return;
    setLists((current) => ({ ...current, [providerId]: "loading" }));
    api.providerModels(providerId).then(
      (result) => setLists((current) => ({ ...current, [providerId]: result })),
      (error: Error) => setLists((current) => ({ ...current, [providerId]: { models: [], error: error.message } })),
    );
  };
  return { lists, load };
}

export function SettingsPage() {
  const version = useLive((c) => c.kind === "settings");
  const roles = useData(() => api.roles(), [version]);
  const providers = useData(() => api.providers(), [version]);
  const catalogs = useCatalogs();
  const sorted = [...(roles.data ?? [])].sort((a, b) => ORDER.indexOf(a.role) - ORDER.indexOf(b.role));
  const list = providers.data?.providers ?? [];

  return (
    <div className="page">
      <header className="page-head">
        <h1>Models</h1>
        <p className="lede">Set up the providers your team may use, then choose a provider and model for each agent. Changes apply to the next task.</p>
      </header>

      <ProvidersSection providers={list} presets={providers.data?.presets ?? []} error={providers.error} />

      <section className="section">
        <h2>Agents</h2>
        {list.length === 0 ? (
          <p className="empty">Add a provider first.</p>
        ) : (
          <div className="roles">
            {sorted.map((setting) => (
              <RoleRow key={setting.role} setting={setting} providers={list} catalogs={catalogs} />
            ))}
          </div>
        )}
      </section>

      <SpendingSection providers={list} catalogs={catalogs} />

      <PricesSection />

      <Notifications />

      <Housekeeping />
    </div>
  );
}

function ProvidersSection({ providers, presets, error }: { providers: Provider[]; presets: ProviderPreset[]; error: string | null | undefined }) {
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <section className="section">
      <div className="section-head">
        <h2>Providers</h2>
        {editing !== "new" && (
          <button type="button" onClick={() => setEditing("new")}>
            Add provider
          </button>
        )}
      </div>
      <p className="muted">
        Any OpenAI-compatible API, Anthropic or Google Gemini. Keys are encrypted on the server and never shown again, and agents never see them.
      </p>
      {error && <p className="error-text">{error}</p>}
      {editing === "new" && <ProviderForm presets={presets} onDone={() => setEditing(null)} />}
      {providers.length > 0 && (
        <div className="providers">
          {providers.map((provider) =>
            editing === provider.id ? (
              <ProviderForm key={provider.id} provider={provider} presets={presets} onDone={() => setEditing(null)} />
            ) : (
              <ProviderRow key={provider.id} provider={provider} onEdit={() => setEditing(provider.id)} />
            ),
          )}
        </div>
      )}
    </section>
  );
}

function ProviderRow({ provider, onEdit }: { provider: Provider; onEdit: () => void }) {
  const test = useAction();
  const remove = useAction();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const onTest = async () => {
    setResult(null);
    await test.run(async () => {
      const outcome = await api.testProvider(provider.id);
      setResult(outcome.ok ? { ok: true, text: `Works: the provider lists ${outcome.models} models` } : { ok: false, text: outcome.error });
    });
  };
  const onRemove = () => {
    if (window.confirm(`Remove ${provider.name}? Its saved API key is deleted.`)) void remove.run(() => api.deleteProvider(provider.id));
  };
  const problem = test.error ?? remove.error;

  return (
    <div className="provider-row">
      <div className="provider-id">
        <strong>{provider.name}</strong>
        <span className="muted small">{TYPE_LABEL[provider.type]}</span>
        <span className="mono muted small">{provider.baseUrl}</span>
      </div>
      <span className={provider.hasKey ? "key-state key-set" : "key-state"}>{provider.hasKey ? (provider.keyLast4 ? `Key ending ${provider.keyLast4}` : "Key saved") : "No key"}</span>
      <div className="provider-actions">
        <button type="button" className="button-quiet" disabled={test.busy} onClick={() => void onTest()}>
          {test.busy ? "Testing…" : "Test"}
        </button>
        <button type="button" className="button-quiet" onClick={onEdit}>
          Edit
        </button>
        <button type="button" className="button-quiet" disabled={remove.busy} onClick={onRemove}>
          Remove
        </button>
      </div>
      {result && <p className={result.ok ? "muted small" : "error-text"}>{result.text}</p>}
      {problem && <p className="error-text">{problem}</p>}
    </div>
  );
}

function ProviderForm({ provider, presets, onDone }: { provider?: Provider; presets: ProviderPreset[]; onDone: () => void }) {
  const [name, setName] = useState(provider?.name ?? "");
  const [type, setType] = useState<ProviderType>(provider?.type ?? "openai");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const save = useAction();

  const applyPreset = (id: string) => {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    setName(preset.name);
    setType(preset.type);
    setBaseUrl(preset.baseUrl);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const key = apiKey.trim();
    const ok = await save.run(async () => {
      if (provider) await api.updateProvider(provider.id, { name, type, baseUrl, ...(removeKey ? { apiKey: null } : key ? { apiKey: key } : {}) });
      else await api.createProvider({ name, type, baseUrl, ...(key ? { apiKey: key } : {}) });
    });
    if (ok) onDone();
  };

  return (
    <form className="sheet form" onSubmit={submit} autoComplete="off">
      {!provider && (
        <label className="field field-wide">
          Start from
          <span className="field-hint">Fills in the name, API type and base URL. You can change them.</span>
          <select defaultValue="" onChange={(e) => applyPreset(e.target.value)}>
            <option value="">Choose a provider…</option>
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
      </label>
      <label className="field">
        API type
        <select value={type} onChange={(e) => setType(e.target.value as ProviderType)}>
          <option value="openai">OpenAI-compatible</option>
          <option value="anthropic">Anthropic Messages</option>
          <option value="gemini">Google Gemini</option>
        </select>
      </label>
      <label className="field field-wide">
        Base URL
        <span className="field-hint">For example https://api.openai.com/v1, or http://127.0.0.1:11434/v1 for Ollama on this server.</span>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required inputMode="url" spellCheck={false} />
      </label>
      <label className="field field-wide">
        API key
        <span className="field-hint">
          {provider?.hasKey ? "A key is saved. Leave this empty to keep it, or paste a new key to replace it." : "Stored encrypted on the server and never shown again. Local providers need none."}
        </span>
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="new-password" spellCheck={false} disabled={removeKey} />
      </label>
      {provider?.hasKey && (
        <label className="check-line field-wide">
          <input type="checkbox" checked={removeKey} onChange={(e) => setRemoveKey(e.target.checked)} />
          Remove the saved key
        </label>
      )}
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={save.busy}>
          {provider ? "Save provider" : "Add provider"}
        </button>
        <button type="button" className="button-quiet" onClick={onDone}>
          Cancel
        </button>
        {save.error && <span className="error-text">{save.error}</span>}
      </div>
    </form>
  );
}

/** A provider select and a model field that suggests the provider's models. */
function ModelPicker({
  label,
  value,
  onChange,
  providers,
  catalogs,
  allowOff,
}: {
  label: string;
  value: ModelRef | null;
  onChange: (value: ModelRef | null) => void;
  providers: Provider[];
  catalogs: Catalogs;
  allowOff?: boolean;
}) {
  const provider = value?.provider ?? "";
  useEffect(() => {
    if (provider) catalogs.load(provider);
  }, [provider]); // eslint-disable-line react-hooks/exhaustive-deps
  const state = provider ? catalogs.lists[provider] : undefined;
  const listId = `models-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const known = providers.some((p) => p.id === provider);

  return (
    <>
      <select value={provider} onChange={(e) => onChange(e.target.value ? { provider: e.target.value, model: value?.model ?? "" } : null)} aria-label={`${label} provider`}>
        {allowOff ? <option value="">Off</option> : !provider && <option value="">Choose a provider</option>}
        {!known && provider && <option value={provider}>{provider} (removed)</option>}
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <input
        value={value?.model ?? ""}
        disabled={!provider}
        list={listId}
        onChange={(e) => onChange({ provider, model: e.target.value })}
        aria-label={`${label} model`}
        placeholder={state === "loading" ? "Loading models…" : state?.error ? "Type a model id" : "Model id"}
        spellCheck={false}
      />
      <datalist id={listId}>{state && state !== "loading" && state.models.map((m) => <option key={m.id} value={m.id} />)}</datalist>
    </>
  );
}

function SpendingSection({ providers, catalogs }: { providers: Provider[]; catalogs: Catalogs }) {
  const version = useLive((c) => c.kind === "settings" || c.kind === "run");
  const data = useData(() => api.spending(), [version]);
  const [budget, setBudget] = useState("");
  const [model, setModel] = useState<ModelRef | null>(null);
  const [vision, setVision] = useState<ModelRef | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useAction();
  const d = data.data;
  // Fill the form from the saved values only when those change, not on every cost update.
  useEffect(() => {
    if (!d) return;
    setBudget(d.dailyBudgetUsd === null ? "" : String(d.dailyBudgetUsd));
    setModel(d.escalationModel);
    setVision(d.visionModel);
  }, [d?.dailyBudgetUsd, JSON.stringify(d?.escalationModel), JSON.stringify(d?.visionModel)]); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = (ref: ModelRef | null) => (ref && ref.model.trim() ? { provider: ref.provider, model: ref.model.trim() } : null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amount = budget.trim() ? Number(budget) : null;
    if (amount !== null && !(amount > 0)) {
      save.setError("The daily budget must be a number of dollars above 0, or empty for no limit");
      return;
    }
    if ((model && !model.model.trim()) || (vision && !vision.model.trim())) {
      save.setError("Choose a model, or set the provider to Off");
      return;
    }
    setSaved(await save.run(() => api.setSpending({ dailyBudgetUsd: amount, escalationModel: chosen(model), visionModel: chosen(vision) })));
  };
  const touch = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setSaved(false);
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
          <input value={budget} onChange={(e) => touch(setBudget)(e.target.value)} inputMode="decimal" placeholder="2.00" />
        </label>
        <div className="field">
          Stronger model for a second try
          <span className="field-hint">When the Coder's rounds do not get a change accepted, it tries once more with this model. Off turns it off.</span>
          <div className="picker">
            <ModelPicker label="Stronger model" value={model} onChange={touch(setModel)} providers={providers} catalogs={catalogs} allowOff />
          </div>
        </div>
        <div className="field field-wide">
          Model that looks at app screenshots
          <span className="field-hint">When UI files change, the running app is captured on a phone and a desktop and this model judges it. It must understand images. Off skips it; the free page checks still run.</span>
          <div className="picker">
            <ModelPicker label="Screenshot model" value={vision} onChange={touch(setVision)} providers={providers} catalogs={catalogs} allowOff />
          </div>
        </div>
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

const SOURCE_LABEL: Record<NonNullable<PriceRow["source"]>, string> = { manual: "Your price", provider: "From the provider", public: "Public price list" };
const priceText = (value: number | undefined) => (value === undefined ? "" : String(Number(value.toFixed(4))));

function PricesSection() {
  const version = useLive((c) => c.kind === "settings");
  const data = useData(() => api.prices(), [version]);

  return (
    <section className="section">
      <h2>Model prices</h2>
      <p className="muted">
        Task costs and budgets use these prices, in US dollars per million tokens. A price you enter comes first, then the provider's own list, then a public price list.
      </p>
      {data.error && <p className="error-text">{data.error}</p>}
      {data.data && (
        <div className="prices">
          {data.data.models.map((row) => (
            <PriceForm key={`${row.provider} ${row.model}`} row={row} />
          ))}
        </div>
      )}
    </section>
  );
}

function PriceForm({ row }: { row: PriceRow }) {
  const [input, setInput] = useState(priceText(row.price?.input));
  const [output, setOutput] = useState(priceText(row.price?.output));
  const [cacheRead, setCacheRead] = useState(priceText(row.price?.cacheRead));
  const save = useAction();
  useEffect(() => {
    setInput(priceText(row.price?.input));
    setOutput(priceText(row.price?.output));
    setCacheRead(priceText(row.price?.cacheRead));
  }, [JSON.stringify(row.price)]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const numbers = [input, output].map((v) => Number(v));
    if ([input, output].some((v) => !v.trim()) || numbers.some((n) => !(n >= 0))) {
      save.setError("Enter the input and output prices as dollars per million tokens, for example 0.25 and 2");
      return;
    }
    const cache = cacheRead.trim() ? Number(cacheRead) : null;
    if (cache !== null && !(cache >= 0)) {
      save.setError("The cache read price must be a number, or empty");
      return;
    }
    await save.run(() => api.setPrice({ provider: row.provider, model: row.model, input: numbers[0]!, output: numbers[1]!, cacheRead: cache }));
  };

  return (
    <form className="price-row" onSubmit={submit}>
      <div className="price-id">
        <strong className="mono">{row.model}</strong>
        <span className="muted small">{row.providerName}</span>
      </div>
      <span className={row.source ? "price-source" : "price-source price-missing"}>{row.source ? SOURCE_LABEL[row.source] : "No price, so costs count as $0"}</span>
      <input value={input} onChange={(e) => setInput(e.target.value)} inputMode="decimal" placeholder="Input" aria-label={`${row.model} input price`} />
      <input value={output} onChange={(e) => setOutput(e.target.value)} inputMode="decimal" placeholder="Output" aria-label={`${row.model} output price`} />
      <input value={cacheRead} onChange={(e) => setCacheRead(e.target.value)} inputMode="decimal" placeholder="Cache read" aria-label={`${row.model} cache read price`} />
      <button type="submit" disabled={save.busy}>
        Save
      </button>
      {row.source === "manual" ? (
        <button type="button" className="button-quiet" disabled={save.busy} onClick={() => void save.run(() => api.clearPrice(row))}>
          Use automatic
        </button>
      ) : (
        <span />
      )}
      {save.error && <span className="error-text">{save.error}</span>}
    </form>
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

function RoleRow({ setting, providers, catalogs }: { setting: RoleSetting; providers: Provider[]; catalogs: Catalogs }) {
  const [form, setForm] = useState(setting);
  const [saved, setSaved] = useState(false);
  const save = useAction();
  const info = ROLE_INFO[setting.role];
  // Reset only when this role's saved values change, not whenever any other setting reloads the list.
  useEffect(() => setForm(setting), [setting.provider, setting.model, setting.reasoningEffort]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.provider.trim() || !form.model.trim()) {
      save.setError("Choose a provider and a model");
      return;
    }
    setSaved(await save.run(() => api.setRole(setting.role, { provider: form.provider, model: form.model.trim(), reasoningEffort: form.reasoningEffort })));
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
      <ModelPicker
        label={info.name}
        value={{ provider: form.provider, model: form.model }}
        onChange={(value) => change({ provider: value?.provider ?? "", model: value?.model ?? "" })}
        providers={providers}
        catalogs={catalogs}
      />
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
