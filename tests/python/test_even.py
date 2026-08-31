import argparse
import unittest
from unittest import mock

import even


class Session:
    def __init__(self, session_id):
        self.session_id = session_id
        self.tab = None
        self.activations = []

    async def async_activate(self, select_tab=True, order_window_front=True):
        self.activations.append((select_tab, order_window_front))
        self.tab.current_session = self


class Tab:
    def __init__(self, tab_id, sessions):
        self.tab_id = tab_id
        self.sessions = sessions
        self.current_session = sessions[0]
        for session in sessions:
            session.tab = self


class Window:
    def __init__(self, window_id, tabs):
        self.window_id = window_id
        self.tabs = tabs
        self.current_tab = tabs[0]


class App:
    def __init__(self, window):
        self.windows = [window]
        self.current_window = window
        self.app_active = True

    async def async_refresh(self):
        return None

    def get_session_by_id(self, session_id):
        for window in self.windows:
            for tab in window.tabs:
                for session in tab.sessions:
                    if session.session_id == session_id:
                        return session
        return None


def options(session_id):
    return argparse.Namespace(session=session_id, all=False, quiet=True)


class EvenFocusTest(unittest.IsolatedAsyncioTestCase):
    async def test_restores_pane_without_selecting_tab(self):
        first = Session("first")
        second = Session("second")
        tab = Tab("tab", [first, second])
        window = Window("window", [tab])
        app = App(window)

        async def resize(candidate):
            candidate.current_session = second

        with (
            mock.patch.object(even.iterm2, "async_get_app", return_value=app),
            mock.patch.object(even.layout, "spread", return_value=(400, 600)),
            mock.patch.object(even.layout, "skip_reason", return_value=None),
            mock.patch.object(even.layout, "even_tab", side_effect=resize),
        ):
            result = await even.main(object(), options(first.session_id))

        self.assertEqual(result, 0)
        self.assertEqual(first.activations, [(False, False)])
        self.assertIs(tab.current_session, first)

    async def test_does_not_override_tab_change_during_layout(self):
        first = Session("first")
        other = Session("other")
        first_tab = Tab("first-tab", [first, Session("sibling")])
        other_tab = Tab("other-tab", [other])
        window = Window("window", [first_tab, other_tab])
        app = App(window)

        async def resize(_candidate):
            window.current_tab = other_tab

        with (
            mock.patch.object(even.iterm2, "async_get_app", return_value=app),
            mock.patch.object(even.layout, "spread", return_value=(400, 600)),
            mock.patch.object(even.layout, "skip_reason", return_value=None),
            mock.patch.object(even.layout, "even_tab", side_effect=resize),
        ):
            result = await even.main(object(), options(first.session_id))

        self.assertEqual(result, 5)
        self.assertIs(window.current_tab, other_tab)
        self.assertEqual(first.activations, [])


if __name__ == "__main__":
    unittest.main()
