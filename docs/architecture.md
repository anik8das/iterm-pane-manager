# Architecture

```mermaid
flowchart TD
    CLI["Node command boundary"] --> STATE["Atomic state store"]
    CLI --> DOC["One-shot document helper"]
    CLI --> EVEN["One-shot evening helper"]
    WATCH["Single launchd watcher"] --> LAYOUT["Pure layout rules"]
    EVEN --> LAYOUT
    DOC --> API["iTerm2 Python API"]
    LAYOUT --> API
    STATE --> DISK["User-local state"]
```

The design separates document delivery from automatic evening. The watcher has no document code and cannot create, close, move, or reload a pane.

## Boundaries

### Command boundary

`bin/pane.mjs` validates input, resolves files and URLs, serializes state changes, and invokes small Python helpers. It refuses to open a document without `ITERM_SESSION_ID`, because there is no safe target tab without the calling session's stable ID.

### Rendering boundary

```mermaid
flowchart LR
    MD["src/node/markdown.mjs"] --> BODY["HTML body + charts + title"]
    BODY --> FILL["fillDiagrams"]
    CLI2["bin/mdrender.mjs"] --> MD
    CLI2 --> PW["Chromium renders each chart"]
    PW --> FILL
    FILL --> PAGE["Self-contained page"]
```

`src/node/markdown.mjs` owns Markdown to HTML and needs no browser, so the pipeline is testable without Chromium. It emits one placeholder per Mermaid block and `fillDiagrams` substitutes the rendered SVG.

Raw HTML in a source document is discarded. The diagram placeholder therefore carries an explicit `hName`/`hProperties` shape rather than being a raw HTML node, which keeps untrusted markup out of the page without losing the placeholder. YAML and TOML frontmatter are parsed so they are dropped rather than rendered. As in every frontmatter-aware renderer, an opening `---` is a fence rather than a thematic break, so a document that starts with a rule loses its first block; a rule anywhere else is untouched. The title comes from the first non-empty level-1 heading at the top level of the tree, ignoring headings quoted inside blockquotes or list items, and falls back to the file name.

### iTerm2 boundary

Python is used only where the iTerm2 API is required:

- `document.py` creates one browser split against an exact anchor session.
- `even.py` performs only an explicitly requested one-shot resize.
- `watch.py` listens for layout/focus events and measures the selected tab.
- `sessions.py` queries and closes sessions by stable ID.
- `layout.py` owns shared measurement and equal-sizing rules.

### State boundary

```mermaid
stateDiagram-v2
    [*] --> Missing
    Missing --> Tracked: open succeeds
    Tracked --> Tracked: same document replaced
    Tracked --> Missing: pane closes
    Tracked --> Missing: anchor disappears
    Tracked --> Missing: stale entry pruned
```

State lives at `~/.local/state/iterm-pane/state.json`. It records only document identity, anchor session, browser session, and a neutral profile name. Writes use a same-directory temporary file, file sync, and atomic rename. A process-owned directory lock prevents concurrent read-modify-write loss.

## Focus contract

```mermaid
sequenceDiagram
    participant U as User
    participant P as pane
    participant I as iTerm2
    U->>P: Open document from session A
    P->>I: Snapshot global focus
    P->>I: Split exact session A
    alt Global tab and window unchanged
        P->>I: Restore target tab's prior pane
        P->>I: Verify location and focus
    else User navigated during operation
        P->>I: Close the created pane
        P-->>U: Fail without changing global selection
    end
```

The opener validates both placement and global focus. It never activates a window or tab during normal operation. If the user navigates while a split is in flight, that navigation is treated as authoritative.

The watcher stores the selected session before resizing. If iTerm2 selects a sibling as a side effect of applying layout, it restores the original session with both `select_tab` and `order_window_front` disabled. If the user changes tabs, the watcher does nothing further.

Document open and close commands never call the one-shot resizer. Their layout event is handled by the watcher, which owns the selection-preservation logic.

## Evening policy

A tab is resized only when all of these conditions are true:

- iTerm2 is the active application.
- The tab is selected in the current window.
- The tab has at least two visible panes.
- The tab is not controlled by tmux.
- No pane is zoomed.
- Pane spread, dead space, or pane-count change indicates a layout update is needed.

Terminal grids round to whole character cells, so a 12-point tolerance prevents harmless rounding from causing a resize loop. A burst guard backs off for 60 seconds if another program repeatedly fights the layout.

## Process lifecycle

The installer creates one per-user LaunchAgent named `io.github.anik8das.iterm-pane-manager`. launchd owns restart policy; the watcher owns one iTerm2 connection lifecycle and exits on disconnect. There is no internal reconnect loop.

Versioned releases are stored below `~/.local/share/iterm-pane-manager/releases`. The `current` symlink is changed only after dependencies and tests pass. Watcher startup and `pane --doctor` are the final promotion gates.

## Failure modes

| Failure | Behavior |
|---|---|
| iTerm2 API disabled | Command fails with the exact setting to enable; state is not advanced. |
| State JSON invalid | Command fails loudly and preserves the file for recovery. |
| Concurrent commands | The second command waits for the owned state lock, then reads fresh state. |
| Wrong-tab split | The new browser closes and the command fails. |
| User navigates during split | The new browser closes; user focus is not restored or redirected. |
| Layout cannot settle | The watcher records the unchanged signature and stops retrying until shape changes. |
| Repeated external resizing | The burst guard pauses mutation for 60 seconds. |
| Failed update | The installer restores the previous runtime symlink and watcher. |
