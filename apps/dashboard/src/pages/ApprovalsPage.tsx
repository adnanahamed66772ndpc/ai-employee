import { api } from "../api.ts";
import { ApprovalCard } from "../components/ApprovalCard.tsx";
import { timeAgo } from "../format.ts";
import { useData, useLive } from "../hooks.ts";

export function ApprovalsPage() {
  const version = useLive((c) => c.kind === "approval");
  const approvals = useData(() => api.approvals(), [version]);
  const pending = approvals.data?.filter((a) => a.status === "pending") ?? [];
  const decided = approvals.data?.filter((a) => a.status !== "pending").slice(0, 20) ?? [];

  return (
    <div className="page">
      <header className="page-head">
        <h1>Needs you</h1>
        <p className="lede">Branches wait here until you decide. Approving pushes the branch and opens a pull request; keeping it local leaves it on the server.</p>
      </header>

      {approvals.error && <p className="notice notice-danger">{approvals.error}</p>}

      <section className="section">
        {approvals.data && pending.length === 0 && <p className="empty">Nothing is waiting for you.</p>}
        {pending.map((approval) => (
          <ApprovalCard key={approval.id} approval={approval} showTaskLink />
        ))}
      </section>

      {decided.length > 0 && (
        <section className="section">
          <h2>Recently decided</h2>
          <ul className="rows">
            {decided.map((a) => (
              <li key={a.id} className="row">
                <div className="row-main">
                  <span className="row-title">{a.summary}</span>
                  <span className="row-sub">{a.decidedAt ? `Decided ${timeAgo(a.decidedAt)}` : ""}</span>
                </div>
                <span className={a.status === "approved" ? "tag status status-done" : "tag status"}>{a.status === "approved" ? "Approved" : "Kept local"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
