import { useState } from "react";
import { api } from "../api.ts";
import { useAction } from "../hooks.ts";

export function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [password, setPassword] = useState("");
  const action = useAction();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) {
      action.setError("Enter the dashboard password");
      return;
    }
    if (await action.run(() => api.login(password))) onLoggedIn();
    else setPassword("");
  };

  return (
    <main className="login">
      <form className="sheet login-sheet" onSubmit={submit}>
        <div className="brand">
          <span className="brand-name">AI Employee</span>
          <span className="brand-team" aria-hidden="true">
            {["planner", "coder", "reviewer", "git", "memory"].map((role) => (
              <span key={role} className={`role-${role}`} />
            ))}
          </span>
        </div>
        <label className="field">
          Password
          <input
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              action.setError(null);
            }}
          />
        </label>
        <button type="submit" className="button-primary" disabled={action.busy}>
          {action.busy ? "Signing in…" : "Sign in"}
        </button>
        {action.error && <p className="error-text">{action.error}</p>}
      </form>
    </main>
  );
}
