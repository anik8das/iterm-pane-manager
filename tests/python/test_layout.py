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
    async def test_native_sizing_honors_a_stricter_configured_tolerance(self):
        tab = Tab(
            [Session("a", frame(0, 0, 495, 700)), Session("b", frame(496, 0, 505, 700))]
        )
        tab.tab_id = "target-tab"
        app = SimpleNamespace(
            connection=SimpleNamespace(iterm2_protocol_version=(1, 14)),
            async_apply_layout=mock.AsyncMock(),
        )
        self.assertIs(await layout.even_tab(tab, app=app), False)
        app.async_apply_layout.assert_not_awaited()
        self.assertIs(await layout.even_tab(tab, app=app, tolerance=2), True)
        app.async_apply_layout.assert_awaited_once()

    async def test_native_layout_preserves_the_tree_and_avoids_the_grid_size_rpc(self):
        sessions = [
            Session("a", frame(0, 0, 400, 700)),
            Session("b", frame(401, 0, 600, 700)),
        ]
        tab = Tab(sessions)
        tab.tab_id = "target-tab"
        app = SimpleNamespace(
            connection=SimpleNamespace(iterm2_protocol_version=(1, 14)),
            async_apply_layout=mock.AsyncMock(),
        )
        self.assertIs(await layout.even_tab(tab, app=app), True)
        app.async_apply_layout.assert_awaited_once_with(
            {
                "tabs": [
                    {
                        "tab_id": "target-tab",
                        "root": {
                            "vertical": True,
                            "children": [
                                {"session_id": "a"},
                                {"session_id": "b"},
                            ],
                        },
                    }
                ]
            }
        )
        self.assertFalse(tab.updated)
        self.assertTrue(all(session.preferred_size is None for session in sessions))

    async def test_native_layout_error_is_not_retried_with_a_different_mutation(self):
        tab = Tab(
            [Session("a", frame(0, 0, 400, 700)), Session("b", frame(401, 0, 600, 700))]
        )
        tab.tab_id = "target-tab"
        app = SimpleNamespace(
            connection=SimpleNamespace(iterm2_protocol_version=(1, 14)),
            async_apply_layout=mock.AsyncMock(side_effect=RuntimeError("tree changed")),
        )
        with self.assertRaisesRegex(RuntimeError, "tree changed"):
            await layout.even_tab(tab, app=app)
        self.assertFalse(tab.updated)

    def test_native_tree_retains_stacked_rows_and_rejects_unequal_child_units(self):
        a, b, c, d = [Session(str(i), frame(i * 400, 0, 400, 700)) for i in range(4)]
        row = iterm2.Splitter(vertical=False)
        row.add_child(a)
        row.add_child(b)
        root = iterm2.Splitter(vertical=True)
        root.add_child(row)
        root.add_child(c)
        self.assertEqual(
            layout.native_tree(root)["children"][0],
            {
                "vertical": False,
                "children": [{"session_id": "0"}, {"session_id": "1"}],
            },
        )
        nested = iterm2.Splitter(vertical=True)
        nested.add_child(a)
        nested.add_child(d)
        row.children[0] = nested
        self.assertIsNone(layout.native_tree(root))

    async def test_closed_pane_dead_space_uses_the_available_content_extent(self):
        sessions = [
            Session("terminal", frame(0, 0, 252, 876)),
            Session("browser-a", frame(253, 0, 395, 876)),
            Session("browser-b", frame(1045, 0, 395, 876)),
        ]
        for session, width, height in zip(sessions, (34, 385, 385), (50, 850, 850)):
            session.grid_size = SimpleNamespace(width=width, height=height)
            session.async_get_profile = mock.AsyncMock(
                return_value=SimpleNamespace(
                    all_properties={"Custom Command": "Browser"}
                )
            )
        tab = Tab(sessions)
        self.assertIs(await layout.even_tab(tab, content=(1440, 876)), True)
        self.assertTrue(tab.updated)
        for session in sessions:
            self.assertGreater(session.preferred_size.width, session.grid_size.width)

    async def test_equal_physical_widths_do_not_resize_for_grid_rounding(self):
        sessions = [
            Session("terminal", frame(0, 0, 479, 876)),
            Session("browser-a", frame(480, 0, 479, 876)),
            Session("browser-b", frame(960, 0, 480, 876)),
        ]
        for session, width, height in zip(sessions, (67, 469, 470), (50, 850, 850)):
            session.grid_size = SimpleNamespace(width=width, height=height)
        tab = Tab(sessions)
        self.assertIs(await layout.even_tab(tab), False)
        self.assertFalse(tab.updated)
        self.assertTrue(all(session.preferred_size is None for session in sessions))

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
        widths = (255, 395, 395, 395)
        sessions = [
            Session(str(i), frame(sum(widths[:i]), 0, width, 700))
            for i, width in enumerate(widths)
        ]
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
