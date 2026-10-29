#!/bin/sh
# Blocked-pattern list, sourced by scripts/check.sh and tested by
# tests/shell/blocked-patterns-test.sh.
#
# The list blocks attribution of work to an AI, personal absolute paths, and
# credential-shaped tokens. Vendor names and attribution phrases are blocked
# outright; the bare product names of the coding agents this repository wires
# are allowed, because they appear as configuration paths. Tokens that this
# file would otherwise match are split with '' so the pattern does not match
# its own definition.
# shellcheck disable=SC2034
blocked_vendor_one='anthro''pic'
blocked_vendor_two='open''ai'
blocked_vendor_three='chat''gpt'
blocked_phrase='co-''authored'
blocked_path='/''Users/'
blocked_token='gh''o_'
blocked_pattern="$blocked_vendor_one|$blocked_vendor_two|$blocked_vendor_three|gpt-[0-9]|generated (with|by|using) (claude|codex)|claude\\.(ai|com)|$blocked_phrase|$blocked_path|$blocked_token|sk-[A-Za-z0-9]"

check_source_tree() {
  if grep -RniE \
    --exclude=.git --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.ruff_cache \
    --exclude=package-lock.json "$blocked_pattern" "$1"; then
    printf 'check: blocked attribution, path, or credential pattern found\n' >&2
    return 1
  else
    source_status=$?
    if [ "$source_status" -eq 1 ]; then
      return 0
    fi
    return "$source_status"
  fi
}
