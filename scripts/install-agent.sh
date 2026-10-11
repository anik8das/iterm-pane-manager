#!/bin/sh
# Install (or remove) the pane skill, session instructions, and sandbox
# allowlist entry for the coding agents found on this machine.
#
# Invoked by scripts/install.sh --agent-integration, and safe to run alone.
# Every write is idempotent; --remove undoes exactly what this script did and
# never touches foreign files. A few bytes of bookkeeping under the install
# root record what the user-owned files looked like before the first write, so
# removal restores them byte-for-byte and never deletes an allowlist entry the
# installer did not add.
set -eu

install_root=${ITERM_PANE_INSTALL_ROOT:-"$HOME/.local/share/iterm-pane-manager"}
agent_source="$install_root/current/agent"
claude_home=${ITERM_PANE_AGENT_CLAUDE_HOME:-"$HOME/.claude"}
codex_home=${ITERM_PANE_AGENT_CODEX_HOME:-"$HOME/.codex"}
state_dir="$HOME/.local/state/iterm-pane"
record_dir="$install_root/agent-integration-state"
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

# The installer's own line, and the only text that marks a rules file as ours.
# A file merely mentioning the repository is foreign and is left alone.
rules_owned() {
  [ -f "$1" ] || return 1
  [ "$(sed -n '1p' "$1")" = "$provenance" ]
}

install_skill_link() {
  home=$1
  link="$home/skills/$skill_name"
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
    mkdir -p -- "$home/skills"
    ln -s -- "$skill_target" "$link"
    say "skill: $link"
  fi
}

