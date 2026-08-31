#!/usr/bin/env python3
"""Keep the selected active iTerm2 tab evenly split."""

import argparse
import asyncio
import os
import sys
import time

import iterm2
import layout

STATE_DIR = os.path.expanduser("~/.local/state/iterm-pane")
PAUSE_FILE = os.path.join(STATE_DIR, "watch-paused")
RPC_TIMEOUT = 15.0
BURST_LIMIT = 12
BURST_WINDOW = 20.0
BACKOFF = 60.0


def log(message):
    print("{}  {}".format(time.strftime("%H:%M:%S"), message), flush=True)


def paused():
    return os.path.exists(PAUSE_FILE)


class Watcher:
    """Measure changes and resize only the selected tab when necessary."""

    def __init__(self, app, options):
        self.app = app
        self.options = options
        self.seen = {}
        self.changes = []
        self.backoff_until = 0.0
        self.was_paused = False
        self.focus_pending = False

    def reason_for(self, tab, content):
        previous = self.seen.get(tab.tab_id)
        session_ids = layout.session_ids(tab)
        reason = layout.needs_evening(tab, content, self.options.tolerance)
        if previous is None:
            return (reason, True) if reason is not None else None
        if previous["sessions"] != session_ids:
            return "panes changed", False
        if reason is None:
            return None
        if previous["settled"] and previous["signature"] == layout.signature(tab):
            return None
        return reason, True

    def remember(self, tab, settled=False):
        self.seen[tab.tab_id] = {
            "sessions": layout.session_ids(tab),
            "signature": layout.signature(tab),
            "settled": settled,
        }

    def active_tab(self):
        if self.app.app_active is not True:
            return None
        window = self.app.current_window
        if window is None or window.current_tab is None:
            return None
        return window, window.current_tab

    async def sweep(self, reason):
        await asyncio.wait_for(self.app.async_refresh(), timeout=RPC_TIMEOUT)

        if paused():
            if not self.was_paused:
                log(f"paused ({PAUSE_FILE} exists)")
                self.was_paused = True
            for window in self.app.windows:
                for tab in window.tabs:
                    self.remember(tab)
            return
        if self.was_paused:
            log("resumed")
            self.was_paused = False

        active = self.active_tab()
        if active is None:
            return

        now = time.time()
        if now < self.backoff_until:
            return
        self.changes = [
            timestamp for timestamp in self.changes if now - timestamp < BURST_WINDOW
        ]
        if len(self.changes) >= BURST_LIMIT:
            log(f"repeated layout changes detected; backing off for {BACKOFF:.0f}s")
            self.backoff_until = now + BACKOFF
            self.changes = []
            return

        live_tabs = {tab.tab_id for window in self.app.windows for tab in window.tabs}
        window, tab = active
        if layout.skip_reason(tab):
            self.seen.pop(tab.tab_id, None)
            return

        verdict = self.reason_for(tab, layout.content_size(window))
        if verdict:
            work = [
                (
                    tab,
                    verdict[0],
                    verdict[1],
                    layout.signature(tab),
                    layout.session_ids(tab),
                )
            ]
        else:
            work = []
            settled = self.seen.get(tab.tab_id, {}).get("settled", False)
            self.remember(tab, settled=settled)

        for tab_id in list(self.seen):
            if tab_id not in live_tabs:
                del self.seen[tab_id]

        if not work:
            if self.options.verbose:
                log(f"{reason}: nothing to do")
            return

        focused_session = (
            tab.current_session.session_id if tab.current_session else None
        )
        for candidate, _why, _wrong, _before, session_ids in work:
            if layout.session_ids(candidate) != session_ids:
                continue
            await asyncio.wait_for(layout.even_tab(candidate), timeout=RPC_TIMEOUT)

        await asyncio.wait_for(self.app.async_refresh(), timeout=RPC_TIMEOUT)
        tabs_by_id = {
            current.tab_id: current
            for current_window in self.app.windows
            for current in current_window.tabs
        }

        current = self.active_tab()
        if focused_session and current and current[1].tab_id == tab.tab_id:
            selected = current[1].current_session
            if selected and selected.session_id != focused_session:
                original = self.app.get_session_by_id(focused_session)
                if original:
                    await original.async_activate(
                        select_tab=False, order_window_front=False
                    )

        moved = False
        for candidate, why, wrong, before, _session_ids in work:
            fresh = tabs_by_id.get(candidate.tab_id)
            if fresh is None:
                self.seen.pop(candidate.tab_id, None)
                continue
            after = layout.signature(fresh)
            stuck = after == before
            self.remember(fresh, settled=stuck)
            moved = moved or not stuck
            widths = "x".join(
                str(width)
                for width in sorted({round(frame[2]) for frame in layout.frames(fresh)})
            )
            if not stuck:
                log(f"{reason}: tab {fresh.tab_id} {why} -> {widths}pt")
            elif wrong:
                log(
                    f"{reason}: tab {fresh.tab_id} {why} and would not even "
                    f"({widths}pt); leaving it alone"
                )
        if moved:
            self.changes.append(now)

    async def run(self, wake):
        while True:
            reason = "poll"
            try:
                await asyncio.wait_for(wake.wait(), timeout=self.options.interval)
                reason = "focus" if self.focus_pending else "event"
                if reason != "focus":
                    while True:
                        wake.clear()
                        try:
                            await asyncio.wait_for(
                                wake.wait(),
                                timeout=self.options.debounce / 1000.0,
                            )
                        except asyncio.TimeoutError:
                            break
            except asyncio.TimeoutError:
                pass
            wake.clear()
            if self.focus_pending:
                reason = "focus"
            self.focus_pending = False
            await self.sweep(reason)


