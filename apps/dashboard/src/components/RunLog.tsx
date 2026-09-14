import type { ReactNode } from "react";
import type { AgentRun, BrainEvent } from "../api.ts";
import { clock, duration, relativePath } from "../format.ts";
import { DiffView } from "./DiffView.tsx";
import { Markdown } from "./Markdown.tsx";

// Event payloads are free-form JSON written by the server.
type Payload = Record<string, any>;

const ROLES: Record<string, { name: string; glyph: string }> = {
  planner: { name: "Planner", glyph: "P" },
  coder: { name: "Coder", glyph: "C" },
  reviewer: { name: "Reviewer", glyph: "R" },
  git: { name: "Git agent", glyph: "G" },
  critic: { name: "Critic", glyph: "K" },
  memory: { name: "Memory writer", glyph: "M" },
};

const CRITIC_NAMES: Record<string, string> = { ui: "UI critic", security: "Security critic" };
const PURPOSE_NAMES: Record<string, string> = {
  handoff: "Handoff notes",
  project_plan: "Project manager",
  epic_plan: "Project manager",
  merge: "Coder resolving a merge",
  ...CRITIC_NAMES,
};
const criticName = (critic: unknown) => CRITIC_NAMES[String(critic)] ?? "Critic";

const VERBS: Record<string, string> = {
  read: "Read",
  edit: "Edited",
  write: "Wrote",
  create: "Created",
  glob: "Listed files",
  grep: "Searched code",
  search: "Searched code",
  bash: "Ran",
  pwsh: "Ran",
  job_output: "Checked job",
  job_kill: "Stopped job",
  todo_write: "Updated to-dos",
  web_fetch: "Fetched",
  web_search: "Searched the web",
  mcp__brain__memory_search: "Searched memory",
  mcp__brain__memory_write: "Saved memory",
  mcp__brain__project_info: "Read project info",
};

const roleName = (role: string) => ROLES[role]?.name ?? role;

function describeTool(p: Payload, root?: string): { verb: string; target: string } {
  const title = String(p.title ?? "tool");
  const verb = VERBS[title] ?? title.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ");
  let target = typeof p.input === "string" ? p.input : "";
  if (title === "todo_write" || title === "mcp__brain__project_info") target = "";
  if (title === "mcp__brain__memory_write") target = target.match(/"content":"((?:[^"\\]|\\.)*)/)?.[1] ?? target;
  if (target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target)) target = relativePath(target, root);
  return { verb, target };
}

type Turn = { kind: "turn"; key: string; runId: string; role: string; run?: AgentRun; continued: boolean; events: BrainEvent[] };
type Item = Turn | { kind: "event"; key: string; event: BrainEvent };

