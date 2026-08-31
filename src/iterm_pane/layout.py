"""Shared measurement and resizing rules for iTerm2 split panes."""

import iterm2

SHARE = 1000
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


async def even_tab(tab):
    """Request equal preferred sizes for every visible pane in a tab."""
    if skip_reason(tab):
        return None
    for session in tab.sessions:
        session.preferred_size = iterm2.Size(SHARE, SHARE)
    await tab.async_update_layout()
    return True
