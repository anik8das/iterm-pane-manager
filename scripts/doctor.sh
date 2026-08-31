#!/bin/sh
set -eu

install_root=${ITERM_PANE_INSTALL_ROOT:-"$HOME/.local/share/iterm-pane-manager"}
pane_command="$install_root/current/bin/pane.mjs"

if [ ! -x "$pane_command" ]; then
  printf 'doctor: no installation found at %s\n' "$install_root" >&2
  exit 1
fi

exec "$pane_command" --doctor
