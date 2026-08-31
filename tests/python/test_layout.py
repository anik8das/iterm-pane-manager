import unittest
from types import SimpleNamespace
from unittest import mock

import layout


def frame(x, y, width, height):
    return SimpleNamespace(
        origin=SimpleNamespace(x=x, y=y),
        size=SimpleNamespace(width=width, height=height),
    )


class Session:
    def __init__(self, session_id, pane_frame):
        self.session_id = session_id
        self.frame = pane_frame
        self.preferred_size = None


class Tab:
    def __init__(self, sessions, tmux="", minimized=None):
        self.sessions = sessions
        self.tmux_connection_id = tmux
        self.minimized_sessions = minimized or []
        self.updated = False

    async def async_update_layout(self):
        self.updated = True


class LayoutTest(unittest.IsolatedAsyncioTestCase):
    def test_detects_width_drift(self):
        tab = Tab(
            [Session("a", frame(0, 0, 400, 700)), Session("b", frame(400, 0, 600, 700))]
        )
        self.assertEqual(layout.needs_evening(tab, (1000, 700)), "uneven by 200pt")

    def test_detects_dead_space(self):
        tab = Tab(
            [Session("a", frame(0, 0, 400, 700)), Session("b", frame(400, 0, 400, 700))]
        )
        self.assertEqual(
            layout.needs_evening(tab, (1000, 700)),
            "800x700 in a 1000x700 tab",
        )

    def test_skips_zoom_and_tmux(self):
        sessions = [
            Session("a", frame(0, 0, 500, 700)),
            Session("b", frame(500, 0, 500, 700)),
        ]
        self.assertEqual(layout.skip_reason(Tab(sessions, tmux="tmux")), "tmux tab")
        self.assertEqual(
            layout.skip_reason(Tab(sessions, minimized=[sessions[1]])),
            "a pane is zoomed",
        )

    async def test_even_tab_sets_equal_preferences(self):
        sessions = [
            Session("a", frame(0, 0, 400, 700)),
            Session("b", frame(400, 0, 600, 700)),
        ]
        tab = Tab(sessions)
        with mock.patch.object(
            layout.iterm2, "Size", side_effect=lambda width, height: (width, height)
        ):
            await layout.even_tab(tab)
        self.assertEqual(
            [session.preferred_size for session in sessions],
            [(1000, 1000), (1000, 1000)],
        )
        self.assertTrue(tab.updated)


if __name__ == "__main__":
    unittest.main()
