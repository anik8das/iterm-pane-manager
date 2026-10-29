import unittest
from types import SimpleNamespace
from unittest import mock

import iterm2
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
        self.grid_size = SimpleNamespace(
            width=pane_frame.size.width / 10, height=pane_frame.size.height / 20
        )


class Tab:
    def __init__(self, sessions, tmux="", minimized=None):
        self.sessions = sessions
        self.tmux_connection_id = tmux
        self.minimized_sessions = minimized or []
        self.updated = False
        self.root = iterm2.Splitter(vertical=True)
        for session in sessions:
            self.root.add_child(session)

    async def async_update_layout(self):
        self.updated = True


class LayoutTest(unittest.IsolatedAsyncioTestCase):
    async def test_unchanged_grid_does_not_reapply_the_native_layout(self):
        tab = Tab(
            [Session("a", frame(0, 0, 500, 700)), Session("b", frame(501, 0, 500, 700))]
        )
        self.assertIs(await layout.even_tab(tab), False)
        self.assertFalse(tab.updated)
        self.assertTrue(all(session.preferred_size is None for session in tab.sessions))

    def test_detects_width_drift(self):
        tab = Tab(
            [Session("a", frame(0, 0, 400, 700)), Session("b", frame(400, 0, 600, 700))]
        )
        self.assertEqual(layout.needs_evening(tab, (1000, 700)), "off target by 100pt")

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

    async def test_even_tab_preserves_frame_extent(self):
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
            [(50, 35), (50, 35)],
        )
        self.assertTrue(tab.updated)

    async def test_mixed_browser_and_terminal_cells_on_small_and_large_screens(self):
        # Model iTerm's cells-to-points conversion, including pane decorations.
        # Equal cell counts reproduce the narrow browser pane on both screens.
        for widths in ((670, 671, 96), (1000, 1000, 160)):
            sessions = [
                Session(str(index), frame(sum(widths[:index]), 0, width, 700))
                for index, width in enumerate(widths)
            ]
            metrics = ((10, 20, 10, 24), (10, 20, 10, 24), (1, 1, 0, 40))
            for session, (cw, ch, padw, padh) in zip(sessions, metrics):
                session.grid_size = SimpleNamespace(
                    width=int((session.frame.size.width - padw) / cw),
                    height=int((session.frame.size.height - padh) / ch),
                )
            tab = Tab(sessions)

            async def apply_cells(sessions=sessions, metrics=metrics):
                for session, (cw, ch, padw, padh) in zip(sessions, metrics):
                    width, height = session.preferred_size
                    session.grid_size = SimpleNamespace(width=width, height=height)
                    session.frame.size.width = width * cw + padw
                    session.frame.size.height = height * ch + padh
                x = 0
                for session in sessions:
                    session.frame.origin.x = x
                    x += session.frame.size.width

            tab.async_update_layout = apply_cells
            original_width = sum(widths)
            with mock.patch.object(
                layout.iterm2, "Size", side_effect=lambda width, height: (width, height)
            ):
                for _ in range(5):
                    await layout.even_tab(tab)
                    if max(layout.spreads(tab)) <= layout.TOLERANCE:
                        break
            self.assertLessEqual(max(layout.spreads(tab)), layout.TOLERANCE)
            self.assertLessEqual(
                abs(sum(s.frame.size.width for s in sessions) - original_width), 30
            )

    def test_nested_split_preserves_extent_and_full_height_neighbor(self):
        a = Session("a", frame(0, 0, 400, 349))
        b = Session("b", frame(0, 350, 400, 350))
        c = Session("c", frame(401, 0, 600, 700))
        column = iterm2.Splitter(vertical=False)
        column.add_child(a)
        column.add_child(b)
        root = iterm2.Splitter(vertical=True)
        root.add_child(column)
        root.add_child(c)
        _, targets = layout.point_targets(root)
        self.assertEqual(len(targets), 3)
        self.assertEqual(
            [session.session_id for session, _, _ in targets], ["a", "b", "c"]
        )
        for (_, width, height), (want_width, want_height) in zip(
            targets, [(500, 349.5), (500, 349.5), (500, 700)]
        ):
            self.assertAlmostEqual(width, want_width)
            self.assertAlmostEqual(height, want_height)

    def test_equal_columns_with_stacked_rows_need_no_resize(self):
        a = Session("a", frame(0, 0, 500, 349))
        b = Session("b", frame(0, 350, 500, 350))
        c = Session("c", frame(501, 0, 500, 700))
        column = iterm2.Splitter(vertical=False)
        column.add_child(a)
        column.add_child(b)
        tab = Tab([a, b, c])
        tab.root = iterm2.Splitter(vertical=True)
        tab.root.add_child(column)
        tab.root.add_child(c)
        self.assertIsNone(layout.needs_evening(tab, (1001, 700)))

    async def test_invalid_geometry_does_not_submit_partial_layout(self):
        sessions = [
            Session("a", frame(0, 0, 500, 700)),
            Session("b", frame(500, 0, 0, 700)),
        ]
        tab = Tab(sessions)
        self.assertIsNone(await layout.even_tab(tab))
        self.assertFalse(tab.updated)
        self.assertIsNone(sessions[0].preferred_size)
        self.assertEqual(
            layout.needs_evening(tab, (1000, 700)), "pane geometry is pending"
        )

    async def test_focus_guard_is_rechecked_after_profile_reads(self):
        sessions = [
            Session("a", frame(0, 0, 400, 700)),
            Session("b", frame(400, 0, 600, 700)),
        ]
        tab = Tab(sessions)
        self.assertIsNone(await layout.even_tab(tab, allowed=lambda: False))
        self.assertFalse(tab.updated)
        self.assertTrue(all(session.preferred_size is None for session in sessions))

    async def test_equalizing_cannot_push_browsers_below_the_native_minimum(self):
        sessions = [Session(str(i), frame(i * 360, 0, 360, 700)) for i in range(4)]
        for session in sessions:
            session.async_get_profile = mock.AsyncMock(
                return_value=SimpleNamespace(
                    all_properties={"Custom Command": "Browser"}
                )
            )
        tab = Tab(sessions)
        with self.assertRaisesRegex(layout.LayoutConstraintError, "require 395pt"):
            await layout.even_tab(tab)
        self.assertFalse(tab.updated)
        self.assertTrue(all(session.preferred_size is None for session in sessions))


if __name__ == "__main__":
    unittest.main()
