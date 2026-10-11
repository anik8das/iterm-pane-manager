#!/bin/sh
# Exercise scripts/install-agent.sh against fixture agent homes: fresh
# install, idempotent rerun, byte-exact removal (including a file with no
# final newline and a symlinked instructions file), settings ownership
# (pre-existing entries, edits made after installation, unparseable files),
# foreign-content and marker-inconsistency refusal, and the no-agent no-op.
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH='' cd -- "$script_dir/../.." && pwd)

work=$(mktemp -d "${TMPDIR:-/tmp}/iterm-pane-agent-test.XXXXXX")
trap 'rm -rf -- "$work"' EXIT HUP INT TERM

fail() {
  printf 'agent-install-test: %s\n' "$*" >&2
  exit 1
}

checks=0
note() {
  checks=$((checks + 1))
}

root="$work/install-root"
mkdir -p "$root/current"
cp -R "$repo_root/agent" "$root/current/agent"
claude="$work/claude-home"
codex="$work/codex-home"
entry="$HOME/.local/state/iterm-pane"
records="$root/agent-integration-state"

reset_homes() {
  rm -rf -- "$claude" "$codex" "$records"
  mkdir -p "$claude" "$codex"
}

run_agent() {
  ITERM_PANE_INSTALL_ROOT="$root" \
    ITERM_PANE_AGENT_CLAUDE_HOME="$claude" \
    ITERM_PANE_AGENT_CODEX_HOME="$codex" \
    sh "$repo_root/scripts/install-agent.sh" "$@"
}

rules_file="$claude/rules/iterm-pane.md"
skill_link="$claude/skills/pane"
settings_file="$claude/settings.json"
codex_file="$codex/AGENTS.md"
codex_skill_link="$codex/skills/pane"
skill_target="$root/current/agent/skills/pane"

# 1. Fresh install wires all artifacts for both agents and records what it did.
reset_homes
run_agent > /dev/null
note
[ -f "$rules_file" ] || fail "rules file missing"
note
grep -qF 'iterm-pane-manager' "$rules_file" || fail "rules provenance missing"
note
grep -qF 'pane --doctor' "$rules_file" || fail "rules body missing"
note
[ -L "$skill_link" ] || fail "skill link missing"
note
[ "$(readlink "$skill_link")" = "$skill_target" ] || fail "skill link target wrong"
note
[ -f "$settings_file" ] || fail "settings file missing"
note
grep -qF "$entry" "$settings_file" || fail "allowlist entry missing"
note
[ -f "$records/settings-was-absent" ] || fail "settings-absent record missing"
note
cmp -s "$settings_file" "$records/settings-after.json" || fail "written-bytes record does not match the file"
note
[ -f "$codex_file" ] || fail "codex instructions missing"
note
grep -qF 'iterm-pane-manager:begin' "$codex_file" || fail "codex begin marker missing"
note
grep -qF 'pane --doctor' "$codex_file" || fail "codex body missing"
note
[ -L "$codex_skill_link" ] || fail "codex skill link missing"
note
[ "$(readlink "$codex_skill_link")" = "$skill_target" ] || fail "codex skill link target wrong"
note

# 2. Rerun changes nothing.
cp "$rules_file" "$work/rules.snap"
cp "$codex_file" "$work/codex.snap"
cp "$settings_file" "$work/settings.snap"
run_agent > /dev/null
cmp -s "$rules_file" "$work/rules.snap" || fail "rules changed on rerun"
note
cmp -s "$codex_file" "$work/codex.snap" || fail "codex file changed on rerun"
note
cmp -s "$settings_file" "$work/settings.snap" || fail "settings changed on rerun"
note
cmp -s "$settings_file" "$records/settings-after.json" || fail "rerun lost the written-bytes record"
note

# 3. Removal restores the pre-install state exactly.
run_agent --remove > /dev/null
note
[ ! -e "$rules_file" ] || fail "rules file survived removal"
note
[ ! -L "$skill_link" ] || fail "skill link survived removal"
note
[ ! -e "$settings_file" ] || fail "settings file (created by the installer) survived removal"
note
[ ! -e "$records" ] || fail "state records survived removal"
note
[ ! -e "$codex_file" ] || fail "codex file (ours alone) survived removal"
note
[ ! -L "$codex_skill_link" ] || fail "codex skill link survived removal"
note

# 4. Existing AGENTS.md content is preserved and restored byte-exactly.
reset_homes
printf 'User instructions here.\n' > "$codex_file"
cp "$codex_file" "$work/codex.original"
run_agent > /dev/null
note
grep -qF 'User instructions here.' "$codex_file" || fail "existing codex content lost"
note
grep -qF 'iterm-pane-manager:begin' "$codex_file" || fail "codex block missing alongside content"
note
run_agent --remove > /dev/null
cmp -s "$codex_file" "$work/codex.original" || fail "codex file not restored byte-exactly"
note

# 5. An AGENTS.md with no final newline is restored byte-exactly too.
reset_homes
printf 'User instructions here.' > "$codex_file"
cp "$codex_file" "$work/codex.nonl.original"
run_agent > /dev/null
note
grep -qF 'iterm-pane-manager:begin' "$codex_file" || fail "block missing when the file had no final newline"
note
run_agent --remove > /dev/null
cmp -s "$codex_file" "$work/codex.nonl.original" || fail "no-final-newline file not restored byte-exactly"
note

