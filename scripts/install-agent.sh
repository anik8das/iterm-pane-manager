#!/bin/sh
# Install (or remove) the pane skill, session instructions, and sandbox
# allowlist entry for the coding agents found on this machine.
#
# Invoked by scripts/install.sh --agent-integration, and safe to run alone.
# Every write is idempotent; --remove undoes exactly what this script did and
# never touches foreign files.
set -eu

install_root=${ITERM_PANE_INSTALL_ROOT:-"$HOME/.local/share/iterm-pane-manager"}
agent_source="$install_root/current/agent"
claude_home=${ITERM_PANE_AGENT_CLAUDE_HOME:-"$HOME/.claude"}
codex_home=${ITERM_PANE_AGENT_CODEX_HOME:-"$HOME/.codex"}
state_dir="$HOME/.local/state/iterm-pane"
skill_name=pane
skill_target="$install_root/current/agent/skills/$skill_name"
rules_name=iterm-pane.md
provenance='<!-- Installed by iterm-pane-manager; remove with scripts/install-agent.sh --remove -->'
begin_marker='<!-- iterm-pane-manager:begin (managed; edit in the iterm-pane-manager repo) -->'
end_marker='<!-- iterm-pane-manager:end -->'

mode=install
settings=1

say() { printf '%s\n' "$*"; }
warn() { printf 'agent-integration: %s\n' "$*" >&2; }

usage() {
  printf 'usage: install-agent.sh [--remove] [--no-settings]\n' >&2
}

for arg in "$@"; do
  case "$arg" in
    --remove) mode=remove ;;
    --no-settings) settings=0 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

if [ "$mode" = install ] && [ ! -d "$agent_source" ]; then
  warn "no agent payload at $agent_source; run scripts/install.sh first"
  exit 1
fi

merge_settings() {
  action=$1
  file=$2
  if ! command -v node >/dev/null 2>&1; then
    warn "node not found; $file left unchanged"
    return 1
  fi
  SETTINGS_ACTION=$action SETTINGS_FILE=$file SETTINGS_ENTRY=$state_dir node <<'NODE'
const fs = require("fs");
const { SETTINGS_ACTION: action, SETTINGS_FILE: file, SETTINGS_ENTRY: entry } = process.env;
let raw = null;
try {
  raw = fs.readFileSync(file, "utf8");
} catch {
  if (action === "remove") process.exit(0);
}
let settings = {};
if (raw !== null) {
  try {
    settings = JSON.parse(raw);
  } catch {
    process.stderr.write(`agent-integration: cannot parse ${file}; leaving it unchanged\n`);
    process.exit(1);
  }
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    process.stderr.write(`agent-integration: ${file} is not a JSON object; leaving it unchanged\n`);
    process.exit(1);
  }
}
if (settings.sandbox === undefined || settings.sandbox === null) settings.sandbox = {};
if (typeof settings.sandbox !== "object" || Array.isArray(settings.sandbox)) {
  process.stderr.write(`agent-integration: ${file} has an unexpected sandbox shape; leaving it unchanged\n`);
  process.exit(1);
}
if (settings.sandbox.filesystem === undefined || settings.sandbox.filesystem === null) settings.sandbox.filesystem = {};
if (typeof settings.sandbox.filesystem !== "object" || Array.isArray(settings.sandbox.filesystem)) {
  process.stderr.write(`agent-integration: ${file} has an unexpected filesystem shape; leaving it unchanged\n`);
  process.exit(1);
}
const list = Array.isArray(settings.sandbox.filesystem.allowWrite) ? settings.sandbox.filesystem.allowWrite : [];
const present = list.includes(entry);
if (action === "add" ? present : !present) process.exit(0);
settings.sandbox.filesystem.allowWrite = action === "add" ? [...list, entry] : list.filter((item) => item !== entry);
fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
process.stdout.write(`allowlist entry ${action === "add" ? "added" : "removed"}: ${entry}\n`);
NODE
}

