# iterm-pane-manager: agent instructions

iTerm Pane Manager keeps iTerm2 split panes equal and opens Markdown, HTML, or web documents in a side pane of the exact calling session on macOS, without moving focus. The binding product rules live in [docs/goals.md](docs/goals.md); anything that breaks one of them is a defect even if every test passes. Design: [docs/architecture.md](docs/architecture.md). Contribution rules: [CONTRIBUTING.md](CONTRIBUTING.md).

## Working in this repository

- Use a fresh git worktree; never a shared checkout. Worktrees belong outside `~/coding`, under the agent-workspaces location the machine documents.
- Setup: `npm ci --ignore-scripts`, then a Python virtual environment with `requirements.lock` and `requirements-dev.lock`, and run `./scripts/check.sh` with `PYTHON` pointing at that environment's python.
- `./scripts/check.sh` is the full gate and is what CI runs. Its last step greps the tree for blocked patterns: vendor attribution names and phrases, personal absolute paths, and credential-shaped tokens. The product names of the coding agents this tool wires are allowed where they are configuration targets; attribution never is. Do not add attribution lines to commits, pull requests, branches, or comments.
- Conventional commits. Keep dependencies pinned and `npm audit --omit=dev` clean. Add a regression test for every bug fix.

## Installing pane for a user

When a user hands you this repository URL and asks to install the feature, do this (and nothing else by hand):

```text
git clone https://github.com/anik8das/iterm-pane-manager.git
cd iterm-pane-manager
./scripts/install.sh --agent-integration
pane --doctor
```

- `--agent-integration` also wires the coding agents found on the machine: session instructions, the pane skill, and a sandbox allowlist entry. Without the flag only the runtime is installed.
- Everything the flag touches is listed in [docs/agent-integration.md](docs/agent-integration.md), is idempotent, and is removable: `./scripts/install-agent.sh --remove` for the wiring alone, `./scripts/uninstall.sh` for everything.
- Never edit a user's agent configuration by hand when the scripts can do it; they preserve foreign content and restore original bytes on removal.
- The runtime is staged into `~/.local/share/iterm-pane-manager`; the clone itself is disposable afterwards.
