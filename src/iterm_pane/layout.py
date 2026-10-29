"""Shared measurement and resizing rules for iTerm2 split panes."""

import iterm2

TOLERANCE = 12.0
# Native browser minimum in the terminal's split-layout implementation.
MIN_BROWSER_WIDTH = 395.0
# Native split views use the one-point thin divider style.
DIVIDER_WIDTH = 1.0


class LayoutConstraintError(ValueError):
    """Equal sizing would violate a native pane minimum."""


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


def column_count(node):
    """Count equal-width units without requiring settled frame geometry."""
    if not isinstance(node, iterm2.Splitter):
        return 1
    counts = [column_count(child) for child in node.children]
    return sum(counts) if node.vertical else max(counts, default=0)


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
    if any(width <= 0 or height <= 0 for _x, _y, width, height in frames(tab)):
        return "pane geometry is pending"
    _, targets = point_targets(tab.root)
    deviation = max(
        (
            max(
                abs(session.frame.size.width - width),
                abs(session.frame.size.height - height),
            )
            for session, width, height in targets
        ),
        default=0,
    )
    if deviation * 2 > tolerance:
        return f"off target by {deviation:.0f}pt"

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


def point_targets(node, content=None):
    """Allocate the existing split-tree extent using equal leaf-size units.

    Sum units along a split and take their maximum across it. Thus a column
    with two stacked panes has the same width as a single neighboring pane,
    without forcing that neighbor to half height. Preserve measured dividers.
    """
    if not isinstance(node, iterm2.Splitter):
        width, height = content or (node.frame.size.width, node.frame.size.height)
        return (1, 1), [(node, width, height)]
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
    # A closed pane in a hidden tab can leave a pane-sized hole. That empty
    # area is usable content, not an unusually wide divider to preserve.
    gap = min(gap, (len(children) - 1) * DIVIDER_WIDTH)
    if content is not None:
        width, height = content
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


def native_tree(node):
    """Keep the same tree when equal native child shares match our leaf units."""
    if not isinstance(node, iterm2.Splitter):
        return {"session_id": node.session_id}
    children = [native_tree(child) for child in node.children]
    if not children or any(child is None for child in children):
        return None
    if len(children) == 1:
        return children[0]
    axis = 0 if node.vertical else 1
    units = [point_targets(child)[0][axis] for child in node.children]
    if len(set(units)) != 1:
        return None
    return {"vertical": node.vertical, "children": children}


async def even_tab(tab, *, app=None, content=None, allowed=None):
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
    content = content or extent(tab)
    if needs_evening(tab, content) is None:
        return False
    _, targets = point_targets(tab.root, content)
    preferences = []
    for session, target_width, target_height in targets:
        if target_width < MIN_BROWSER_WIDTH:
            profile = await session.async_get_profile()
            if profile.all_properties.get("Custom Command") == "Browser":
                raise LayoutConstraintError(
                    f"equal columns would be {target_width:.0f}pt wide; "
                    f"browser panes require {MIN_BROWSER_WIDTH:g}pt"
                )
        size = session.frame.size
        grid = session.grid_size
        preferences.append(
            (
                session,
                max(1, round(grid.width * target_width / size.width)),
                max(1, round(grid.height * target_height / size.height)),
            )
        )
    if allowed is not None and not allowed():
        return None
    tree = native_tree(tab.root)
    if (
        app is not None
        and tree
        and iterm2.capabilities.supports_apply_layout(app.connection)
    ):
        # This preserves native view extent and refreshes session grids. The
        # older grid-size RPC fits the window to stale grids after a close.
        await app.async_apply_layout({"tabs": [{"tab_id": tab.tab_id, "root": tree}]})
        return True
    if all(
        width == session.grid_size.width and height == session.grid_size.height
        for session, width, height in preferences
    ):
        return False
    for session, width, height in preferences:
        session.preferred_size = iterm2.Size(width, height)
    await tab.async_update_layout()
    return True
