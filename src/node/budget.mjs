/**
 * How many document panes one tab may hold.
 *
 * Equal widths and one pane per document pull the same way: each document
 * makes every pane in the tab narrower, and the next document splits a
 * narrower pane again. Tabs were reaching fourteen panes at 246pt before
 * iTerm2 refused to split at all and the document was lost with no way back.
 * A tab that gives up its oldest reading pane keeps both the split and the
 * width usable.
 */
export const DOCUMENTS_PER_TAB = 3;

/**
 * The tracked documents this tab must close before it has room for one more.
 *
 * Oldest first, and only panes this tool opened: a terminal is never a
 * candidate because it was never tracked. The pane being read right now is
 * never a candidate either, so nothing closes under someone's cursor.
 *
 * An entry written before tabs were recorded belongs to no tab. It falls back
 * to sharing a tab with the session that opened it, which is true of every
 * tab holding one agent and is otherwise wrong only by under-counting, so the
 * fallback can free a slot but can never take one it should not.
 */
export function documentsToEvict(
  state,
  { key, anchor, tabId, reading = null, live, limit = DOCUMENTS_PER_TAB },
) {
  if (!tabId) return [];
  const sameTab = Object.entries(state.documents)
    .filter(([otherKey, entry]) => {
      if (otherKey === key) return false;
      if (!entry.session || !live.has(entry.session)) return false;
      return entry.tab ? entry.tab === tabId : entry.anchor === anchor;
    })
    .sort((left, right) => (left[1].opened || 0) - (right[1].opened || 0));

  // The pane being read still takes up the room it takes up, so it counts
  // towards the budget. It just is not one of the panes that may go.
  const surplus = sameTab.length - (limit - 1);
  if (surplus < 1) return [];
  const removable = sameTab.filter(([, entry]) => entry.session !== reading);
  return removable.slice(0, Math.min(surplus, removable.length));
}