/** Groups consecutive events of one agent session into a turn; everything else stays a pipeline event. */
function buildItems(events: BrainEvent[], runs: AgentRun[]): Item[] {
  const runById = new Map(runs.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const items: Item[] = [];
  events.forEach((event, index) => {
    if (event.type === "agent_plan") return;
    if (event.type === "check_started" && events.slice(index + 1).some((e) => e.type === "check_finished" && e.payload.command === event.payload.command)) {
      return;
    }
    if (!event.runId) {
      items.push({ kind: "event", key: `event-${event.id}`, event });
      return;
    }
    const previous = items.at(-1);
    if (previous?.kind === "turn" && previous.runId === event.runId) {
      previous.events.push(event);
      return;
    }
    if (event.type === "tool_result" || event.type === "agent_finished") {
      const earlier = [...items].reverse().find((i): i is Turn => i.kind === "turn" && i.runId === event.runId);
      if (earlier) earlier.events.push(event);
      return;
    }
    const run = runById.get(event.runId);
    items.push({
      kind: "turn",
      key: `turn-${event.id}`,
      runId: event.runId,
      role: String(event.payload.role ?? run?.role ?? "agent"),
      run,
      continued: seen.has(event.runId),
      events: [event],
    });
    seen.add(event.runId);
  });
  return items;
}

function TurnView({ turn, root, live }: { turn: Turn; root?: string; live: boolean }) {
  const base = ROLES[turn.role] ?? { name: turn.role, glyph: turn.role.slice(0, 1).toUpperCase() };
  const purpose = turn.events.find((e) => e.type === "agent_started")?.payload.purpose;
  const role = typeof purpose === "string" && PURPOSE_NAMES[purpose] ? { ...base, name: PURPOSE_NAMES[purpose]! } : base;
  const first = turn.events[0]!;
  const last = turn.events.at(-1)!;
  const finished = turn.events.find((e) => e.type === "agent_finished");
  const failedCalls = new Set(turn.events.filter((e) => e.type === "tool_result" && e.payload.status === "failed").map((e) => String(e.payload.toolCallId)));
  const body = turn.events.filter((e) => e.type === "tool_call" || e.type === "agent_message" || e.type === "agent_thought");
  const outcome = finished ? String(finished.payload.status ?? "succeeded") : null;

  return (
    <section className={`turn role-${turn.role}`} aria-label={`${role.name}${turn.continued ? ", continued" : ""}`}>
      <header className="turn-head">
        <span className="glyph" aria-hidden="true">
          {role.glyph}
        </span>
        <h3 className="turn-name">
          {role.name}
          {turn.continued && <span className="muted"> continued</span>}
        </h3>
        {turn.run?.model && !turn.continued && <span className="turn-model">{turn.run.model}</span>}
        <span className="spacer" />
        {live && <span className="tag status status-working">Working</span>}
        {outcome && outcome !== "succeeded" && <span className="tag status status-failed">{outcome === "cancelled" ? "Cancelled" : "Failed"}</span>}
        <time className="turn-time" dateTime={first.createdAt} title={`${clock(first.createdAt)} to ${clock(last.createdAt)}`}>
          {duration(first.createdAt, last.createdAt)}
        </time>
      </header>
      {body.length > 0 && (
        <div className="turn-body">
          {body.map((event) => (
            <TurnEvent key={event.id} event={event} root={root} failed={failedCalls.has(String(event.payload.toolCallId))} />
          ))}
        </div>
      )}
    </section>
  );
}

function TurnEvent({ event, root, failed }: { event: BrainEvent; root?: string; failed: boolean }) {
  const p = event.payload as Payload;
  if (event.type === "agent_message") {
    return (
      <div className="say">
        <Markdown text={String(p.text ?? "")} />
      </div>
    );
  }
  if (event.type === "agent_thought") {
    const text = String(p.text ?? "");
    return (
      <details className="thought">
        <summary>
          <span className="thought-label">Thinking</span>
          <span className="thought-preview">{text.split("\n").find((line) => line.trim())}</span>
        </summary>
        <Markdown text={text} />
      </details>
    );
  }
  const { verb, target } = describeTool(p, root);
  return (
    <div className="action">
      <span className="action-verb">{verb}</span>
      <span className="action-target" title={target}>
        {target}
      </span>
      {failed && <span className="action-flag">Failed</span>}
    </div>
  );
}

function MemoryList({ items, verb }: { items: Payload[]; verb: string }) {
  if (items.length === 0) return <>{verb === "Recalled" ? "No saved memory applied yet" : "Nothing new to remember"}</>;
  return (
    <details>
      <summary>
        {verb} {items.length} {items.length === 1 ? "memory" : "memories"}
      </summary>
      <ul className="recall">
        {items.map((m, i) => (
          <li key={i}>
            <span className="kind">{m.scope === "global" ? "Global" : "Project"}</span>
            <span>{String(m.content)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function PlanBlock({ plan }: { plan: Payload }) {
  const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);
  const steps = list(plan.steps);
  const files = list(plan.files);
  const criteria = list(plan.acceptanceCriteria);
  const risks = list(plan.risks);
  return (
    <section className="block plan role-planner" aria-label="Plan">
      <h3 className="block-title">Plan</h3>
      {plan.summary && <Markdown text={String(plan.summary)} />}
      {steps.length > 0 && (
        <ol className="steps">
          {steps.map((step, i) => (
            <li key={i}>
              <Markdown text={step} />
            </li>
          ))}
        </ol>
      )}
      {files.length > 0 && (
        <div className="plan-part">
          <span className="plan-label">Files</span>
          <div className="chips">
            {files.map((file) => (
              <code key={file}>{file}</code>
            ))}
          </div>
        </div>
      )}
      {criteria.length > 0 && (
        <div className="plan-part">
          <span className="plan-label">Done when</span>
          <ul className="plain-list">
            {criteria.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      {risks.length > 0 && (
        <div className="plan-part">
          <span className="plan-label">Risks</span>
          <ul className="plain-list">
            {risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function CheckBlock({ p }: { p: Payload }) {
  const ok = Boolean(p.ok);
  return (
    <details className={`block check ${ok ? "is-ok" : "is-failed"}`}>
      <summary className="block-title">
        <span className={ok ? "mark-ok" : "mark-failed"} aria-hidden="true">
          {ok ? "✓" : "✕"}
        </span>
        <code>{String(p.command)}</code>
        <span className="muted">{ok ? "passed" : `failed with exit code ${p.exitCode}`}</span>
      </summary>
      <pre className="pre">{String(p.output ?? "").trim() || "No output"}</pre>
    </details>
  );
}

function VerdictBlock({ p }: { p: Payload }) {
  const approved = Boolean(p.approved);
  const issues = (Array.isArray(p.issues) ? p.issues : []) as Payload[];
  return (
    <section className={`block verdict ${approved ? "is-approved" : "is-changes"}`}>
      <h3 className="block-title">
        {approved ? "Reviewer approved" : "Reviewer asked for changes"}
        {Number(p.round) > 1 && <span className="muted">in round {p.round}</span>}
      </h3>
      {p.summary && <Markdown text={String(p.summary)} />}
      {issues.length > 0 && (
        <ul className="issues">
          {issues.map((issue, n) => (
            <li key={n} className="issue">
              <span className={`sev sev-${String(issue.severity ?? "note").toLowerCase()}`}>{String(issue.severity ?? "note")}</span>
              <span>
                {issue.file && <code>{String(issue.file)}</code>} {String(issue.message ?? "")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const KIND_LABEL: Record<string, string> = { secret: "secret", syntax: "syntax", debug: "leftover", file: "file", dependency: "package" };

function QuickChecksBlock({ p }: { p: Payload }) {
  const findings = (Array.isArray(p.findings) ? p.findings : []) as Payload[];
  const total = Number(p.total) || findings.length;
  return (
    <section className="block verdict is-changes" aria-label="Quick checks">
      <h3 className="block-title">Quick checks found {total === 1 ? "a problem" : `${total} problems`}</h3>
      <p className="muted">Found without a model, so they go back to the Coder before anyone reviews the change.</p>
      <ul className="issues">
        {findings.map((finding, n) => (
          <li key={n} className="issue">
            <span className="sev sev-blocker">{KIND_LABEL[String(finding.kind)] ?? "problem"}</span>
            <span>
              <code>
                {String(finding.file)}
                {finding.line ? `:${String(finding.line)}` : ""}
              </code>{" "}
              {String(finding.message ?? "")}
            </span>
          </li>
        ))}
      </ul>
      {total > findings.length && <p className="muted small">And {total - findings.length} more.</p>}
    </section>
  );
}

function VisualBlock({ p }: { p: Payload }) {
  const passed = Boolean(p.passed);
  const findings = (Array.isArray(p.findings) ? p.findings : []) as Payload[];
  const views = (Array.isArray(p.views) ? p.views : []).map(String);
  return (
    <section className={`block verdict role-critic ${passed ? "is-approved" : "is-changes"}`} aria-label="App check">
      <h3 className="block-title">
        {passed ? "The running app looks right" : `The running app has ${findings.length === 1 ? "a problem" : `${findings.length} problems`}`}
        {Number(p.round) > 1 && <span className="muted">on re-check {Number(p.round) - 1}</span>}
      </h3>
      <p className="muted">
        Opened <code>{String(p.url)}</code> ({String(p.source)}) on {views.join(" and ") || "no screen"}
        {p.model ? <>, judged by <code>{String(p.model)}</code></> : ", without a vision model"}.
      </p>
      {p.summary && <Markdown text={String(p.summary)} />}
      {findings.length > 0 && (
        <ul className="issues">
          {findings.map((finding, n) => (
            <li key={n} className="issue">
              <span className="sev sev-blocker">blocker</span>
              <span>
                {String(finding.problem ?? "")}
                {finding.scenario && <span className="muted"> For example: {String(finding.scenario)}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CriticBlock({ p }: { p: Payload }) {
  const passed = Boolean(p.passed);
  const findings = (Array.isArray(p.findings) ? p.findings : []) as Payload[];
  const name = criticName(p.critic);
  return (
    <section className={`block verdict role-critic ${passed ? "is-approved" : "is-changes"}`}>
      <h3 className="block-title">
        {passed ? `${name} passed` : `${name} found ${findings.length === 1 ? "a problem" : `${findings.length} problems`}`}
        {Number(p.round) > 1 && <span className="muted">on re-check {Number(p.round) - 1}</span>}
      </h3>
      {p.summary && <Markdown text={String(p.summary)} />}
      {p.unreadable && <p className="muted">The critic's reply could not be read, so it did not block the change.</p>}
      {findings.length > 0 && (
        <ul className="issues">
          {findings.map((finding, n) => (
            <li key={n} className="issue">
              <span className="sev sev-blocker">blocker</span>
              <span>
                {finding.file && (
                  <code>
                    {String(finding.file)}
                    {finding.line ? `:${String(finding.line)}` : ""}
                  </code>
                )}{" "}
                {String(finding.problem ?? "")}
                {finding.scenario && <span className="muted"> For example: {String(finding.scenario)}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CommitBlock({ p }: { p: Payload }) {
  const [subject, ...rest] = String(p.message ?? "").split("\n");
  const body = rest.join("\n").trim();
  return (
    <section className="block commit role-git" aria-label="Commit">
      <h3 className="block-title">
        Committed <code>{String(p.sha ?? "").slice(0, 7)}</code>
      </h3>
      <p className="commit-subject">{subject}</p>
      {body && <p className="commit-body">{body}</p>}
      {p.diff ? <DiffView diff={String(p.diff)} /> : p.stat ? <pre className="pre">{String(p.stat).trim()}</pre> : null}
    </section>
  );
}

function PipelineEvent({ event }: { event: BrainEvent }): ReactNode {
  const p = event.payload as Payload;
  const row = (content: ReactNode, tone?: string) => (
    <div className={tone ? `sys ${tone}` : "sys"}>
      <time className="sys-time" dateTime={event.createdAt}>
        {clock(event.createdAt)}
      </time>
      <div className="sys-body">{content}</div>
    </div>
  );

  switch (event.type) {
    case "task_started":
      return row(
        <>
          Started from <code>{String(p.base)}</code>
        </>,
      );
    case "memory_loaded":
      return row(<MemoryList items={(p.items ?? []) as Payload[]} verb="Recalled" />);
    case "plan_ready":
      return <PlanBlock plan={(p.plan ?? {}) as Payload} />;
    case "branch_created":
      return row(
        <>
          Created branch <code>{String(p.branch)}</code>
        </>,
      );
    case "round_started":
      return Number(p.round) > 1 ? <div className="round-divider">Round {String(p.round)}</div> : null;
    case "check_started":
      return row(
        <>
          Running <code>{String(p.command)}</code>
        </>,
      );
    case "check_finished":
      return <CheckBlock p={p} />;
    case "checks_skipped":
      return row("No test or lint command is set or found, so only the quick checks ran");
    case "quick_checks":
      return p.ok ? row(`Quick checks passed: no secrets, syntax errors, debug leftovers, unwanted files or package problems`) : <QuickChecksBlock p={p} />;
    case "versions_checked": {
      const rows = (Array.isArray(p.packages) ? p.packages : []) as Payload[];
      const named = (status: string) => rows.filter((r) => r.status === status);
      const list = (items: Payload[], to: boolean) =>
        items.map((r) => (
          <code key={String(r.name)}>
            {String(r.name)} {String(r.current ?? "")}
            {to && r.stable ? ` → ${String(r.stable)}` : ""}
          </code>
        ));
      const majors = named("major");
      const deprecated = named("deprecated");
      const failed = Number(p.failed) || 0;
      return row(
        <>
          Checked {rows.length === 1 ? "1 package" : `${rows.length} packages`} on npm for the Planner and Coder
          {majors.length > 0 && <>; newer major versions (not upgraded unless the task asks): {list(majors, true)}</>}
          {deprecated.length > 0 && <>; deprecated: {list(deprecated, false)}</>}
          {failed > 0 && <>; {failed} could not be checked</>}
        </>,
      );
    }
    case "checks_detected": {
      const commands = (Array.isArray(p.commands) ? p.commands : []) as Payload[];
      const dropped = (Array.isArray(p.dropped) ? p.dropped : []) as Payload[];
      const list = (items: Payload[]) => items.map((c) => <code key={String(c.command)}>{String(c.command)}</code>);
      return row(
        <>
          {commands.length ? <>No test or lint command is set, so these from package.json run on every change: {list(commands)}</> : "No checks were taken from package.json."}
          {dropped.length > 0 && <span className="muted"> Not used: {list(dropped)}</span>}
          {p.reason && <span className="muted"> {String(p.reason)}.</span>}
        </>,
        dropped.length ? "sys-warn" : undefined,
      );
    }
    case "review_verdict":
      return <VerdictBlock p={p} />;
    case "critics_planned": {
      const critics = (Array.isArray(p.critics) ? p.critics : []) as Payload[];
      return row(`Final check before the commit: ${critics.map((c) => `${criticName(c.critic)} (${String(c.reason)})`).join(", ")}`);
    }
    case "critics_skipped": {
      const off = (Array.isArray(p.turnedOff) ? p.turnedOff : []).map(criticName);
      return off.length
        ? row(`No critic checked this change: the ${off.join(" and ")} ${off.length === 1 ? "is" : "are"} turned off for this project`, "sys-warn")
        : row("No critic needed: no UI or security-sensitive files changed");
    }
    case "critic_verdict":
      return <CriticBlock p={p} />;
    case "goal_planned": {
      const epics = (Array.isArray(p.epics) ? p.epics : []) as Payload[];
      return (
        <section className="block plan role-planner" aria-label="Project plan">
          <h3 className="block-title">Project plan: {epics.length === 1 ? "1 epic" : `${epics.length} epics`}</h3>
          {p.summary && <Markdown text={String(p.summary)} />}
          <ol className="steps">
            {epics.map((epic, i) => (
              <li key={i}>
                <strong>{String(epic.title)}</strong>
                {epic.description ? <span className="muted"> {String(epic.description)}</span> : null}
              </li>
            ))}
          </ol>
        </section>
      );
    }
    case "plan_approved":
      return row("You approved the plan");
    case "plan_rejected":
      return row("You rejected the plan");
    case "epic_planned": {
      const tasks = (Array.isArray(p.tasks) ? p.tasks : []) as Payload[];
      return (
        <section className="block plan role-planner" aria-label="Epic tasks">
          <h3 className="block-title">Tasks for {String(p.epic)}</h3>
          <ol className="steps">
            {tasks.map((task, i) => (
              <li key={i}>
                {String(task.title)}
                {Array.isArray(task.acceptance) && task.acceptance.length > 0 && (
                  <span className="muted"> Done when: {task.acceptance.map(String).join("; ")}</span>
                )}
              </li>
            ))}
          </ol>
        </section>
      );
    }
    case "merged_into_epic":
      return row(
        <>
          Added to the epic branch <code>{String(p.branch)}</code>
        </>,
      );
    case "goal_paused":
      return row(`Paused the goal: ${String(p.reason)}`, "sys-warn");
    case "epic_pushed":
      return (
        <div className="notice notice-ok">
          <span>
            Epic pushed into <code>{String(p.base)}</code>:{" "}
            <a href={String(p.url)} target="_blank" rel="noreferrer">
              {String(p.url)}
            </a>
          </span>
        </div>
      );
    case "base_refreshed":
      if (p.diverged) {
        return row(
          <>
            Your local <code>{String(p.base)}</code> and GitHub's have both changed, so the task started from the local one
          </>,
          "sys-warn",
        );
      }
      return p.source === "origin"
        ? row(
            <>
              Started from the newest <code>{String(p.base)}</code> on GitHub
            </>,
          )
        : null;
    case "base_merge_started":
      return Array.isArray(p.conflicts) && p.conflicts.length > 0
        ? row(`Merging the newest ${String(p.base)} before the push: conflicts in ${p.conflicts.map(String).join(", ")}`, "sys-warn")
        : null;
    case "base_merged":
      return row(
        <>
          Merged the newest <code>{String(p.base)}</code> before the push
          {Array.isArray(p.conflicts) && p.conflicts.length > 0 ? " and resolved the conflicts" : ""}
        </>,
      );
    case "agent_retry":
      return row(`The ${p.purpose ? (PURPOSE_NAMES[String(p.purpose)] ?? roleName(String(p.role))) : roleName(String(p.role))} hit an error and is starting over once: ${String(p.message)}`, "sys-warn");
    case "critic_fix_started":
      return <div className="round-divider">Fix round {String(p.round)} for the critics</div>;
    case "committed":
      return <CommitBlock p={p} />;
    case "permission_denied":
      return row(`Blocked the ${roleName(String(p.role))} from getting wider access`, "sys-warn");
    case "permissions_fix_failed":
      return row("Could not hand the agent's files to the shared group", "sys-warn");
    case "memory_written":
      return row(`Saved to ${p.scope === "global" ? "global" : "project"} memory: ${String(p.content)}`);
    case "memories_saved":
      return row(
        <>
          <MemoryList items={(p.items ?? []) as Payload[]} verb="Saved" />
          {Number(p.duplicates) > 0 && <span className="muted">Skipped {Number(p.duplicates)} the team already knew.</span>}
        </>,
      );
    case "memory_failed":
      return row(`Memory writer skipped: ${String(p.message)}`);
    case "setup_started":
      return null;
    case "setup_finished":
      return <CheckBlock p={p} />;
    case "handoff_updated": {
      const files = (Array.isArray(p.files) ? p.files : []).map(String);
      const skipped = (Array.isArray(p.skipped) ? p.skipped : []).map(String);
      return row(
        <>
          Updated the handoff notes{" "}
          {files.map((file) => (
            <code key={file}>{file}</code>
          ))}
          {skipped.length > 0 && <span className="muted"> Kept the old {skipped.join(" and ")} because the new version looked cut off.</span>}
        </>,
      );
    }
    case "handoff_failed":
      return row(`The handoff notes were not updated: ${String(p.message)}`, "sys-warn");
    case "visual_check":
      return <VisualBlock p={p} />;
    case "visual_skipped":
      return row(`The running app was not checked: ${String(p.reason)}`, "sys-warn");
    case "visual_review_failed":
      return row(`The screenshots could not be reviewed by ${String(p.model)}: ${String(p.message)}`, "sys-warn");
    case "escalated":
      return row(
        <>
          The {p.reason === "critics" ? "critics" : "review"} did not pass with <code>{String(p.from)}</code>, so the Coder tries once more with{" "}
          <code>{String(p.to)}</code>
        </>,
        "sys-warn",
      );
    case "escalation_failed":
      return row(`The second try with ${String(p.model)} could not start: ${String(p.message)}`, "sys-warn");
    case "task_continued":
      return <div className="round-divider">Continued by you{p.note ? `: ${String(p.note)}` : ""}</div>;
    case "task_resumed":
      return row("Picked up the earlier work in the same folder");
    case "worktree_removed":
      return row("Removed the task's working copy. The branch is kept.");
    case "needs_human":
      return (
        <div className="notice notice-needs">
          <span>
            {p.reason === "critics"
              ? "The critics still found problems after the fix rounds, so nothing was committed."
              : p.reason === "secret"
                ? "The change contains a secret, so nothing was committed."
                : "Not approved after the review rounds."}{" "}
            The changes are still on the branch
            {p.worktree ? (
              <>
                {" "}
                in <code>{String(p.worktree)}</code>
              </>
            ) : null}{" "}
            for you to check.
          </span>
        </div>
      );
    case "approval_rejected":
      return row(
        <>
          Kept <code>{String(p.branch)}</code> local
        </>,
      );
    case "pushed":
      return row(
        <>
          Pushed <code>{String(p.branch)}</code>
        </>,
      );
    case "pr_opened":
      return (
        <div className="notice notice-ok">
          <span>
            Pull request opened:{" "}
            <a href={String(p.url)} target="_blank" rel="noreferrer">
              {String(p.url)}
            </a>
          </span>
        </div>
      );
    case "push_failed":
      return <div className="notice notice-danger">Push failed: {String(p.message)}</div>;
    case "task_failed":
      return row(p.reason === "budget" ? "Stopped: this task reached its budget" : "Task stopped", "sys-warn");
    case "task_cancelled":
      return row("Task cancelled");
    default:
      return null;
  }
}

export function RunLog({ events, runs, root, active }: { events: BrainEvent[]; runs: AgentRun[]; root?: string; active: boolean }) {
  const items = buildItems(events, runs);
  if (items.length === 0) return <p className="empty">{active ? "Waiting for the first agent to start…" : "Nothing was recorded for this task."}</p>;
  const lastTurn = items.reduce((found, item, index) => (item.kind === "turn" ? index : found), -1);
  return (
    <div className="log">
      {items.map((item, index) =>
        item.kind === "turn" ? (
          <TurnView
            key={item.key}
            turn={item}
            root={root}
            live={active && index === lastTurn && !item.events.some((e) => e.type === "agent_finished")}
          />
        ) : (
          <PipelineEvent key={item.key} event={item.event} />
        ),
      )}
    </div>
  );
}
