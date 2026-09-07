#!/usr/bin/env python3
"""Open a browser document beside an exact iTerm2 anchor session."""

import argparse
import contextlib
import json
import os
import sys
import time

import iterm2


class DocumentError(Exception):
    """A document could not be opened without violating the focus contract."""


def identity(app):
    """Return the globally selected iTerm2 window, tab, and session."""
    window = app.current_window
    tab = window.current_tab if window else None
    session = tab.current_session if tab else None
    return {
        "app_active": bool(app.app_active),
        "window_id": window.window_id if window else None,
        "tab_id": tab.tab_id if tab else None,
        "session_id": session.session_id if session else None,
    }


def locate(app, session_id):
    """Find a session and its parents by stable ID."""
    for window in app.windows:
        for tab in window.tabs:
            for session in tab.all_sessions:
                if session.session_id == session_id:
                    return window, tab, session
    return None, None, None


def selected_in_tab(app, anchor_id):
    """The pane currently selected inside the anchor's tab, or ``None``."""
    _window, tab, _session = locate(app, anchor_id)
    if tab is None or tab.current_session is None:
        return None
    return tab.current_session.session_id


def browser_profile(name, url):
    """Build a browser profile small enough to split a crowded tab."""
    return iterm2.LocalWriteOnlyProfile(
        {
            "Name": name,
            "Custom Command": "Browser",
            "Profile Type": "browser",
            "Initial URL": url,
            "Columns": 1,
            "Rows": 1,
        }
    )


async def restore_target_selection(app, session_id):
    """Select a pane inside its tab without selecting that tab or window."""
    session = app.get_session_by_id(session_id) if session_id else None
    if session is not None:
        await session.async_activate(select_tab=False, order_window_front=False)


async def close_created(created):
    """Roll back a new pane without changing the user's global selection."""
    if created is not None:
        await created.async_close(force=True)


def record_created(receipt_path, session_id):
    """Publish a new pane ID so the caller can clean up after termination."""
    if receipt_path is None:
        return
    temporary = f"{receipt_path}.{os.getpid()}.tmp"
    try:
        with open(temporary, "w", encoding="utf-8") as receipt:
            receipt.write(session_id)
        os.replace(temporary, receipt_path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)


