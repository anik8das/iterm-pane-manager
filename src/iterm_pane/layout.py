"""Shared measurement and resizing rules for iTerm2 split panes."""

import iterm2

TOLERANCE = 12.0


def frames(tab):
    """Return each visible pane frame as ``(x, y, width, height)``."""
    return [
        (
            session.frame.origin.x,
            session.frame.origin.y,
            session.frame.size.width,
            session.frame.size.height,
        )
        for session in tab.sessions
    ]


def spread(tab):
    """Return the narrowest and widest pane widths in points."""
    widths = [frame[2] for frame in frames(tab)]
    return min(widths), max(widths)


def spreads(tab):
    """Return width and height spread in points."""
    pane_frames = frames(tab)
    widths = [frame[2] for frame in pane_frames]
    heights = [frame[3] for frame in pane_frames]
    return max(widths) - min(widths), max(heights) - min(heights)


def extent(tab):
    """Return the width and height covered by all panes in a tab."""
    pane_frames = frames(tab)
    if not pane_frames:
        return 0.0, 0.0
    return (
        max(x + width for x, _y, width, _height in pane_frames)
        - min(x for x, _y, _width, _height in pane_frames),
        max(y + height for _x, y, _width, height in pane_frames)
        - min(y for _x, y, _width, _height in pane_frames),
    )


def content_size(window):
    """Estimate the shared content area from the largest tab extent."""
    best = (0.0, 0.0)
    for tab in window.tabs:
        width, height = extent(tab)
        best = (max(best[0], width), max(best[1], height))
    return best


def signature(tab):
    """Return a stable, whole-point signature for a tab layout."""
    return tuple(
        sorted(
            (round(x), round(y), round(width), round(height))
            for x, y, width, height in frames(tab)
        )
    )


def session_ids(tab):
    """Return the visible session IDs in a tab."""
    return frozenset(session.session_id for session in tab.sessions)


def skip_reason(tab):
    """Explain why a tab must not be resized, or return ``None``."""
    if len(tab.sessions) < 2:
        return "single pane"
    if tab.tmux_connection_id:
        return "tmux tab"
    if tab.minimized_sessions:
        return "a pane is zoomed"
    return None


def needs_evening(tab, window_content, tolerance=TOLERANCE):
    """Explain why a tab needs resizing, or return ``None``."""
    width_spread, height_spread = spreads(tab)
    if width_spread > tolerance or height_spread > tolerance:
        return f"uneven by {max(width_spread, height_spread):.0f}pt"

    extent_width, extent_height = extent(tab)
    if (
        window_content[0] - extent_width > tolerance
        or window_content[1] - extent_height > tolerance
    ):
        return (
            f"{extent_width:.0f}x{extent_height:.0f} in a "
            f"{window_content[0]:.0f}x{window_content[1]:.0f} tab"
        )
    return None


def _span(sessions):
    """Return the width and height covered by the given sessions."""
    return (
        max(s.frame.origin.x + s.frame.size.width for s in sessions)
        - min(s.frame.origin.x for s in sessions),
        max(s.frame.origin.y + s.frame.size.height for s in sessions)
        - min(s.frame.origin.y for s in sessions),
    )


def point_targets(node):
    """Allocate the existing split-tree extent using equal leaf-size units.

    Sum units along a split and take their maximum across it. Thus a column
    with two stacked panes has the same width as a single neighboring pane,
    without forcing that neighbor to half height. Preserve measured dividers.
    """
    if not isinstance(node, iterm2.Splitter):
        return (1, 1), [(node, node.frame.size.width, node.frame.size.height)]
    children = [point_targets(child) for child in node.children]
    if not children:
        return (0, 0), []
    axis = 0 if node.vertical else 1
    units = [max(child[0][dimension] for child in children) for dimension in (0, 1)]
    units[axis] = sum(child[0][axis] for child in children)
    leaves = [item for _, targets in children for item in targets]
    width, height = _span([item[0] for item in leaves])
    # Each child's targets already include its internal dividers. Recover that
    # child's extent from its measured leaves when allocating its new share.
    targets = []
    for child_units, child_targets in children:
        child_width, child_height = _span([item[0] for item in child_targets])
        targets.append((child_units, child_targets, child_width, child_height))
    gap = (width if axis == 0 else height) - sum(item[2 + axis] for item in targets)
    result = []
    for child_units, child_targets, child_width, child_height in targets:
        desired = [width, height]
        available = (width if axis == 0 else height) - gap
        desired[axis] = available * child_units[axis] / units[axis]
        for session, pane_width, pane_height in child_targets:
            result.append(
                (
                    session,
                    pane_width * desired[0] / child_width,
                    pane_height * desired[1] / child_height,
                )
            )
    return tuple(units), result


async def even_tab(tab):
    """Convert equal physical shares to each pane's own grid units.

    Preferred sizes are cell counts, not weights. Browser grids use points,
    while terminal grids use font cells, which can differ between profiles.
    Refreshed watcher sweeps correct rounding and pane decorations.
    """
    if skip_reason(tab):
        return None
    for session in tab.sessions:
        size = session.frame.size
        grid = session.grid_size
        if min(size.width, size.height, grid.width, grid.height) <= 0:
            return None  # A split may still be acquiring its initial geometry.
    _, targets = point_targets(tab.root)
    preferences = []
    for session, target_width, target_height in targets:
        size = session.frame.size
        grid = session.grid_size
        preferences.append(
            (
                session,
                iterm2.Size(
                    max(1, round(grid.width * target_width / size.width)),
                    max(1, round(grid.height * target_height / size.height)),
                ),
            )
        )
    for session, preferred in preferences:
        session.preferred_size = preferred
    await tab.async_update_layout()
    return True
