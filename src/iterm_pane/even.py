#!/usr/bin/env python3
"""Even one iTerm2 tab, or every tab, without selecting anything."""

import argparse
import os
import sys

import iterm2
import layout


def global_identity(app):
    """Return the globally selected app, window, tab, and session."""
    window = app.current_window
    tab = window.current_tab if window else None
    session = tab.current_session if tab else None
    return (
        bool(app.app_active),
        window.window_id if window else None,
        tab.tab_id if tab else None,
        session.session_id if session else None,
    )


async def main(connection, args):
    app = await iterm2.async_get_app(connection)
    focus_before = global_identity(app)
    if args.all:
        tabs = [tab for window in app.windows for tab in window.tabs]
    else:
        session_id = (
            args.session or os.environ.get("ITERM_SESSION_ID", "").split(":")[-1]
        )
        session = app.get_session_by_id(session_id) if session_id else None
        if session is None:
            print(
                "even: no session %s" % (session_id or "(none given)"), file=sys.stderr
            )
            return 4
        tabs = [session.tab]

    before = {tab.tab_id: layout.spread(tab) for tab in tabs if len(tab.sessions) > 1}
    selected = {
        tab.tab_id: tab.current_session.session_id if tab.current_session else None
        for tab in tabs
    }
    skipped = {}
    for tab in tabs:
        reason = layout.skip_reason(tab)
        if reason and reason != "single pane":
            skipped[tab.tab_id] = reason
            before.pop(tab.tab_id, None)
            continue
        await layout.even_tab(tab)

    await app.async_refresh()
    if global_identity(app)[:3] != focus_before[:3]:
        print("even: global tab or window changed during layout", file=sys.stderr)
        return 5

    fresh_tabs = {tab.tab_id: tab for window in app.windows for tab in window.tabs}
    restored = False
    for tab_id, session_id in selected.items():
        tab = fresh_tabs.get(tab_id)
        current_id = (
            tab.current_session.session_id if tab and tab.current_session else None
        )
        if session_id and current_id != session_id:
            session = app.get_session_by_id(session_id)
            if session:
                await session.async_activate(select_tab=False, order_window_front=False)
                restored = True
    if restored:
        await app.async_refresh()
    if global_identity(app) != focus_before:
        print("even: pane selection changed during layout", file=sys.stderr)
        return 5

    if args.quiet:
        return 0

    for tab in [tab for window in app.windows for tab in window.tabs]:
        if tab.tab_id in skipped:
            print(f"{tab.tab_id}: skipped, {skipped[tab.tab_id]}")
            continue
        previous = before.get(tab.tab_id)
        if previous:
            current = layout.spread(tab)
            print(
                f"{tab.tab_id}: {previous[0]:.0f}-{previous[1]:.0f}pt -> "
                f"{current[0]:.0f}-{current[1]:.0f}pt"
            )
    return 0


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="even iTerm2 split panes")
    parser.add_argument("--session", help="session ID; defaults to ITERM_SESSION_ID")
    parser.add_argument("--all", action="store_true", help="every tab in every window")
    parser.add_argument("--quiet", action="store_true")
    return parser.parse_args(argv)


if __name__ == "__main__":
    options = parse_args()
    exit_code = 0

    async def run(connection):
        global exit_code
        exit_code = await main(connection, options)

    try:
        iterm2.run_until_complete(run)
    except SystemExit:
        raise
    except Exception:
        print(
            "even: cannot reach iTerm2's API. Enable Settings > General > Magic > "
            "Python API.",
            file=sys.stderr,
        )
        sys.exit(3)
    sys.exit(exit_code)
