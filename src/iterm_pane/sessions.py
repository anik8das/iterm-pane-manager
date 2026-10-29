#!/usr/bin/env python3
"""Query and close iTerm2 sessions by stable session ID."""

import argparse
import asyncio
import json
import sys

import iterm2
import layout
from document import locate


async def session_tty(session):
    """The terminal device this session is running, or None for a browser pane.

    Ownership of a tab is decided against this value, so an unreadable
    variable has to read as "unknown" rather than raise: the caller is then
    refused, which is the safe direction.
    """
    try:
        tty = await session.async_get_variable("tty")
        if tty:
            return tty
        # Restored sessions can retain their process while losing the tty
        # variable. Resolve the native session's process, never a guessed tab.
        pid = await session.async_get_variable("pid")
        if not isinstance(pid, int) or pid < 1:
            return None
        process = await asyncio.create_subprocess_exec(
            "ps",
            "-p",
            str(pid),
            "-o",
            "tty=",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            output, _stderr = await asyncio.wait_for(process.communicate(), 3)
        except asyncio.TimeoutError:
            process.kill()
            await process.communicate()
            return None
        device = output.decode().strip()
        if process.returncode != 0 or device in ("", "??", "-"):
            return None
        return f"/dev/{device.removeprefix('/dev/')}"
    except Exception:
        return None


def walk(app):
    """Yield every session, including panes hidden by zoom."""
    for window in app.windows:
        for tab in window.tabs:
            for session in tab.all_sessions:
                yield window, tab, session


async def retire_documents(app, anchor_id, replacement_id, previous_id, documents):
    """Close verified superseded browsers after their replacement is tracked."""
    closed, kept = [], []
    for session_id, expected_profile in documents.items():
        await app.async_refresh()
        _window, tab, anchor = locate(app, anchor_id)
        _old_window, old_tab, old = locate(app, session_id)
        _new_window, new_tab, replacement = locate(app, replacement_id)
        if old is None:
            closed.append(session_id)
            continue
        if (
            anchor is None
            or replacement is None
            or old_tab is not tab
            or new_tab is not tab
            or session_id in (anchor_id, replacement_id)
        ):
            kept.append(f"{session_id}: pane moved or replacement is absent")
            continue
        profile = await old.async_get_profile()
        if (
            profile.name != expected_profile
            or profile.all_properties.get("Custom Command") != "Browser"
        ):
            kept.append(f"{session_id}: browser ownership changed")
            continue
        # Profile retrieval yields to the user and layout notifications.
        await app.async_refresh()
        _window, fresh_tab, fresh = locate(app, session_id)
        _anchor_window, anchor_tab, anchor = locate(app, anchor_id)
        _new_window, new_tab, replacement = locate(app, replacement_id)
        if fresh is None:
            closed.append(session_id)
            continue
        if fresh_tab is not tab or anchor_tab is not tab or new_tab is not tab:
            kept.append(f"{session_id}: pane or replacement moved")
            continue
        if tab.current_session and tab.current_session.session_id == session_id:
            if session_id != previous_id:
                kept.append(f"{session_id}: document is being read")
                continue
            await replacement.async_activate(select_tab=False, order_window_front=False)
        await fresh.async_close(force=True)
        closed.append(session_id)
    return {"closed": closed, "kept": kept}


async def main(connection, args):
    app = await iterm2.async_get_app(connection)
    await app.async_refresh()

    if args.command == "retire":
        print(
            json.dumps(
                await retire_documents(
                    app,
                    args.anchor,
                    args.replacement,
                    args.previous,
                    json.loads(args.documents),
                )
            )
        )
        return 0

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
                tab_width = layout.extent(tab)[0]
                columns = layout.column_count(tab.root)
                for session in tab.all_sessions:
                    sessions[session.session_id] = {
                        "window_id": window.window_id,
                        "tab_id": tab.tab_id,
                        "selected_session": selected.session_id if selected else None,
                        "tab_width": tab_width,
                        "columns": columns,
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
                    "minimum_browser_width": layout.MIN_BROWSER_WIDTH,
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

    if args.command == "resolve":
        expected = args.tty.removeprefix("/dev/")
        matches = [
            (window, tab, session)
            for window, tab, session in walk(app)
            if (await session_tty(session) or "").removeprefix("/dev/") == expected
        ]
        if len(matches) != 1:
            print(json.dumps({"exists": False, "ambiguous": len(matches) > 1}))
            return 0
    else:
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

    if args.command in ("status", "resolve"):
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
                    "session": session.session_id,
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
    resolve = commands.add_parser("resolve")
    resolve.add_argument("--tty", required=True)
    retire = commands.add_parser("retire")
    retire.add_argument("--anchor", required=True)
    retire.add_argument("--replacement", required=True)
    retire.add_argument("--previous")
    retire.add_argument("--documents", required=True)
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