async def open_document(
    app, anchor_id, url, profile_name, existing_id=None, receipt_path=None
):
    """Open or replace one document while preserving location and focus."""
    started = time.monotonic()
    before = identity(app)
    target_window, target_tab, anchor = locate(app, anchor_id)
    if anchor is None:
        raise DocumentError(f"anchor session does not exist: {anchor_id}")
    selected = target_tab.current_session
    selected_id = selected.session_id if selected else anchor_id

    existing_closed = False
    if existing_id:
        existing_window, existing_tab, existing = locate(app, existing_id)
        if existing is None:
            raise DocumentError(
                f"tracked browser session does not exist: {existing_id}"
            )
        if (
            existing_window.window_id != target_window.window_id
            or existing_tab.tab_id != target_tab.tab_id
        ):
            raise DocumentError("tracked browser is not in the anchor's tab")
        if iterm2.capabilities.supports_load_url(app.connection):
            await existing.async_load_url(url)
            await app.async_refresh()
            # Undo only what loading the page did. Anything else selected in
            # that tab was chosen by the person while the load was in flight.
            if selected_in_tab(app, anchor_id) == existing.session_id:
                await restore_target_selection(app, selected_id)
            await app.async_refresh()
            after_reload = identity(app)
            if (
                after_reload["session_id"] == existing.session_id
                and before["session_id"] != existing.session_id
            ):
                raise DocumentError("reloading the browser changed global focus")
            return {
                "session": existing.session_id,
                "elapsed": round(time.monotonic() - started, 3),
                "focus_unchanged": after_reload == before,
                "target_tab": target_tab.tab_id,
                "reloaded": True,
            }

        # Older protocol versions cannot navigate an existing browser. Closing
        # first frees its exact split-tree slot in crowded tabs.
        await existing.async_close(force=True)
        existing_closed = True
        await app.async_refresh()
        target_window, target_tab, anchor = locate(app, anchor_id)
        if anchor is None:
            raise DocumentError("anchor closed while replacing the browser")

    created = None
    try:
        created = await anchor.async_split_pane(
            vertical=True,
            before=False,
            profile_customizations=browser_profile(profile_name, url),
        )
        record_created(receipt_path, created.session_id)

        # A tab/window switch during the call belongs to the user. Do not
        # counteract it. The location/focus checks below will reject the open.
        # Read the selection back from iTerm2 rather than trusting the copy
        # held from before the split: whether the person moved is the whole
        # question here, and a stale answer moves a pane under someone who is
        # now looking at it.
        await app.async_refresh()
        replacing_selected = existing_closed and selected_id == existing_id
        restore_id = (
            created.session_id
            if replacing_selected and before["tab_id"] == target_tab.tab_id
            else anchor_id
            if replacing_selected
            else selected_id
        )
        # Undo only our own side effect. Splitting selects the new pane inside
        # the target tab, and putting the previous one back is the whole point.
        # Anything else selected there was chosen by the person while the split
        # was in flight, and is not ours to change: comparing the window and
        # tab is not enough, because moving between panes of the tab we are
        # splitting leaves both of those the same.
        if selected_in_tab(app, anchor_id) == created.session_id:
            await restore_target_selection(app, restore_id)

        if before["tab_id"] == target_tab.tab_id:
            await app.async_refresh()

        created_window, created_tab, fresh_created = locate(app, created.session_id)
        if (
            fresh_created is None
            or created_window.window_id != target_window.window_id
            or created_tab.tab_id != target_tab.tab_id
        ):
            raise DocumentError("browser pane did not land in the anchor's tab")

        after = identity(app)
        expected = dict(before)
        if replacing_selected and before["tab_id"] == target_tab.tab_id:
            expected["session_id"] = created.session_id
        # Two ways this can move someone: onto the page itself, or onto the
        # tab being split. Landing on the tab we just split, from somewhere
        # else, cannot be told apart from them walking into it at that exact
        # moment, so it resolves the careful way and the pane goes back.
        # Everything else is them moving somewhere of their own choosing: the
        # pane sits in the tab that asked for it, unselected, and stays.
        landed_on_document = (
            after["session_id"] == created.session_id
            and expected["session_id"] != created.session_id
        )
        pulled_to_the_split = (
            after["tab_id"] == target_tab.tab_id
            and before["tab_id"] != target_tab.tab_id
        )
        if landed_on_document or pulled_to_the_split:
            raise DocumentError("browser split changed global focus")

        return {
            "session": created.session_id,
            "elapsed": round(time.monotonic() - started, 3),
            "focus_unchanged": after == expected,
            "target_tab": target_tab.tab_id,
            "reopened": existing_closed,
        }
    except Exception as error:
        try:
            await close_created(created)
        except Exception as rollback_error:
            raise DocumentError(
                f"{error}; pane cleanup also failed: {rollback_error}"
            ) from error
        raise


async def main(connection, args):
    app = await iterm2.async_get_app(connection)
    try:
        result = await open_document(
            app, args.anchor, args.url, args.profile, args.existing, args.receipt
        )
    except Exception as error:
        print(f"document: {error}", file=sys.stderr)
        return 4
    print(json.dumps(result))
    return 0


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="open a browser document in an exact iTerm2 tab"
    )
    parser.add_argument("--anchor", required=True)
    parser.add_argument("--url", required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--existing")
    parser.add_argument("--receipt")
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
            "document: cannot reach iTerm2's API. Enable Settings > General > "
            "Magic > Python API.",
            file=sys.stderr,
        )
        sys.exit(3)
    sys.exit(exit_code)
