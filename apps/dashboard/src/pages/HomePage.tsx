import { api } from "../api.ts";
import { ApprovalCard } from "../components/ApprovalCard.tsx";
import { EXAMPLE_STATIONS, StationList } from "../components/StationRail.tsx";
import { useData, useLive } from "../hooks.ts";

export function HomePage() {
  const health = useData(() => api.health(), []);
  const approvalsVersion = useLive((c) => c.kind === "approval");
  const projectsVersion = useLive((c) => c.kind === "project");
  const pending = useData(() => api.approvals("pending"), [approvalsVersion]);
  const projects = useData(() => api.projects(), [projectsVersion]);
  const h = health.data;
  const missingKey = h && !h.cheaperInferenceKey;
  const missingModels = h && !h.dshSettings;

  return (
    <div className="page">
      <header className="page-head">
        <h1>Overview</h1>
        <p className="lede">Your AI team plans, writes, tests and reviews changes in your repositories. Nothing reaches GitHub until you approve it.</p>
      </header>

      {(missingKey || missingModels) && (
        <section className="notice notice-danger" aria-label="Setup">
          <h2 className="block-title">Finish setup on the server</h2>
          <ul className="plain-list">
            {missingKey && (
              <li>
                Add <code>CHEAPERINFERENCE_API_KEY</code> to <code>.env.local</code>, then restart the server.
              </li>
            )}
            {missingModels && (
              <li>
                Run <code>npm run setup:dsh</code> so DeepSeek Harness knows which models to use.
              </li>
            )}
          </ul>
        </section>
      )}

      <section className="section">
        <div className="section-head">
          <h2>Needs you</h2>
          {(pending.data?.length ?? 0) > 3 && <a href="#/approvals">See all {pending.data?.length}</a>}
        </div>
        {pending.data?.length === 0 && <p className="empty">Nothing is waiting for you.</p>}
        {pending.data?.slice(0, 3).map((approval) => (
          <ApprovalCard key={approval.id} approval={approval} showTaskLink />
        ))}
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Projects</h2>
          <a className="button" href="#/new-project">
            Add project
          </a>
        </div>
        {projects.data?.length === 0 ? (
          <p className="empty">Add a project to give your team its first task.</p>
        ) : (
          <ul className="rows">
            {projects.data?.map((project) => (
              <li key={project.id} className="row">
                <div className="row-main">
                  <a className="row-title" href={`#/project/${project.id}`}>
                    {project.name}
                  </a>
                  <span className="row-sub mono">{project.localPath}</span>
                </div>
                <span className="row-side">{project.githubRepo ?? "Not on GitHub"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="section">
        <h2>How a task moves</h2>
        <div className="sheet">
          <StationList stations={EXAMPLE_STATIONS} label="How a task moves through the team" />
        </div>
      </section>
    </div>
  );
}
