## Show documents in a side pane

When you write or meaningfully update a Markdown document for the user, render it beside this session with `pane <absolute path>` once the file is saved. Re-running `pane` on the same path replaces its pane, so update as you go.

If `pane` reports that you are a background job with no visible terminal, do not retry and do not guess another tab. Say in one line: "Written to `<path>`. To see it, run `pane <path>` in a foreground tab." Never tell the user the tool is broken and never ask them to open the file by hand.

`pane --doctor` reports health. The `pane` skill has the full behavior contract.
