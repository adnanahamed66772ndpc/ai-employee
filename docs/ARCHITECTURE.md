# Architecture

AI Employee is a self-hosted team of AI agents that plan, code, review and open pull requests in Git repositories. One Node.js process runs the web dashboard, the API, the task pipeline and a shared "brain". It can run on a laptop or on a Linux server behind a reverse proxy.

## Components

```
Browser ──HTTPS──► reverse proxy (nginx) :443
                        │  /mcp and /llm/ → 404
                        ▼
      production:  server :7717 (serves the built dashboard and the API)
      development: Vite :5173 ──/api proxy──► server :7717

apps/server  (Node 22.13+, Hono, one process, listens on 127.0.0.1 only)
  ├─ Brain            packages/brain → SQLite file data/brain.db (node:sqlite, WAL, FTS5)
  ├─ REST API + SSE   /api/*   (login required when a password is set)
  ├─ Brain MCP        /mcp     Streamable HTTP, a bearer token per agent session, direct local requests only
  ├─ Model gateway    /llm/v1  chat completions → CheaperInference with the server's key; meters usage; direct local only
  ├─ Orchestrator     apps/server/src/pipeline.ts (up to AI_EMPLOYEE_MAX_TASKS tasks at once, one worktree each)
  ├─ Agent pool       long-lived `dsh --profile acp` processes: read-only and workspace-write
  ├─ Notifications    apps/server/src/notify.ts (Telegram)
  └─ Git              packages/git (execFile, hooks disabled, worktrees) + the GitHub CLI
```

| Package | Role |
|---|---|
| `packages/brain` | Schema and migrations; projects, sessions, tasks, agent runs, events, approvals, memories and settings; FTS5 memory search; memory de-duplication; usage per run; change events |
| `packages/dsh-client` | ACP client for DeepSeek Harness: spawn (directly or through a launcher), sessions, model selection, prompts, permission callback |
| `packages/git` | Git and GitHub CLI helpers: worktrees with an explicit `--git-dir`, diff, commit, push, pull requests, init |
| `apps/server` | Config, auth, API, MCP, model gateway, permission policy, checks runner, quick checks, critics, app check, package versions, project flows, handoff notes, pipeline, project manager, maintenance, notifications |
| `apps/dashboard` | Vite + React UI (hash routing, live updates over SSE) |
| `scripts/` | `setup-dsh.ts`, `smoke-acp.ts`, `set-password.ts`, `telegram-chat-id.ts`, `vps/setup-agent-user.sh` |
| `deploy/` | nginx site template, pm2 development and production configs |

## Agents and models

All agents are [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`@deepseek-ai/dsh`, pinned) sessions over ACP. Its `cheaperinference` provider points at the server's gateway (`http://127.0.0.1:7717/llm/v1`), which forwards to CheaperInference. Models are set per role on the dashboard's **Models** page; the default for every role is `deepseek-v4-flash`.

| Role | Mode | Job |
|---|---|---|
| Project manager | read-only | Splits a goal into epics, and each epic into small tasks when its turn comes (`manager.ts`) |
| Planner | read-only | Reads the code, the project's `.ai/HANDOFF.md` and memory, returns a JSON plan |
| Coder | workspace-write | Implements the change in the task worktree and runs tests; can save memory |
| Reviewer | read-only | Logic and backend critic: requirements, crashes, frontend/backend agreement, migrations, tests; returns a JSON verdict |
| Critics (UI, security) | read-only | Final check before the commit, only when changed files need them; blockers with file:line and a scenario (`critics.ts`) |
| Handoff notes | read-only | Returns the managed project's updated `.ai/` notes |
| Git agent | read-only | Writes the commit message and pull request text as JSON |
| Memory writer | read-only | Proposes up to 5 durable memories as JSON |

DeepSeek Harness telemetry is always off (`DSH_TELEMETRY_MODE=DISABLED`).

## Task lifecycle (`apps/server/src/pipeline.ts`)

1. The dashboard creates a task (`queued`). The orchestrator claims tasks while fewer than the maximum are running.
2. With an agent user, the server makes sure the agent cannot write the project checkout or its `.git`.
3. Memory is recalled: FTS search, global preferences and project conventions.
4. A worktree is created: `git worktree add -b ai/<id>-<slug> <projects>/.worktrees/<folder>-<id8> <base>`. A single task starts from `origin/<base>` when that is newer.
5. The project's **setup command**, if any, runs in the worktree as the agent user.
6. **Package versions:** the root package.json's direct dependencies are looked up on the npm registry (`versions_checked`).
7. The **Planner** writes the plan (`plan_ready`).
8. Up to 3 rounds:
   - The **Coder** runs (one session across rounds).
   - **Quick checks** scan the staged change: secrets, JSON/YAML/JavaScript syntax, debug leftovers, unwanted or huge files, and risky dependencies. Then the project's test and lint commands run as the agent user. A project without them gets its package.json scripts, kept only if they pass before the change.
   - Problems go back to the Coder; otherwise the **Reviewer** runs, and its issues go back to the Coder.
