#!/bin/sh
# The tilde paths below are literal text samples for the pattern, not paths to
# expand. This directive and every split token are why this file, which the
# pattern scans, stays clean.
# shellcheck disable=SC2088

# Prove the blocked-pattern gate still catches real attribution, personal
# paths, and credential-shaped tokens, and no longer catches the configuration
# paths and product names the agent integration needs.
#
# Every sample that should match is assembled from split pieces; the literals
# never appear in this file.
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH='' cd -- "$script_dir/../.." && pwd)
# shellcheck source=scripts/blocked-patterns.sh
. "$repo_root/scripts/blocked-patterns.sh"

fail() {
  printf 'blocked-patterns-test: %s\n' "$*" >&2
  exit 1
}

matches() {
  printf '%s\n' "$1" | grep -qiE "$blocked_pattern"
}

expect_match() {
  if ! matches "$1"; then
    fail "expected a match: $2"
  fi
}

expect_clean() {
  if matches "$1"; then
    fail "unexpected match: $2"
  fi
}

ai='Clau''de'
vendor='Anthro''pic'
ai_lower=$(printf '%s' "$ai" | tr '[:upper:]' '[:lower:]')
vendor_lower=$(printf '%s' "$vendor" | tr '[:upper:]' '[:lower:]')

expect_match 'Co-''Authored-By: '"$ai"' <noreply@'"$vendor_lower"'.com>' "a co-authorship attribution line"
expect_match "Generated with ${ai} Code" "a generated-with footer"
expect_match "Generated using ${ai} for the draft" "a generated-using phrase"
expect_match "https://$ai_lower.com/pane" "a vendor documentation link"
expect_match 'Open''AI provided the draft' "a vendor name"
expect_match 'GPT''-4 suggested the fix' "a model name"
expect_match '/'"Users/example/project" "a personal absolute path"
expect_match 'gh''o_exampletoken' "a GitHub token prefix"
expect_match 's''k-exampletoken' "an API-key-shaped token"

expect_clean '~/.claude/rules/iterm-pane.md' "the rules file path"
expect_clean '~/.claude/skills/pane' "the skill link path"
expect_clean '~/.codex/AGENTS.md' "the Codex instructions path"
expect_clean 'Claude Code and Codex are wired by the installer' "product names as configuration targets"
expect_clean 'pages generated with mdrender' "unrelated generated-with prose"
expect_clean 'pane --doctor reports health' "ordinary documentation"
expect_clean '/home/runner/.local/state/iterm-pane' "a non-personal home path"

if grep -qiE "$blocked_pattern" "$repo_root/scripts/blocked-patterns.sh"; then
  fail "the pattern file matches its own pattern"
fi
if grep -qiE "$blocked_pattern" "$repo_root/scripts/check.sh"; then
  fail "check.sh matches the blocked pattern"
fi
if grep -qiE "$blocked_pattern" "$0"; then
  fail "this test matches the blocked pattern"
fi

fixture=$(mktemp -d "${TMPDIR:-/tmp}/pane-source-check.XXXXXX")
trap 'rm -rf -- "$fixture"' EXIT HUP INT TERM
printf 'gitdir: /%s/example/repository/.git/worktrees/task\n' 'Users' > "$fixture/.git"
printf 'ordinary source\n' > "$fixture/tracked.mjs"
check_source_tree "$fixture" || fail "worktree metadata was scanned as source"
printf '/%s/example/private\n' 'Users' > "$fixture/tracked.mjs"
if check_source_tree "$fixture" >/dev/null 2>&1; then fail "source path was not rejected"; fi
printf 'ordinary source\n' > "$fixture/tracked.mjs"
printf 'gh%s_exampletoken\n' 'o' > "$fixture/untracked.txt"
if check_source_tree "$fixture" >/dev/null 2>&1; then fail "untracked credential-shaped token was not rejected"; fi

printf 'blocked-patterns-test: OK\n'
