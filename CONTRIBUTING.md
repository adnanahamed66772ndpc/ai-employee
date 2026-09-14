# Contributing

Thanks for helping improve AI Employee. This guide covers setting up, making a change and opening a pull request.

## Set up

You need Node.js 22.13 or newer, git, and the GitHub CLI (`gh`) if you want to try pull requests.

```bash
git clone https://github.com/adnanahamed66772ndpc/ai-employee.git
cd ai-employee
npm install
cp .env.example .env.local     # add your own CHEAPERINFERENCE_API_KEY to run real tasks
npm run setup:dsh
```

Run it with hot reload in two terminals:

```bash
npm run dev              # API server on http://127.0.0.1:7717
npm run dev:dashboard    # dashboard on http://localhost:5173
```

The unit and pipeline tests use fake agents, so they need no API key.

## Make a change

1. Open an issue first for anything bigger than a small fix, so we agree on the approach before you write code.
2. Create a branch from `main`, for example `fix/approval-card-layout` or `feat/pypi-versions`.
3. Keep the change focused and follow the style of the code around it.
4. Add or update tests for new behaviour.
5. Run the checks before you push:

   ```bash
   npm run typecheck
   npm test
   npm run build
   ```

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat(pipeline): …`, `fix(dashboard): …`, `docs: …`, `test: …`. Say what changed and why in the body when it is not obvious.

## Pull requests

- Fill in the pull request template: what changed, why, and how you tested it.
- Every pull request needs a review from a code owner. Only maintainers merge, and `main` is never pushed to directly.
- Include screenshots for dashboard changes, in light and dark mode.
- Never include API keys, passwords, tokens, `.env.local`, `data/` or real project data. The quick checks and reviewers look for secrets, but please check yourself too.

## Project notes

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains the components, the task pipeline and the security layers. Read it before a larger change.
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
