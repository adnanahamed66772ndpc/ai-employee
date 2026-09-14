import { useState } from "react";
import { api, type Memory, type MemoryKind, type Scope } from "../api.ts";
import { useAction, useData, useLive } from "../hooks.ts";

const KINDS: { value: MemoryKind; label: string }[] = [
  { value: "preference", label: "Preference" },
  { value: "convention", label: "Convention" },
  { value: "fact", label: "Fact" },
  { value: "lesson", label: "Lesson" },
  { value: "note", label: "Note" },
];
const kindLabel = (kind: MemoryKind) => KINDS.find((k) => k.value === kind)?.label ?? kind;

export function MemoryPanel({ scope, projectId, title, description }: { scope: Scope; projectId?: string; title: string; description: string }) {
  const version = useLive((c) => c.kind === "memory");
  const [query, setQuery] = useState("");
  const memories = useData(async () => {
    if (query.trim()) return (await api.memories({ projectId, q: query })).filter((m) => m.scope === scope);
    return api.memories(scope === "project" ? { projectId } : {});
  }, [version, query, scope, projectId]);

  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>{title}</h2>
          <p className="muted small">{description}</p>
        </div>
        <input type="search" style={{ maxWidth: 260 }} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search memory" aria-label={`Search ${title.toLowerCase()}`} />
      </div>
      <AddMemory scope={scope} projectId={projectId} />
      {memories.error && <p className="error-text">{memories.error}</p>}
      <ul className="memory-list">
        {memories.data?.map((memory) => (
          <MemoryItem key={memory.id} memory={memory} projectId={projectId} />
        ))}
      </ul>
      {memories.data?.length === 0 && (
        <p className="empty">{query ? "No memories match that search." : "Nothing saved yet. Agents add what they learn here, and so can you."}</p>
      )}
    </section>
  );
}

function AddMemory({ scope, projectId }: { scope: Scope; projectId?: string }) {
  const [content, setContent] = useState("");
  const [kind, setKind] = useState<MemoryKind>(scope === "global" ? "preference" : "convention");
  const action = useAction();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) {
      action.setError("Write what the team should remember");
      return;
    }
    const ok = await action.run(() => api.createMemory({ scope, projectId: scope === "project" ? projectId : null, kind, content: content.trim() }));
    if (ok) setContent("");
  };

  return (
    <form className="memory-add" onSubmit={submit}>
      <select value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)} aria-label="Kind of memory">
        {KINDS.map((k) => (
          <option key={k.value} value={k.value}>
            {k.label}
          </option>
        ))}
      </select>
      <input
        value={content}
        onChange={(e) => {
          setContent(e.target.value);
          action.setError(null);
        }}
        placeholder={scope === "global" ? "For example: I prefer small pull requests with tests" : "For example: Run unit tests with npm run test:unit"}
        aria-label="Memory"
      />
      <button type="submit" className="button-primary" disabled={action.busy}>
        Save memory
      </button>
      {action.error && <span className="error-text" style={{ gridColumn: "1 / -1" }}>{action.error}</span>}
    </form>
  );
}

function MemoryItem({ memory, projectId }: { memory: Memory; projectId?: string }) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(memory.content);
  const action = useAction();

  const save = async () => {
    if (!content.trim()) {
      action.setError("A memory cannot be empty");
      return;
    }
    if (await action.run(() => api.updateMemory(memory.id, { content: content.trim() }))) setEditing(false);
  };
  const move = () =>
    void action.run(() => api.updateMemory(memory.id, memory.scope === "project" ? { scope: "global" } : { scope: "project", projectId: projectId ?? null }));
  const remove = () => {
    if (window.confirm("Delete this memory? Agents will no longer see it.")) void action.run(() => api.deleteMemory(memory.id));
  };

  return (
    <li className="memory">
      <span className="kind">{kindLabel(memory.kind)}</span>
      {editing ? (
        <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={3} aria-label="Edit memory" />
      ) : (
        <span className="memory-content">{memory.content}</span>
      )}
      <span className="memory-actions">
        {editing ? (
          <>
            <button type="button" className="button-primary button-small" onClick={() => void save()} disabled={action.busy}>
              Save
            </button>
            <button type="button" className="button-quiet button-small" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button type="button" className="button-quiet button-small" onClick={() => setEditing(true)}>
              Edit
            </button>
            {(memory.scope === "project" || projectId) && (
              <button type="button" className="button-quiet button-small" onClick={move} disabled={action.busy}>
                {memory.scope === "project" ? "Make global" : "Move to project"}
              </button>
            )}
            <button type="button" className="button-quiet button-small button-danger" onClick={remove} disabled={action.busy}>
              Delete
            </button>
          </>
        )}
      </span>
      {action.error && <span className="error-text">{action.error}</span>}
    </li>
  );
}