9. **Critics:** changed files are routed to the UI and security critics. For UI changes the app can be started and captured at 390px and 1280px, with axe, console errors and a vision model. Findings go back to the Coder for up to 2 fix rounds.
10. If the Coder's rounds fail, one extra try runs with a stronger model in a fresh session.
11. If the review or critics still fail, the task becomes `needs_human`. The changes stay uncommitted in the worktree, and the owner can continue the task with a note.
12. The managed project's **handoff notes** in `.ai/` are updated. A last secret scan runs, then the **Git agent** writes the messages and the server commits.
13. A `push_and_pr` approval is created (`awaiting_approval`), and the **Memory writer** saves lessons.
14. **Approve:** the newest base is merged in (conflicts go to the Coder and checks re-run), then the branch is pushed and a pull request opened. **Reject:** the branch stays local.

**Budgets:** every model call is recorded on its agent run. A task stops at its project's budget, and a daily budget across all projects holds new work until the next day.

**Goals:**
- A "big goal" is planned into epics for the owner to approve.
- Each epic gets a branch, is planned into 2–8 tasks, and runs them one at a time on that branch.
- When all tasks are done, the epic is pushed as one pull request after the owner approves it.
- A stuck step pauses the goal until the owner continues it.

**Housekeeping:** old work folders of stopped tasks are removed hourly (after 3 days, or 14 for tasks that need help), and the brain is copied to `data/backups` every night (the newest 7 are kept).

**Deploy panel:**
- The project page lists and sets the repository's GitHub Actions secrets with `gh secret set`. Values go through stdin and are never stored.
- It shows the deploy workflow and the latest runs.
- "Set up the deploy workflow" queues a normal task, so the workflow is reviewed like any other change.

Events are stored in `events` and pushed to the dashboard over SSE (`/api/stream`). The dashboard derives the station rail and the run log from them.

## Security layers

- **Network:** the server listens on 127.0.0.1 only. A host and origin guard allows only local hosts plus `AI_EMPLOYEE_PUBLIC_URL`.
- **Login:**
  - The password is stored as an scrypt hash, sessions use a signed HttpOnly SameSite=Strict cookie, and they last 7 days.
  - Failed logins are limited per client address and in total.
  - The server refuses to start with a public URL and no password.
- **MCP and gateway:** direct local requests only. The reverse proxy also returns 404 for `/mcp` and `/llm/`. MCP tokens are scoped to one project and task.
- **Agent isolation on servers (`AI_EMPLOYEE_AGENT_USER`):**
  - **Launchers:** DeepSeek Harness starts through a launcher as the unprivileged agent user, and setup commands and checks run through a runner as that user.
  - **No access:** the agent user has no sudo, docker, GitHub credentials or model API key, and cannot read the server user's home.
  - **Writable folders:** only each task worktree is writable by the agent user's group. The projects folder, project checkouts and `.git` are not.
- **Sandbox:** most roles are read-only. The Coder may write only its worktree. Requests for wider sandbox access are rejected.
- **Git hardening:** server Git calls run with hooks and fsmonitor disabled, `--no-ext-diff` and `--no-verify`, and address worktrees through their real Git directory. Commands use `execFile`, never a shell.
- **Input validation:** zod schemas, plain repository and folder names, and folder browsing limited to the projects folder (realpath-checked).
- **Secrets:** secret patterns block memory writes, handoff notes and commits.
- **Registry text:** text from the npm registry reaches prompts only as a single quoted line.

## Data

| Location | Contents |
|---|---|
| `data/brain.db` | The SQLite brain (git-ignored). Nightly copies go to `data/backups`. |
| `data/auth.json` | Dashboard password hash and session secret (mode 600, git-ignored) |
| `.dsh-home/` | DeepSeek Harness settings and sessions for the server user (git-ignored) |
| `<projects>/` | Managed project repositories (`/srv/ai-projects` with an agent user, else `~/ai-projects`) |
| `<projects>/.worktrees/` | One worktree per active, stuck or failed task |

Memory scopes are `global` (every project) and `project` (one repository). Search is an FTS5 prefix match ranked by bm25, always limited to global memory plus the current project.

## Configuration (`.env.local`)

| Variable | Meaning |
|---|---|
| `CHEAPERINFERENCE_API_KEY` | Model gateway key (required, server only) |
| `AI_EMPLOYEE_PORT` | Server port, default 7717 |
| `AI_EMPLOYEE_DATA_DIR` | Brain directory, default `./data` |
| `AI_EMPLOYEE_AGENT_USER` | Run agents and checks as this user |
| `AI_EMPLOYEE_AGENT_GROUP` | Shared group, default `aiwork` |
| `AI_EMPLOYEE_PUBLIC_URL` | Public dashboard URL; requires a password |
| `AI_EMPLOYEE_PROJECTS_DIR` | Projects folder |
| `AI_EMPLOYEE_MAX_TASKS` | Tasks at the same time, default 1, at most 8 |
| `AI_EMPLOYEE_TELEGRAM_BOT_TOKEN`, `AI_EMPLOYEE_TELEGRAM_CHAT_ID` | Telegram notifications (both needed) |

## Deployment

- **Production:** `npm run build && pm2 start deploy/pm2/prod.config.cjs`, with the reverse proxy pointing at port 7717, then `pm2 save` and `pm2 startup`.
- **Development:** `pm2 start deploy/pm2/dev.config.cjs`, with the proxy pointing at port 5173.
- **Updating:** `git pull`, `npm ci` if dependencies changed, `npm run build`, then `pm2 restart ai-employee` while no task is running (a restart stops running tasks).
- **nginx and certificates:** see the header of `deploy/nginx/ai-employee.conf`.
- **Agent user:** `sudo bash scripts/vps/setup-agent-user.sh`; run it again after `npm run setup:dsh`.
