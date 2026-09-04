/**
 * The rules that decide which tab receives a document.
 *
 * A document is delivered to the tab of the iTerm2 session named by
 * `ITERM_SESSION_ID`. The variable holds a position prefix and a stable ID,
 * `w0t1p2:UUID`, and only the ID survives a pane being moved or renumbered.
 *
 * Naming a tab is not the same as being in it. The variable is inherited by
 * every child, including a detached one that outlives the tab's foreground
 * process, so a background job can keep a valid address for a tab it has no
 * part in. `ownsAnchor` is the second rule: the terminal the caller is
 * actually on has to be the terminal that tab is running.
 */
export function parseAnchor(value) {
  return (value || "").split(":").pop() || "";
}

/** Reduce a terminal name to its device, so `/dev/ttys012` and `ttys012` agree. */
export function normalizeTty(value) {
  const name = String(value || "").trim();
  if (!name || name === "??" || name === "-") return "";
  return name.replace(/^\/dev\//, "");
}

/**
 * Whether a caller on `callerTty` may open a document in a tab on `anchorTty`.
 *
 * A caller with no terminal anywhere above it has been detached from the tab
 * it names and is refused. So is a caller on a different terminal, which is
 * how a stale address from another tab, or from inside a multiplexer, is
 * caught. Both sides must be known: an unanswerable question is not consent.
 */
export function ownsAnchor(callerTty, anchorTty) {
  const caller = normalizeTty(callerTty);
  const anchor = normalizeTty(anchorTty);
  return Boolean(caller) && caller === anchor;
}
