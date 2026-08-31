import argparse
import inspect
import unittest
from unittest import mock

import watch


class Session:
    def __init__(self, session_id):
        self.session_id = session_id
        self.activations = []

    async def async_activate(self, select_tab=True, order_window_front=True):
        self.activations.append((select_tab, order_window_front))


class Tab:
    def __init__(self, tab_id, sessions):
        self.tab_id = tab_id
        self.sessions = sessions
        self.all_sessions = sessions
        self.current_session = sessions[0]


class Window:
    def __init__(self, window_id, tabs, current=0):
        self.window_id = window_id
        self.tabs = tabs
        self.current_tab = tabs[current]


class App:
    def __init__(self, windows, current=0, active=True):
        self.windows = windows
        self.current_window = windows[current]
        self.app_active = active

    async def async_refresh(self):
        return None

    def get_session_by_id(self, session_id):
        for window in self.windows:
            for tab in window.tabs:
                for session in tab.sessions:
                    if session.session_id == session_id:
                        return session
        return None


def options():
    return argparse.Namespace(
        interval=5.0,
        debounce=250.0,
        tolerance=12.0,
        verbose=False,
    )


class FocusSafeWatcherTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.visible_sessions = [Session("visible-a"), Session("visible-b")]
        self.hidden_sessions = [Session("hidden-a"), Session("hidden-b")]
        self.visible = Tab("visible", self.visible_sessions)
        self.hidden = Tab("hidden", self.hidden_sessions)
        self.window = Window("window", [self.visible, self.hidden])
        self.app = App([self.window])
        self.watcher = watch.Watcher(self.app, options())

    def layout_patches(self, even_side_effect=None, needs="uneven by 100pt"):
        async def even(tab):
            if even_side_effect:
                even_side_effect(tab)
            return True

        return mock.patch.multiple(
            watch.layout,
            content_size=mock.Mock(return_value=(1000, 700)),
            skip_reason=mock.Mock(return_value=None),
            needs_evening=mock.Mock(return_value=needs),
            session_ids=mock.Mock(
                side_effect=lambda tab: frozenset(
                    session.session_id for session in tab.sessions
                )
            ),
            signature=mock.Mock(
                side_effect=lambda tab: tuple(
                    (index * 500, 0, 500, 700)
                    for index, _session in enumerate(tab.sessions)
                )
            ),
            frames=mock.Mock(return_value=[(0, 0, 500, 700), (500, 0, 500, 700)]),
            even_tab=mock.AsyncMock(side_effect=even),
        )

    async def test_focus_sweep_evens_only_visible_tab(self):
        with self.layout_patches():
            await self.watcher.sweep("focus")
            watch.layout.even_tab.assert_awaited_once_with(self.visible)

    async def test_equal_selected_tab_is_read_only(self):
        with self.layout_patches(needs=None):
            await self.watcher.sweep("focus")
            watch.layout.even_tab.assert_not_awaited()

    async def test_inactive_app_never_mutates_layout(self):
        self.app.app_active = False
        with self.layout_patches():
            await self.watcher.sweep("event")
            watch.layout.even_tab.assert_not_awaited()

    async def test_pane_count_change_is_evened_once(self):
        with self.layout_patches(needs=None):
            self.watcher.remember(self.visible)
            self.visible.sessions.append(Session("visible-c"))
            self.visible.all_sessions = self.visible.sessions
            await self.watcher.sweep("event")
            watch.layout.even_tab.assert_awaited_once_with(self.visible)

    async def test_evening_restores_pane_without_selecting_tab(self):
        def select_sibling(tab):
            tab.current_session = tab.sessions[1]

        with self.layout_patches(even_side_effect=select_sibling):
            await self.watcher.sweep("focus")
        self.assertEqual(self.visible_sessions[0].activations, [(False, False)])

    def test_watcher_cannot_manage_documents(self):
        source = inspect.getsource(watch)
        for forbidden in (
            "open_document",
            "staged_session",
            "async_move_session",
            "async_create_tab",
            "async_close",
            "retry=True",
        ):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()
