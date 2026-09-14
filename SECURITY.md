# Security policy

AI Employee runs AI agents that read and change code, run commands and push to GitHub. Security reports are welcome and taken seriously.

## Supported versions

Only the latest commit on `main` is supported. There are no release branches yet.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. If that button is not available, open a minimal issue that only asks the maintainer for a private contact, without any details.

Please include:

- what an attacker can do, and what they need first (for example, "a task prompt" or "a malicious dependency");
- the steps to reproduce it, or a proof of concept;
- the commit you tested and how the server was set up (local, or a server with an agent user).

Expect a first answer within 7 days. Once a fix is merged, the report can be published with credit to you if you want it.

## What counts

These are in scope:

- an agent escaping its sandbox, its task worktree or the agent user;
- an agent reaching the model API key, GitHub credentials, the dashboard password or the brain database;
- pushing, opening a pull request or merging without the owner's approval;
- the memory endpoint (`/mcp`) or model gateway (`/llm/`) answering requests that are not local;
- login bypass, session forgery, cross-site requests or host header tricks against the dashboard;
- secrets written to memory, handoff notes, commits or logs;
- anything from a repository, dependency or registry text that makes the server run commands.

These are not in scope:

- problems that need the server user or root already;
- a deployment that skips the documented agent user or exposes port 7717 without nginx and a password;
- bugs in DeepSeek Harness, CheaperInference or GitHub themselves (report those to their maintainers).

## Hardening checklist for operators

- Run agents as the unprivileged agent user (`sudo bash scripts/vps/setup-agent-user.sh` and `AI_EMPLOYEE_AGENT_USER=aiagent`).
- Keep the server on `127.0.0.1` behind nginx with HTTPS, and set a strong dashboard password (`npm run set-password`).
- Keep `CHEAPERINFERENCE_API_KEY` and other secrets only in `.env.local` on the server. Never commit it, and rotate a key that was ever pasted into a chat, issue or log.
- Review every pull request the agents open before you merge it.
