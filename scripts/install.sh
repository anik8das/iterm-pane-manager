#!/bin/sh
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
source_root=$(CDPATH='' cd -- "$script_dir/.." && pwd)
install_root=${ITERM_PANE_INSTALL_ROOT:-"$HOME/.local/share/iterm-pane-manager"}
release_root="$install_root/releases"
current_link="$install_root/current"
label=io.github.anik8das.iterm-pane-manager
domain="gui/$(id -u)"

say() {
  printf '%s\n' "$*"
}

fail() {
  printf 'install: %s\n' "$*" >&2
  exit 1
}

require() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

choose_bin_dir() {
  if [ -n "${ITERM_PANE_BIN_DIR:-}" ]; then
    printf '%s\n' "$ITERM_PANE_BIN_DIR"
  elif [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
    printf '%s\n' /usr/local/bin
  else
    printf '%s\n' "$HOME/.local/bin"
  fi
}

atomic_link() {
  target=$1
  link=$2
  temporary="$link.next.$$"
  rm -f -- "$temporary"
  ln -s -- "$target" "$temporary"
  mv -fh -- "$temporary" "$link"
}

[ "$(uname -s)" = Darwin ] || fail "this installer supports macOS only"
require node
require npm
require python3
require launchctl
require rsync

node_supported=$(node -p 'const [major, minor] = process.versions.node.split(".").map(Number); Number(major > 20 || (major === 20 && minor >= 19))')
[ "$node_supported" -eq 1 ] || fail "Node.js 20.19 or newer is required"

version=$(node -p 'require(process.argv[1]).version' "$source_root/package.json")
release_id="v${version}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
stage="$release_root/$release_id"
bin_dir=$(choose_bin_dir)
previous_target=
switched=0

if [ -L "$current_link" ]; then
  previous_target=$(readlink "$current_link")
fi

rollback() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -eq 0 ]; then
    exit 0
  fi
  launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
  if [ "$switched" -eq 1 ]; then
    if [ -n "$previous_target" ] && [ -d "$previous_target" ]; then
      atomic_link "$previous_target" "$current_link"
      "$current_link/bin/pane.mjs" --watch-install >/dev/null 2>&1 || true
    else
      rm -f -- "$current_link"
    fi
  fi
  if [ -d "$stage" ]; then
    rm -rf -- "$stage"
  fi
  printf 'install: failed; the previous installation was restored\n' >&2
  exit "$status"
}
trap rollback EXIT HUP INT TERM

say "Staging iTerm Pane Manager $version"
mkdir -p -- "$stage" "$bin_dir"
rsync -a \
  --exclude .git \
  --exclude node_modules \
  --exclude venv \
  --exclude .ruff_cache \
  --exclude '*.html' \
  --exclude '__pycache__' \
  "$source_root/" "$stage/"

chmod +x "$stage/bin/pane.mjs" "$stage/bin/mdrender.mjs"
chmod +x "$stage/scripts/"*.sh

python3 -m venv "$stage/venv"
"$stage/venv/bin/python3" -m pip install --disable-pip-version-check \
  --requirement "$stage/requirements.lock"
npm --prefix "$stage" ci --omit=dev --ignore-scripts

say "Verifying staged release"
npm --prefix "$stage" run check
npm --prefix "$stage" test
npm --prefix "$stage" audit --omit=dev
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$stage/src/iterm_pane" \
  "$stage/venv/bin/python3" -m unittest discover \
  -s "$stage/tests/python" -p 'test_*.py'

mkdir -p -- "$install_root"
launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
atomic_link "$stage" "$current_link"
switched=1
atomic_link "$current_link/bin/pane.mjs" "$bin_dir/pane"
atomic_link "$current_link/bin/mdrender.mjs" "$bin_dir/mdrender"

"$current_link/bin/pane.mjs" --watch-install
"$current_link/bin/pane.mjs" --doctor

trap - EXIT HUP INT TERM
say "Installed iTerm Pane Manager $version"
say "  pane:     $bin_dir/pane"
say "  runtime:  $stage"
if ! command -v pane >/dev/null 2>&1; then
  say "Add $bin_dir to PATH before opening a new shell."
fi