install_claude() {
  rules_dir="$claude_home/rules"
  rules_file="$rules_dir/$rules_name"
  if [ -e "$rules_file" ] && ! grep -qF iterm-pane-manager "$rules_file" 2>/dev/null; then
    warn "leaving foreign file in place: $rules_file"
  else
    mkdir -p -- "$rules_dir"
    staged="$rules_file.staged.$$"
    {
      printf '%s\n\n' "$provenance"
      cat "$agent_source/instructions.md"
    } > "$staged"
    cat "$staged" > "$rules_file"
    rm -f -- "$staged"
    say "instructions: $rules_file"
  fi

  link="$claude_home/skills/$skill_name"
  if [ -L "$link" ]; then
    case "$(readlink "$link")" in
      "$install_root"/*)
        ln -sfn -- "$skill_target" "$link"
        say "skill: $link"
        ;;
      *) warn "leaving foreign symlink in place: $link" ;;
    esac
  elif [ -e "$link" ]; then
    warn "leaving foreign path in place: $link"
  else
    mkdir -p -- "$claude_home/skills"
    ln -s -- "$skill_target" "$link"
    say "skill: $link"
  fi

  if [ "$settings" -eq 1 ]; then
    if ! merge_settings add "$claude_home/settings.json"; then
      warn "$claude_home/settings.json left unchanged; add the allowlist entry by hand if pane should work from sandboxed sessions"
    fi
  fi
}

remove_claude() {
  rules_file="$claude_home/rules/$rules_name"
  if [ -f "$rules_file" ]; then
    if grep -qF iterm-pane-manager "$rules_file" 2>/dev/null; then
      rm -f -- "$rules_file"
      say "instructions removed: $rules_file"
    else
      warn "leaving foreign file in place: $rules_file"
    fi
  fi

  link="$claude_home/skills/$skill_name"
  if [ -L "$link" ]; then
    case "$(readlink "$link")" in
      "$install_root"/*)
        rm -f -- "$link"
        say "skill removed: $link"
        ;;
      *) warn "leaving foreign symlink in place: $link" ;;
    esac
  fi

  if [ "$settings" -eq 1 ]; then
    if ! merge_settings remove "$claude_home/settings.json"; then
      warn "$claude_home/settings.json left unchanged"
    fi
  fi
}

strip_codex_block() {
  target=$1
  stripped=$2
  if grep -qF iterm-pane-manager:begin "$target" 2>/dev/null; then
    if grep -qF iterm-pane-manager:end "$target" 2>/dev/null; then
      sed -e '/iterm-pane-manager:begin/,/iterm-pane-manager:end/d' "$target" > "$stripped"
      return 0
    fi
    warn "found a begin marker without an end marker in $target; leaving it unchanged"
    return 1
  fi
  cat "$target" > "$stripped"
  return 0
}

install_codex() {
  target="$codex_home/AGENTS.md"
  base="$codex_home/AGENTS.md.base.$$"
  staged="$codex_home/AGENTS.md.staged.$$"
  if [ -f "$target" ]; then
    strip_codex_block "$target" "$base" || { rm -f -- "$base"; return 0; }
  else
    : > "$base"
  fi
  cat "$base" > "$staged"
  if [ -s "$base" ] && [ "$(tail -c 1 "$base" | wc -l | tr -d ' ')" -eq 0 ]; then
    printf '\n' >> "$staged"
  fi
  {
    printf '%s\n' "$begin_marker"
    cat "$agent_source/instructions.md"
    printf '%s\n' "$end_marker"
  } >> "$staged"
  cat "$staged" > "$target"
  rm -f -- "$base" "$staged"
  say "instructions: $target"
}

remove_codex() {
  target="$codex_home/AGENTS.md"
  staged="$codex_home/AGENTS.md.staged.$$"
  if [ ! -f "$target" ]; then
    return 0
  fi
  strip_codex_block "$target" "$staged" || { rm -f -- "$staged"; return 0; }
  if [ -s "$staged" ]; then
    cat "$staged" > "$target"
    say "instructions removed: $target"
  elif [ -L "$target" ]; then
    : > "$target"
    say "instructions removed: $target"
  else
    rm -f -- "$target"
    say "instructions removed: $target (the file held only the managed block)"
  fi
  rm -f -- "$staged"
}

claude_found=0
codex_found=0
if [ -d "$claude_home" ]; then
  claude_found=1
fi
if [ -d "$codex_home" ]; then
  codex_found=1
fi

if [ "$claude_found" -eq 0 ] && [ "$codex_found" -eq 0 ]; then
  say "no coding agent environment found (looked for $claude_home and $codex_home); nothing to wire"
  exit 0
fi

if [ "$mode" = install ]; then
  say "Wiring pane into the coding agents found on this machine"
  if [ "$claude_found" -eq 1 ]; then
    install_claude
  fi
  if [ "$codex_found" -eq 1 ]; then
    install_codex
  fi
  say "Agent integration complete. Undo it with scripts/install-agent.sh --remove."
else
  say "Removing the pane wiring from the coding agents found on this machine"
  if [ "$claude_found" -eq 1 ]; then
    remove_claude
  fi
  if [ "$codex_found" -eq 1 ]; then
    remove_codex
  fi
fi
