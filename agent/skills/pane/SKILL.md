---
name: pane
description: Show a Markdown, HTML, or web document in a side pane of this exact iTerm2 tab with the pane command. Use when the user asks to see, show, render, preview, or read a document, and right after writing or updating a plan, report, summary, or design document the user will read.
---

# pane

Open a browser pane beside the terminal session that asks for it, exactly on macOS with iTerm2, without moving the user's focus. The binding product contract is `docs/goals.md` in the iterm-pane-manager repository; this skill is the working subset.

## Quick start

```text
pane path/to/document.md
```

Write the file first, then run `pane` on its path. Re-running `pane` on the same document replaces its existing pane, so refresh as you go. Markdown is rendered to a self-contained HTML page with Mermaid diagrams as inline SVG; `pane doc.md --raw` shows the Markdown as plain text instead.

## The refusal rule

A refusal is correct behavior, not an error. If `pane` reports that you are a background job with no visible terminal:

- Do not retry, and never set `PANE_ANCHOR` to claim a tab you are not in.
- Do not tell the user the tool is broken.
- Do not ask the user to open the file by hand.
- Say in one line: "Written to `<path>`. To see it, run `pane <path>` in a foreground tab."

`PANE_ANCHOR` exists for callers behind tmux or a remote shell who name their tab deliberately.

## Commands

```text
# Open, replace, list, close
pane <document>
pane <document> --raw
pane --list
pane --close <document>
pane --close-all

# Even this tab now, or every tab now
pane --even
pane --even --all

# Inspect or pause automatic evening
pane --watch-status
pane --pause
pane --resume

# Health check
pane --doctor
```

## What the tool guarantees

- The document opens in the calling session's own tab, never another tab or a new window, and focus does not move.
- Only a process actually in the tab may open, close, or even it.
- A tab holds at most three document panes; the oldest gives up its place.
- A failure leaves the tab exactly as it was.

## Sandbox note

If `pane` fails with a permission error writing next to the document, the sandbox blocks that path: rerun the call outside the sandbox or ask the user to. Pane's own state directory (`~/.local/state/iterm-pane`) must also be writable; the installer adds it to the sandbox allowlist when the agent wiring is installed.

## Troubleshooting

- `pane --doctor` distinguishes unavailable probes from real failures; a probe that cannot run is not a broken tool.
- Links inside a rendered document do not open: see the browser-proxy entry in the repository's `docs/troubleshooting.md`.
