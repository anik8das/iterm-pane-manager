import contextlib
import io
import json
import unittest
from unittest import mock

import sessions


class Session:
    def __init__(self, session_id, tty="/dev/ttys012"):
        self.session_id = session_id
        self.tty = tty
        self.raises = False

    async def async_get_variable(self, name):
        if self.raises:
            raise RuntimeError("variable unavailable")
        return self.tty if name == "tty" else None


class Tab:
    def __init__(self, tab_id, sessions_):
        self.tab_id = tab_id
        self.all_sessions = sessions_
        self.current_session = sessions_[0]


class Window:
    def __init__(self, window_id, tabs):
        self.window_id = window_id
        self.tabs = tabs
        self.current_tab = tabs[0]


class App:
    def __init__(self, windows):
        self.windows = windows
        self.current_window = windows[0]
        self.app_active = True

    async def async_refresh(self):
        return None


class Args:
    def __init__(self, command, session):
        self.command = command
        self.session = session


class SessionsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.session = Session("code-pane")
        self.app = App([Window("window", [Tab("tab", [self.session])])])
        self.get_app = mock.patch.object(
            sessions.iterm2,
            "async_get_app",
            new=mock.AsyncMock(return_value=self.app),
        )
        self.get_app.start()

    def tearDown(self):
        self.get_app.stop()

    async def status(self, session_id):
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = await sessions.main(object(), Args("status", session_id))
        return code, json.loads(buffer.getvalue())

    async def test_status_reports_the_terminal_the_tab_is_running(self):
        """Ownership of a tab is decided against this value."""
        code, payload = await self.status("code-pane")
        self.assertEqual(code, 0)
        self.assertTrue(payload["exists"])
        self.assertEqual(payload["tty"], "/dev/ttys012")

    async def test_a_session_that_is_gone_answers_rather_than_fails(self):
        """The caller is asking whether it may address a tab, so say no."""
        code, payload = await self.status("no-such-pane")
        self.assertEqual(code, 0)
        self.assertFalse(payload["exists"])
        self.assertIsNone(payload["tty"])

    async def test_a_pane_with_no_terminal_reports_none(self):
        """A browser pane has no terminal, so nothing may claim to be in it."""
        self.session.tty = None
        _code, payload = await self.status("code-pane")
        self.assertIsNone(payload["tty"])

    async def test_an_unreadable_terminal_reads_as_unknown(self):
        """Unknown has to refuse the caller, never crash the command."""
        self.session.raises = True
        _code, payload = await self.status("code-pane")
        self.assertIsNone(payload["tty"])


if __name__ == "__main__":
    unittest.main()
