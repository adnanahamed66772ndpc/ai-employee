#!/usr/bin/env bash
# One-time VPS setup: an unprivileged user that runs every AI agent and project check.
# The agent user gets no sudo, no docker, no GitHub credentials and no model API key: it calls models through the
# AI Employee server's gateway, and only the server user can push.
#
#   sudo bash scripts/vps/setup-agent-user.sh
#
# Then add AI_EMPLOYEE_AGENT_USER=aiagent to .env.local, keep projects under /srv/ai-projects and restart.
# Re-run after changing .dsh-home/settings.yaml (npm run setup:dsh).
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
AGENT_USER="${AGENT_USER:-aiagent}"
GROUP="${AGENT_GROUP:-aiwork}"
SERVER_USER="${SERVER_USER:-${SUDO_USER:?run with sudo from the server user account}}"
PROJECTS_DIR="${PROJECTS_DIR:-/srv/ai-projects}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DSH_VERSION="$(node -p "require('$REPO_DIR/packages/dsh-client/package.json').dependencies['@deepseek-ai/dsh']")"

getent group "$GROUP" >/dev/null || groupadd "$GROUP"
id "$AGENT_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$AGENT_USER"
usermod -aG "$GROUP" "$AGENT_USER"
usermod -aG "$GROUP" "$SERVER_USER"
for privileged in sudo docker adm lxd; do gpasswd -d "$AGENT_USER" "$privileged" >/dev/null 2>&1 || true; done

# Agents write only inside task worktrees. The projects folder itself is not writable by the group, so code running
# as the agent can never swap a project checkout (or its .git) for its own.
install -d -o "$SERVER_USER" -g "$GROUP" -m 2755 "$PROJECTS_DIR"
chmod 2755 "$PROJECTS_DIR"
install -d -o "$SERVER_USER" -g "$GROUP" -m 2755 "$PROJECTS_DIR/.worktrees"
loginctl enable-linger "$AGENT_USER"

AGENT_HOME="$(getent passwd "$AGENT_USER" | cut -d: -f6)"
sudo -u "$AGENT_USER" -H bash -c "
  set -e
  mkdir -p ~/dsh ~/.dsh-home
  cd ~/dsh
  [ -f package.json ] || npm init -y >/dev/null
  npm install --no-audit --no-fund '@deepseek-ai/dsh@$DSH_VERSION' >/dev/null
  git config --global --replace-all safe.directory '*'
"

# The server writes DeepSeek Harness settings (providers and models from the Models page, no keys) to a shared file.
# The agent user's settings.yaml links to it, so model changes apply without running this script again.
SHARED_SETTINGS="$PROJECTS_DIR/.tools/dsh/settings.yaml"
install -d -o "$SERVER_USER" -g "$GROUP" -m 755 "$PROJECTS_DIR/.tools" "$PROJECTS_DIR/.tools/dsh"
if [ ! -f "$SHARED_SETTINGS" ]; then
  [ -f "$REPO_DIR/.dsh-home/settings.yaml" ] || { echo "start the AI Employee server once (or run 'npm run setup:dsh') first" >&2; exit 1; }
  install -o "$SERVER_USER" -g "$GROUP" -m 644 "$REPO_DIR/.dsh-home/settings.yaml" "$SHARED_SETTINGS"
fi
ln -sfn "$SHARED_SETTINGS" "$AGENT_HOME/.dsh-home/settings.yaml"
chown -h "$AGENT_USER:$AGENT_USER" "$AGENT_HOME/.dsh-home/settings.yaml"
# dsh needs a non-empty key variable; the gateway replaces it with the provider's real key.
install -o "$AGENT_USER" -g "$AGENT_USER" -m 600 /dev/null "$AGENT_HOME/.ai-employee.env"
printf 'AI_EMPLOYEE_GATEWAY_TOKEN=%s\nCHEAPERINFERENCE_API_KEY=%s\n' "supplied-by-ai-employee-gateway" "supplied-by-ai-employee-gateway" > "$AGENT_HOME/.ai-employee.env"

cat > /usr/local/bin/ai-agent-dsh <<'LAUNCHER'
#!/usr/bin/env bash
# Starts DeepSeek Harness over ACP as the agent user.  Usage: ai-agent-dsh <read-only|workspace-write>
set -euo pipefail
case "${1:-}" in read-only|workspace-write) ;; *) echo "usage: ai-agent-dsh <read-only|workspace-write>" >&2; exit 64 ;; esac
HOME="$(getent passwd "$(id -un)" | cut -d: -f6)"
set -a; . "$HOME/.ai-employee.env"; set +a
export HOME DSH_HOME="$HOME/.dsh-home" DSH_PERMISSION_MODE="$1" DSH_TELEMETRY_MODE=DISABLED
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
umask 002
cd "$HOME"
exec node "$HOME/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" --profile acp
LAUNCHER

cat > /usr/local/bin/ai-agent-run <<'RUNNER'
#!/usr/bin/env bash
# Runs a project check command as the agent user.  Usage: ai-agent-run <project-dir> <command>
set -euo pipefail
[ "$#" -eq 2 ] || { echo "usage: ai-agent-run <project-dir> <command>" >&2; exit 64; }
HOME="$(getent passwd "$(id -un)" | cut -d: -f6)"
export HOME CI=1 GIT_TERMINAL_PROMPT=0 XDG_RUNTIME_DIR="/run/user/$(id -u)"
cd -- "$1"
umask 002
exec bash -c "$2"
RUNNER
chmod 755 /usr/local/bin/ai-agent-dsh /usr/local/bin/ai-agent-run

echo "Agent user '$AGENT_USER' is ready."
echo "  groups: $(id -nG "$AGENT_USER")"
echo "  projects: $PROJECTS_DIR (task worktrees in $PROJECTS_DIR/.worktrees)"
echo "  next: add AI_EMPLOYEE_AGENT_USER=$AGENT_USER to $REPO_DIR/.env.local and restart the server"
echo "  note: $SERVER_USER must log in again (or restart the server) to pick up the '$GROUP' group"
