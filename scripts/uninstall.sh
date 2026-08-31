#!/bin/sh
set -eu

install_root=${ITERM_PANE_INSTALL_ROOT:-"$HOME/.local/share/iterm-pane-manager"}
label=io.github.anik8das.iterm-pane-manager
domain="gui/$(id -u)"

remove_managed_link() {
  link=$1
  if [ ! -L "$link" ]; then
    return
  fi
  target=$(readlink "$link")
  case "$target" in
    "$install_root"/*) rm -f -- "$link" ;;
  esac
}

launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
plist="$HOME/Library/LaunchAgents/$label.plist"
[ ! -f "$plist" ] || rm -f -- "$plist"

remove_managed_link /usr/local/bin/pane
remove_managed_link /usr/local/bin/mdrender
remove_managed_link "$HOME/.local/bin/pane"
remove_managed_link "$HOME/.local/bin/mdrender"

case "$install_root" in
  "$HOME/.local/share/iterm-pane-manager") rm -rf -- "$install_root" ;;
  *)
    printf 'uninstall: runtime preserved at custom path %s\n' "$install_root"
    printf 'Remove it manually if it is no longer needed.\n'
    ;;
esac

printf 'Uninstalled iTerm Pane Manager. User documents and state were preserved.\n'
