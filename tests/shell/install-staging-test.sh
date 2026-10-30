#!/bin/sh
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH='' cd -- "$script_dir/../.." && pwd)
fixture=$(mktemp -d "${TMPDIR:-/tmp}/pane-install-staging.XXXXXX")
trap 'rm -rf -- "$fixture"' EXIT HUP INT TERM

fail() {
  printf 'install-staging-test: %s\n' "$*" >&2
  exit 1
}

mkdir -p "$fixture/commands" "$fixture/runtime/previous"
printf 'retained runtime\n' > "$fixture/runtime/previous/retained"
ln -s "$fixture/runtime/previous" "$fixture/runtime/current"
cat > "$fixture/commands/uname" <<'STUB'
#!/bin/sh
printf 'Darwin\n'
STUB
cat > "$fixture/commands/rsync" <<'STUB'
#!/bin/sh
exit 23
STUB
cat > "$fixture/commands/launchctl" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$PANE_INSTALL_TEST_LOG"
STUB
chmod +x "$fixture/commands/"*

status=0
PATH="$fixture/commands:$PATH" \
  ITERM_PANE_INSTALL_ROOT="$fixture/runtime" \
  ITERM_PANE_BIN_DIR="$fixture/exposed-bin" \
  PANE_INSTALL_TEST_LOG="$fixture/service.log" \
  sh "$repo_root/scripts/install.sh" > "$fixture/install.log" 2>&1 || status=$?
[ "$status" -eq 23 ] || fail "staging failure was not returned"
[ ! -e "$fixture/service.log" ] || fail "staging failure touched the existing service"
[ "$(readlink "$fixture/runtime/current")" = "$fixture/runtime/previous" ] || fail "previous runtime pointer changed"
[ "$(cat "$fixture/runtime/previous/retained")" = 'retained runtime' ] || fail "previous runtime content changed"

printf 'install-staging-test: OK\n'