remove_skill_link() {
  home=$1
  link="$home/skills/$skill_name"
  if [ -L "$link" ]; then
    case "$(readlink "$link")" in
      "$install_root"/*)
        rm -f -- "$link"
        say "skill removed: $link"
        ;;
      *) warn "leaving foreign symlink in place: $link" ;;
    esac
  fi
}

# Add or remove the state directory in sandbox.filesystem.allowWrite.
#
# Ownership rule: the add action records the file's original bytes (or its
# absence) and the exact bytes it wrote, both under the install root. The
# remove action restores the original bytes when nothing else has changed the
# file since, drops only our entry when the user has edited it, and does
# nothing at all when the entry was not added by this installer.
merge_settings() {
  action=$1
  file=$2
  if ! command -v node >/dev/null 2>&1; then
    warn "node not found; $file left unchanged"
    return 1
  fi
  SETTINGS_ACTION=$action SETTINGS_FILE=$file SETTINGS_ENTRY=$state_dir \
    SETTINGS_RECORD_DIR="$record_dir" node <<'NODE'
const fs = require("fs");
const path = require("path");
const {
  SETTINGS_ACTION: action,
  SETTINGS_FILE: file,
  SETTINGS_ENTRY: entry,
  SETTINGS_RECORD_DIR: recordDir,
} = process.env;
const beforePath = path.join(recordDir, "settings-before.json");
const afterPath = path.join(recordDir, "settings-after.json");
const absentPath = path.join(recordDir, "settings-was-absent");
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const leave = (message) => {
  process.stderr.write(`agent-integration: ${message}; leaving it unchanged\n`);
  process.exit(1);
};

let raw = null;
try {
  raw = fs.readFileSync(file, "utf8");
} catch {
  raw = null;
}

if (action === "remove") {
  if (raw === null) process.exit(0);
  let settings;
  try {
    settings = JSON.parse(raw);
  } catch {
    leave(`cannot parse ${file}`);
  }
  if (!isObject(settings)) leave(`${file} is not a JSON object`);
  if (settings.sandbox !== undefined && settings.sandbox !== null && !isObject(settings.sandbox)) {
    leave(`${file} has an unexpected sandbox shape`);
  }
  if (isObject(settings.sandbox) && settings.sandbox.filesystem !== undefined && settings.sandbox.filesystem !== null && !isObject(settings.sandbox.filesystem)) {
    leave(`${file} has an unexpected filesystem shape`);
  }
  if (isObject(settings.sandbox) && isObject(settings.sandbox.filesystem)) {
    const allow = settings.sandbox.filesystem.allowWrite;
    if (allow !== undefined && allow !== null && !Array.isArray(allow)) {
      leave(`${file} has an unexpected allowWrite shape`);
    }
  }
  const list = isObject(settings.sandbox) && isObject(settings.sandbox.filesystem) && Array.isArray(settings.sandbox.filesystem.allowWrite)
    ? settings.sandbox.filesystem.allowWrite
    : [];
  const present = list.includes(entry);
  const recorded = fs.existsSync(beforePath) || fs.existsSync(absentPath);
  const after = fs.existsSync(afterPath) ? fs.readFileSync(afterPath, "utf8") : null;
  if (recorded && after !== null && raw === after) {
    // Untouched since this installer wrote it: put the original back.
    if (fs.existsSync(absentPath)) {
      fs.rmSync(file);
      process.stdout.write(`settings restored: ${file} removed (the installer created it)\n`);
    } else {
      fs.writeFileSync(file, fs.readFileSync(beforePath, "utf8"));
      process.stdout.write(`settings restored: ${file}\n`);
    }
    process.exit(0);
  }
  if (!recorded) {
    if (present) {
      process.stdout.write(`allowlist entry not added by this installer; leaving ${file} unchanged\n`);
    }
    process.exit(0);
  }
  if (!present) process.exit(0);
  // Edited since we wrote it: drop only our entry, keep everything else.
  settings.sandbox.filesystem.allowWrite = list.filter((item) => item !== entry);
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  process.stdout.write(`allowlist entry removed: ${entry}\n`);
  process.exit(0);
}

let settings = {};
if (raw !== null) {
  try {
    settings = JSON.parse(raw);
  } catch {
    leave(`cannot parse ${file}`);
  }
  if (!isObject(settings)) leave(`${file} is not a JSON object`);
}
if (!isObject(settings.sandbox)) {
  if (settings.sandbox !== undefined && settings.sandbox !== null) {
    leave(`${file} has an unexpected sandbox shape`);
  }
  settings.sandbox = {};
}
if (!isObject(settings.sandbox.filesystem)) {
  if (settings.sandbox.filesystem !== undefined && settings.sandbox.filesystem !== null) {
    leave(`${file} has an unexpected filesystem shape`);
  }
  settings.sandbox.filesystem = {};
}
const allow = settings.sandbox.filesystem.allowWrite;
if (allow !== undefined && allow !== null && !Array.isArray(allow)) {
  leave(`${file} has an unexpected allowWrite shape`);
}
const list = Array.isArray(settings.sandbox.filesystem.allowWrite) ? settings.sandbox.filesystem.allowWrite : [];
if (list.includes(entry)) process.exit(0);
// The records are byte copies of a user config file that can hold
// credentials, so they are kept owner-only rather than at the default umask.
fs.mkdirSync(recordDir, { recursive: true, mode: 0o700 });
if (!fs.existsSync(beforePath) && !fs.existsSync(absentPath)) {
  if (raw === null) fs.writeFileSync(absentPath, "");
  else fs.writeFileSync(beforePath, raw, { mode: 0o600 });
}
settings.sandbox.filesystem.allowWrite = [...list, entry];
const next = `${JSON.stringify(settings, null, 2)}\n`;
fs.writeFileSync(file, next);
fs.writeFileSync(afterPath, next, { mode: 0o600 });
process.stdout.write(`allowlist entry added: ${entry}\n`);
NODE
}

install_claude() {
  rules_dir="$claude_home/rules"
  rules_file="$rules_dir/$rules_name"
  if [ -e "$rules_file" ] && ! rules_owned "$rules_file"; then
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

  install_skill_link "$claude_home"

  if [ "$settings" -eq 1 ]; then
    if ! merge_settings add "$claude_home/settings.json"; then
      warn "$claude_home/settings.json left unchanged; add the allowlist entry by hand if pane should work from sandboxed sessions"
    fi
  fi
}

remove_claude() {
  rules_file="$claude_home/rules/$rules_name"
  if [ -f "$rules_file" ]; then
    if rules_owned "$rules_file"; then
      rm -f -- "$rules_file"
      say "instructions removed: $rules_file"
    else
      warn "leaving foreign file in place: $rules_file"
    fi
  fi

  remove_skill_link "$claude_home"

  if [ "$settings" -eq 1 ]; then
    if ! merge_settings remove "$claude_home/settings.json"; then
      warn "$claude_home/settings.json left unchanged"
      return 1
    fi
  fi
  return 0
}

# Copy $target to $stripped with the managed block removed. A managed block
# must be exactly one begin marker and one end marker, in that order; anything
# else is left untouched so a mangled file cannot lose the text between
# markers it was never meant to lose.
strip_codex_block() {
  target=$1
  stripped=$2
  begin_count=$(grep -cF "$begin_marker" "$target" 2>/dev/null || true)
  end_count=$(grep -cF "$end_marker" "$target" 2>/dev/null || true)
  begin_count=${begin_count:-0}
  end_count=${end_count:-0}
  if [ "$begin_count" -eq 0 ] && [ "$end_count" -eq 0 ]; then
    cat "$target" > "$stripped"
    return 0
  fi
  if [ "$begin_count" -ne 1 ] || [ "$end_count" -ne 1 ]; then
    warn "found managed markers that are not a single ordered pair in $target; leaving it unchanged"
    return 1
  fi
  begin_line=$(grep -nF "$begin_marker" "$target" 2>/dev/null | head -n 1 | cut -d: -f1)
  end_line=$(grep -nF "$end_marker" "$target" 2>/dev/null | head -n 1 | cut -d: -f1)
  if [ "$begin_line" -ge "$end_line" ]; then
    warn "found managed markers that are not a single ordered pair in $target; leaving it unchanged"
    return 1
  fi
  # Delete exactly the two full-marker lines. A substring range would also
  # match prose or a code sample that merely quotes the marker text, and
  # everything between that mention and the real block would go with it.
  sed -e "${begin_line},${end_line}d" "$target" > "$stripped"
}

# Record the boundary state of the user's own content before the first append,
# so --remove can restore the file byte-for-byte: an AGENTS.md that did not
# end with a newline gains one for the block, and that byte must come back off.
record_codex_boundary() {
  codex_record="$record_dir/codex-boundary"
  if [ -f "$codex_record" ]; then
    return 0
  fi
  mkdir -p -- "$record_dir"
  if [ ! -f "$codex_home/AGENTS.md" ]; then
    printf 'absent\n' > "$codex_record"
  elif [ ! -s "$base" ]; then
    printf 'empty-file\n' > "$codex_record"
  elif [ "$(tail -c 1 "$base" | wc -l | tr -d ' ')" -eq 0 ]; then
    printf 'no-final-newline\n' > "$codex_record"
  else
    printf 'final-newline\n' > "$codex_record"
  fi
}

install_codex() {
  install_skill_link "$codex_home"

  target="$codex_home/AGENTS.md"
  base="$codex_home/AGENTS.md.base.$$"
  staged="$codex_home/AGENTS.md.staged.$$"
  if [ -f "$target" ]; then
    strip_codex_block "$target" "$base" || { rm -f -- "$base"; return 0; }
  else
    : > "$base"
  fi
  record_codex_boundary
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
  remove_skill_link "$codex_home"

  target="$codex_home/AGENTS.md"
  if [ ! -f "$target" ]; then
    return 0
  fi
  if ! grep -qF "$begin_marker" "$target" 2>/dev/null && ! grep -qF "$end_marker" "$target" 2>/dev/null; then
    return 0
  fi
  staged="$codex_home/AGENTS.md.staged.$$"
  strip_codex_block "$target" "$staged" || { rm -f -- "$staged"; return 1; }

  codex_record="$record_dir/codex-boundary"
  record_value=$(cat "$codex_record" 2>/dev/null || true)
  if [ -s "$staged" ] && [ "$record_value" = no-final-newline ] &&
    [ "$(tail -c 1 "$staged" | wc -l | tr -d ' ')" -eq 1 ]; then
    size=$(wc -c < "$staged")
    head -c "$((size - 1))" "$staged" > "$staged.trim"
    mv -- "$staged.trim" "$staged"
  fi

  if [ -s "$staged" ]; then
    cat "$staged" > "$target"
    say "instructions removed: $target"
  elif [ "$record_value" = empty-file ]; then
    : > "$target"
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
  remove_status=0
  if [ "$claude_found" -eq 1 ]; then
    remove_claude || remove_status=1
  fi
  if [ "$codex_found" -eq 1 ]; then
    remove_codex || remove_status=1
  fi
  if [ "$remove_status" -eq 0 ] && [ "$settings" -eq 1 ]; then
    rm -rf -- "$record_dir"
  elif [ "$remove_status" -ne 0 ]; then
    warn "keeping $record_dir; re-run scripts/install-agent.sh --remove once the files above are fixed"
  fi
fi
