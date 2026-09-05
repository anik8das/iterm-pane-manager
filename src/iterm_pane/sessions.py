#!/usr/bin/env python3
"""Query and close iTerm2 sessions by stable session ID."""

import argparse
import json
import sys

import iterm2


async def session_tty(session):
    """The terminal device this session is running, or None for a browser pane.

    Ownership of a tab is decided against this value, so an unreadable
    variable has to read as "unknown" rather than raise: the caller is then
    refused, which is the safe direction.
    """
    try:
        return await session.async_get_variable("tty")
    except Exception:
        return None


def walk(app):
    """Yield every session, including panes hidden by zoom."""
    for window in app.windows:
        for tab in window.tabs:
            for session in tab.all_sessions:
                yield window, tab, session


async def main(connection, args):
    app = await iterm2.async_get_app(connection)
    await app.async_refresh()

    if args.command == "list":
        for _window, _tab, session in walk(app):
            print(session.session_id)
        return 0

    if args.command == "snapshot":
        current_window = app.current_window
        current_tab = current_window.current_tab if current_window else None
        current_session = current_tab.current_session if current_tab else None
        sessions = {}
        for window in app.windows:
            for tab in window.tabs:
                selected = tab.current_session
                for session in tab.all_sessions:
                    sessions[session.session_id] = {
                        "window_id": window.window_id,
                        "tab_id": tab.tab_id,
                        "selected_session": selected.session_id if selected else None,
                    }
        print(
            json.dumps(
                {
                    "app_active": bool(app.app_active),
                    "current_window": current_window.window_id
                    if current_window
                    else None,
                    "current_tab": current_tab.tab_id if current_tab else None,
                    "global_session": current_session.session_id
                    if current_session
                    else None,
                    "sessions": sessions,
                }
            )
        )
        return 0

    if args.command == "close":
        targets = set(args.session)
        for _window, _tab, session in walk(app):
            if session.session_id in targets:
                await session.async_close(force=True)
        return 0

    if args.command == "recover":
        before = set(args.before)
        anchor_tab = next(
            (
                tab
                for _window, tab, session in walk(app)
                if session.session_id == args.anchor
            ),
            None,
        )
        for _window, tab, session in walk(app):
            if session.session_id in before:
                continue
            if anchor_tab is not None and tab.tab_id != anchor_tab.tab_id:
                continue
            profile = await session.async_get_profile()
            if profile.name == args.profile:
                print(session.session_id)
        return 0

    matches = [
        (window, tab, session)
        for window, tab, session in walk(app)
        if session.session_id == args.session
    ]
    if not matches:
        if args.command == "status":
            # A session that is gone is an answer rather than a failure. The
            # caller is asking whether it may address this tab, and "there is
            # no such tab" is exactly what it needs to hear.
            print(json.dumps({"exists": False, "tty": None}))
            return 0
        print(f"sessions: no session {args.session}", file=sys.stderr)
        return 4
    window, tab, session = matches[0]

    if args.command == "activate":
        await session.async_activate(select_tab=False, order_window_front=False)
        return 0

    if args.command == "status":
        current_window = app.current_window
        current_tab = current_window.current_tab if current_window else None
        current_session = current_tab.current_session if current_tab else None
        selected = tab.current_session
        active = bool(
            app.app_active
            and current_window
            and current_window.window_id == window.window_id
            and current_tab
            and current_tab.tab_id == tab.tab_id
        )
        print(
            json.dumps(
                {
                    "exists": True,
                    "tty": await session_tty(session),
                    "app_active": bool(app.app_active),
                    "active": active,
                    "window_id": window.window_id,
                    "tab_id": tab.tab_id,
                    "selected_session": selected.session_id if selected else None,
                    "global_session": current_session.session_id
                    if current_session
                    else None,
                }
            )
        )
        return 0

    print(f"{window.window_id}\t{tab.tab_id}")
    return 0


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="inspect iTerm2 sessions")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list")
    commands.add_parser("snapshot")
    for name in ("where", "status", "activate"):
        subcommand = commands.add_parser(name)
        subcommand.add_argument("--session", required=True)
    close = commands.add_parser("close")
    close.add_argument("--session", required=True, action="append")
    recover = commands.add_parser("recover")
    recover.add_argument("--anchor", required=True)
    recover.add_argument("--profile", required=True)
    recover.add_argument("--before", action="append", default=[])
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
            "sessions: cannot reach iTerm2's API. Enable Settings > General > "
            "Magic > Python API.",
            file=sys.stderr,
        )
        sys.exit(3)
    sys.exit(exit_code)
