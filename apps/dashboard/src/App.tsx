import { useEffect, useState } from "react";
import { api, UNAUTHORIZED_EVENT } from "./api.ts";
import { useData, useLive, useRoute } from "./hooks.ts";
import { ApprovalsPage } from "./pages/ApprovalsPage.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { LoginPage } from "./pages/LoginPage.tsx";
import { MemoryPage } from "./pages/MemoryPage.tsx";
import { NewProjectPage } from "./pages/NewProjectPage.tsx";
import { ProjectPage } from "./pages/ProjectPage.tsx";
import { SessionPage } from "./pages/SessionPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";

const TEAM = ["planner", "coder", "reviewer", "critic", "git", "memory"];

export function App() {
  const [auth, setAuth] = useState<"checking" | "login" | "ok">("checking");
  const [loginRequired, setLoginRequired] = useState(false);

  useEffect(() => {
    api
      .authStatus()
      .then((status) => {
        setLoginRequired(status.required);
        setAuth(status.required && !status.authenticated ? "login" : "ok");
      })
      .catch(() => setAuth("ok"));
    const onUnauthorized = () => setAuth("login");
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  if (auth === "checking") return null;
  if (auth === "login") return <LoginPage onLoggedIn={() => setAuth("ok")} />;
  return (
    <Shell
      loginRequired={loginRequired}
      onLogout={async () => {
        await api.logout().catch(() => {});
        setAuth("login");
      }}
    />
  );
}

function Shell({ loginRequired, onLogout }: { loginRequired: boolean; onLogout: () => void }) {
  const [page, id, subId] = useRoute();
  const projectsVersion = useLive((c) => c.kind === "project");
  const approvalsVersion = useLive((c) => c.kind === "approval");
  const projects = useData(() => api.projects(), [projectsVersion]);
  const pending = useData(() => api.approvals("pending"), [approvalsVersion]);
  const needsYou = pending.data?.length ?? 0;
  const current = (name: string, projectId?: string) => (page === name && (projectId === undefined || id === projectId) ? "page" : undefined);

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <a href="#/" className="brand">
          <span className="brand-name">AI Employee</span>
          <span className="brand-team" aria-hidden="true">
            {TEAM.map((role) => (
              <span key={role} className={`role-${role}`} />
            ))}
          </span>
        </a>

        <div className="nav">
          <a href="#/" aria-current={page ? undefined : "page"}>
            Overview
          </a>
          <a href="#/approvals" aria-current={current("approvals")}>
            Needs you
            {needsYou > 0 && (
              <span className="count-needs" aria-label={`${needsYou} waiting`}>
                {needsYou}
              </span>
            )}
          </a>
          <a href="#/memory" aria-current={current("memory")}>
            Global memory
          </a>
          <a href="#/settings" aria-current={current("settings")}>
            Models
          </a>
        </div>

        <div className="nav">
          <div className="nav-heading">Projects</div>
          {projects.data?.map((p) => (
            <a key={p.id} href={`#/project/${p.id}`} aria-current={current("project", p.id)} title={p.localPath}>
              {p.name}
            </a>
          ))}
          {projects.data?.length === 0 && <p className="nav-empty">No projects yet</p>}
          <a href="#/new-project" className="nav-add" aria-current={current("new-project")}>
            Add project
          </a>
        </div>

        {loginRequired && (
          <div className="sidebar-foot">
            <button type="button" className="button-quiet" onClick={onLogout}>
              Log out
            </button>
          </div>
        )}
      </nav>

      <main className="content">
        {page === "project" && id ? (
          <ProjectPage key={id} projectId={id} />
        ) : page === "session" && id ? (
          <SessionPage key={id} sessionId={id} taskId={subId} />
        ) : page === "new-project" ? (
          <NewProjectPage />
        ) : page === "approvals" ? (
          <ApprovalsPage />
        ) : page === "memory" ? (
          <MemoryPage />
        ) : page === "settings" ? (
          <SettingsPage />
        ) : (
          <HomePage />
        )}
      </main>
    </div>
  );
}