# 6. A symlinked AGENTS.md is written through, not replaced.
reset_homes
printf 'Base content.\n' > "$work/shared.md"
cp "$work/shared.md" "$work/shared.original"
ln -s "$work/shared.md" "$codex_file"
run_agent > /dev/null
note
[ -L "$codex_file" ] || fail "symlinked AGENTS.md was replaced"
note
grep -qF 'iterm-pane-manager:begin' "$work/shared.md" || fail "block not written through the symlink"
note
run_agent --remove > /dev/null
note
[ -L "$codex_file" ] || fail "symlink lost on removal"
note
cmp -s "$work/shared.md" "$work/shared.original" || fail "symlink target not restored byte-exactly"
note

# 7. A pre-existing allowlist entry is neither rewritten at install nor
#    deleted at removal; the file returns byte-for-byte.
reset_homes
printf '{\n  "sandbox": {\n    "filesystem": {\n      "allowWrite": [\n        "%s"\n      ]\n    }\n  }\n}\n' "$entry" > "$settings_file"
cp "$settings_file" "$work/settings.original"
run_agent > /dev/null
note
cmp -s "$settings_file" "$work/settings.original" || fail "settings rewritten without a change"
note
run_agent --remove > /dev/null
note
cmp -s "$settings_file" "$work/settings.original" || fail "removal rewrote a pre-existing settings file"
note
grep -qF "$entry" "$settings_file" || fail "removal deleted a pre-existing allowlist entry"
note

# 8. Settings edited after installation keep their edits; only our entry goes.
reset_homes
run_agent > /dev/null
printf '{\n  "model": "opus",\n  "sandbox": {\n    "filesystem": {\n      "allowWrite": [\n        "%s",\n        "/user/own"\n      ]\n    }\n  }\n}\n' "$entry" > "$settings_file"
run_agent --remove > /dev/null
note
grep -qF '"model"' "$settings_file" || fail "user edits lost on removal"
note
grep -qF '/user/own' "$settings_file" || fail "user's own allowlist entry lost on removal"
note
if grep -qF "$entry" "$settings_file"; then
  fail "installer entry survived removal"
fi
note

# 9. Unparseable settings are left alone, with a warning, and wiring continues.
reset_homes
printf 'not json\n' > "$settings_file"
cp "$settings_file" "$work/settings.bad"
if run_agent > /dev/null 2> "$work/bad.err"; then
  note
else
  fail "install failed because settings.json was unparseable"
fi
cmp -s "$settings_file" "$work/settings.bad" || fail "bad settings file was modified"
note
grep -qF 'cannot parse' "$work/bad.err" || fail "no parse warning"
note
[ -L "$skill_link" ] || fail "skill not wired despite bad settings"
note
[ ! -e "$records/settings-was-absent" ] || fail "settings records written despite unparseable settings"
note

# 10. Foreign files at the managed paths are refused, not replaced. A rules
#     file that merely mentions the repository is still foreign.
reset_homes
mkdir -p "$claude/rules" "$claude/skills/pane"
printf 'My own rule.\nMentions iterm-pane-manager in passing.\n' > "$rules_file"
printf 'My own rule.\nMentions iterm-pane-manager in passing.\n' > "$work/rules.expected"
printf 'foreign\n' > "$claude/skills/pane/keep"
if run_agent > /dev/null 2> "$work/foreign.err"; then
  note
else
  fail "install failed on foreign content"
fi
cmp -s "$rules_file" "$work/rules.expected" || fail "foreign rules file was replaced"
note
[ -f "$claude/skills/pane/keep" ] || fail "foreign skill directory was replaced"
note
grep -qF 'leaving foreign' "$work/foreign.err" || fail "no foreign-content warning"
note

# 11. Managed markers that are not a single ordered pair are refused by both
#     install and removal, so nothing between them can be lost.
reset_homes
printf 'before\n<!-- iterm-pane-manager:end -->\nmore user text\n<!-- iterm-pane-manager:begin (managed; edit in the iterm-pane-manager repo) -->\nafter\n' > "$codex_file"
cp "$codex_file" "$work/codex.markers.original"
run_agent > /dev/null 2> "$work/markers.err"
note
cmp -s "$codex_file" "$work/codex.markers.original" || fail "out-of-order markers: install modified the file"
note
grep -qF 'marker' "$work/markers.err" || fail "out-of-order markers: no install warning"
note
run_agent --remove > /dev/null 2> "$work/markers-remove.err"
note
cmp -s "$codex_file" "$work/codex.markers.original" || fail "out-of-order markers: removal modified the file"
note
grep -qF 'marker' "$work/markers-remove.err" || fail "out-of-order markers: no removal warning"
note

# 12. No agent homes: a clean no-op.
out=$(ITERM_PANE_INSTALL_ROOT="$root" \
  ITERM_PANE_AGENT_CLAUDE_HOME="$work/missing-claude" \
  ITERM_PANE_AGENT_CODEX_HOME="$work/missing-codex" \
  sh "$repo_root/scripts/install-agent.sh")
note
printf '%s\n' "$out" | grep -qF 'no coding agent environment found' || fail "no-agent message missing"
note

printf 'agent-install-test: OK (%s checks)\n' "$checks"