async def layout_events(connection, wake):
    async with iterm2.LayoutChangeMonitor(connection) as monitor:
        while True:
            await monitor.async_get()
            wake.set()


async def focus_events(connection, wake, watcher):
    async with iterm2.FocusMonitor(connection) as monitor:
        while True:
            update = await monitor.async_get_next_update()
            became_active = bool(
                update.application_active
                and update.application_active.application_active
            )
            if update.selected_tab_changed or update.window_changed or became_active:
                watcher.focus_pending = True
                wake.set()


async def main(connection, options):
    app = await iterm2.async_get_app(connection)
    watcher = Watcher(app, options)
    await watcher.sweep("startup")
    if options.once:
        return
    log(
        f"watching (events + {options.interval:.0f}s poll, "
        f"{options.debounce:.0f}ms debounce, "
        f"{options.tolerance:.0f}pt tolerance)"
    )
    wake = asyncio.Event()
    await asyncio.gather(
        layout_events(connection, wake),
        focus_events(connection, wake, watcher),
        watcher.run(wake),
    )


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="keep iTerm2 tabs evenly split")
    parser.add_argument("--interval", type=float, default=5.0)
    parser.add_argument("--debounce", type=float, default=250.0)
    parser.add_argument("--tolerance", type=float, default=layout.TOLERANCE)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    return parser.parse_args(argv)


if __name__ == "__main__":
    options = parse_args()
    if options.tolerance < 1:
        print("watch: tolerance must be at least 1pt", file=sys.stderr)
        sys.exit(2)

    async def run(connection):
        await main(connection, options)

    if options.once:
        try:
            iterm2.run_until_complete(run)
        except SystemExit:
            raise
        except Exception:
            print(
                "watch: cannot reach iTerm2's API. Enable Settings > General > "
                "Magic > Python API.",
                file=sys.stderr,
            )
            sys.exit(3)
        sys.exit(0)

    try:
        iterm2.run_until_complete(run)
        log("iTerm2 closed the connection")
    except KeyboardInterrupt:
        sys.exit(0)
    except SystemExit as error:
        if error.code == 0:
            sys.exit(0)
        log(f"disconnected (exit {error.code})")
        sys.exit(3)
    except Exception as error:
        log(f"disconnected: {error!r}")
        sys.exit(3)
