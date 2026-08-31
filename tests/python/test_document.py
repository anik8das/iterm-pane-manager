import inspect
import unittest
from unittest import mock

import document


class Session:
    def __init__(self, session_id):
        self.session_id = session_id
        self.app = None
        self.tab = None
        self.split_created = None
        self.split_target = None
        self.change_global_tab = False
        self.activations = []
        self.closed = False
        self.loaded_urls = []

    async def async_split_pane(self, **_kwargs):
        created = self.split_created
        target = self.split_target or self.tab
        created.app = self.app
        created.tab = target
        target.sessions.append(created)
        target.all_sessions = target.sessions
        target.current_session = created
        if self.change_global_tab:
            self.app.current_window = target.window
            target.window.current_tab = target
        return created

    async def async_activate(self, select_tab=True, order_window_front=True):
        self.activations.append((select_tab, order_window_front))
        self.tab.current_session = self
        if select_tab:
            self.app.current_window = self.tab.window
            self.tab.window.current_tab = self.tab

    async def async_close(self, force=True):
        self.closed = True
        if self in self.tab.sessions:
            self.tab.sessions.remove(self)
            self.tab.all_sessions = self.tab.sessions
        if self.tab.current_session is self and self.tab.sessions:
            self.tab.current_session = self.tab.sessions[0]

    async def async_load_url(self, url):
        self.loaded_urls.append(url)


class Tab:
    def __init__(self, tab_id, sessions):
        self.tab_id = tab_id
        self.sessions = sessions
        self.all_sessions = sessions
        self.current_session = sessions[0]
        self.window = None


class Window:
    def __init__(self, window_id, tabs, current=0):
        self.window_id = window_id
        self.tabs = tabs
        self.current_tab = tabs[current]
        for tab in tabs:
            tab.window = self


class App:
    def __init__(self, windows, current=0):
        self.windows = windows
        self.current_window = windows[current]
        self.app_active = True
        self.connection = object()
        self.refresh_count = 0
        for window in windows:
            for tab in window.tabs:
                for session in tab.sessions:
                    session.app = self
                    session.tab = tab

    async def async_refresh(self):
        self.refresh_count += 1

    def get_session_by_id(self, session_id):
        for window in self.windows:
            for tab in window.tabs:
                for session in tab.sessions:
                    if session.session_id == session_id:
                        return session
        return None


class DocumentTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.visible_code = Session("visible-code")
        self.anchor = Session("hidden-code")
        self.visible = Tab("visible-tab", [self.visible_code])
        self.hidden = Tab("hidden-tab", [self.anchor])
        self.window = Window("window", [self.visible, self.hidden])
        self.app = App([self.window])
        self.created = Session("browser-new")
        self.anchor.split_created = self.created
        self.profile = mock.patch.object(
            document, "browser_profile", return_value=object()
        )
        self.profile.start()
        self.load_url = mock.patch.object(
            document.iterm2.capabilities,
            "supports_load_url",
            return_value=False,
        )
        self.load_url.start()

    def tearDown(self):
        self.profile.stop()
        self.load_url.stop()

    async def test_hidden_tab_open_preserves_global_and_target_focus(self):
        before = document.identity(self.app)
        result = await document.open_document(
            self.app, self.anchor.session_id, "file:///doc.html", "doc"
        )
        self.assertEqual(result["session"], self.created.session_id)
        self.assertEqual(result["target_tab"], self.hidden.tab_id)
        self.assertEqual(document.identity(self.app), before)
        self.assertEqual(self.hidden.current_session, self.anchor)
        self.assertEqual(self.anchor.activations, [(False, False)])

    async def test_replacement_reuses_existing_layout_slot(self):
        old = Session("browser-old")
        old.app = self.app
        old.tab = self.hidden
        self.hidden.sessions.append(old)
        result = await document.open_document(
            self.app,
            self.anchor.session_id,
            "file:///doc.html",
            "doc",
            old.session_id,
        )
        self.assertEqual(result["session"], self.created.session_id)
        self.assertTrue(result["reopened"])
        self.assertTrue(old.closed)
        self.assertEqual(self.hidden.current_session, self.anchor)
        self.assertEqual(self.app.refresh_count, 1)

    async def test_newer_protocol_reloads_existing_browser(self):
        document.iterm2.capabilities.supports_load_url.return_value = True
        old = Session("browser-old")
        old.app = self.app
        old.tab = self.hidden
        self.hidden.sessions.append(old)
        result = await document.open_document(
            self.app,
            self.anchor.session_id,
            "file:///doc.html",
            "doc",
            old.session_id,
        )
        self.assertEqual(result["session"], old.session_id)
        self.assertEqual(old.loaded_urls, ["file:///doc.html"])
        self.assertFalse(old.closed)

    async def test_wrong_tab_rolls_back_created_pane(self):
        self.anchor.split_target = self.visible
        with self.assertRaises(document.DocumentError):
            await document.open_document(
                self.app, self.anchor.session_id, "file:///doc.html", "doc"
            )
        self.assertTrue(self.created.closed)
        self.assertNotIn(self.created, self.visible.sessions)

    async def test_user_tab_change_is_never_overridden(self):
        self.anchor.change_global_tab = True
        with self.assertRaises(document.DocumentError):
            await document.open_document(
                self.app, self.anchor.session_id, "file:///doc.html", "doc"
            )
        self.assertTrue(self.created.closed)
        self.assertEqual(self.app.current_window.current_tab, self.hidden)
        self.assertEqual(self.hidden.current_session, self.anchor)

    def test_opener_has_no_queue_move_or_retry_loop(self):
        source = inspect.getsource(document)
        for forbidden in (
            "async_move_session",
            "staged_session",
            "open_pending",
            "while True",
            "retry=True",
        ):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()
