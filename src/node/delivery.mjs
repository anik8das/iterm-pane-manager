import { DOCUMENTS_PER_TAB, documentsToEvict } from "./budget.mjs";
import { closeSessions, openDocument, retireDocuments, snapshot } from "./runtime.mjs";
import { writeStateAtomic } from "./state.mjs";

/** Keep cleanup recoverable until every verified predecessor has retired. */
export function finishRetirement(paths, statePath, state, key, overrides = {}) {
  const document = state.documents[key];
  if (!Object.keys(document?.retiring ?? {}).length) return 0;
  const retire = overrides.retire ?? ((entry) => retireDocuments(paths, entry));
  const save = overrides.save ?? (() => writeStateAtomic(statePath, state));
  const result = retire(document);
  const closed = new Set(result.closed);
  for (const session of closed) delete document.retiring[session];
  for (const [otherKey, other] of Object.entries(state.documents)) {
    if (otherKey !== key && closed.has(other.session)) delete state.documents[otherKey];
  }
  if (!Object.keys(document.retiring).length) {
    delete document.retiring;
    delete document.previous;
  }
  save();
  if (result.kept.length) throw new Error(result.kept.join("; "));
  return closed.size;
}

/** Persist a replacement before retiring any document that preceded it. */
export function deliverDocument(paths, statePath, state, key, entry, live, overrides = {}) {
  const operations = {
    open: (document) => openDocument(paths, document, { beforeSessionIds: live }),
    save: () => writeStateAtomic(statePath, state),
    remove: (session) => closeSessions(paths, [session]),
    retire: (document) => retireDocuments(paths, document),
    snapshot: () => snapshot(paths),
    ...overrides,
  };

  // An interrupted cleanup must be settled before another split can grow it.
  finishRetirement(paths, statePath, state, key, operations);
  const previous = state.documents[key] ?? null;
  const result = operations.open(entry);
  let retiring;
  try {
    const current = operations.snapshot();
    const location = current.sessions[entry.anchor];
    if (!location || location.tab_id !== result.target_tab || current.sessions[result.session]?.tab_id !== location.tab_id) {
      throw new Error("anchor or browser moved while the document opened");
    }
    const liveDocuments = Object.values(state.documents).filter(
      (document) => current.sessions[document.session]?.tab_id === location.tab_id,
    ).length;
    if (![location.tab_width, location.columns, current.minimum_browser_width].every(
      (value) => Number.isFinite(value) && value > 0,
    )) throw new Error("terminal did not report usable tab geometry");
    const capacity = Math.floor((location.tab_width + 1) / (current.minimum_browser_width + 1));
    const replacement = previous?.session !== result.session && previous?.session ? 1 : 0;
    const surplusColumns = Math.max(0, location.columns - replacement - capacity);
    const limit = Math.min(DOCUMENTS_PER_TAB, liveDocuments + (previous ? 0 : 1) - surplusColumns);
    if (limit < 1) throw new Error("this tab cannot fit another readable document column; existing documents were retained");
    const evicted = documentsToEvict(state, {
      key, anchor: entry.anchor, tabId: location.tab_id,
      reading: location.selected_session,
      live: new Set(Object.keys(current.sessions)),
      locations: current.sessions,
      limit,
    });
    if (liveDocuments + (previous ? 0 : 1) - evicted.length > limit) {
      throw new Error("the selected document occupies the remaining column; existing documents were retained");
    }
    retiring = Object.fromEntries(evicted.map(([, document]) => [document.session, document.profile]));
    if (previous?.session && previous.session !== result.session) {
      retiring[previous.session] = previous.profile;
    }
    state.documents[key] = {
      ...entry, session: result.session, tab: result.target_tab, opened: Date.now(),
      ...(Object.keys(retiring).length ? { retiring, previous: previous?.session ?? null } : {}),
    };
    operations.save();
  } catch (error) {
    if (previous) state.documents[key] = previous;
    else delete state.documents[key];
    if (result.session !== previous?.session) {
      try {
        operations.remove(result.session);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `${error.message}; new pane cleanup failed: ${cleanupError.message}`, { cause: cleanupError });
      }
    }
    throw error;
  }

  try {
    const retired = finishRetirement(paths, statePath, state, key, operations);
    return { ...result, retired };
  } catch (error) {
    throw new Error(`document opened and tracked, but older panes could not be retired: ${error.message}`, { cause: error });
  }
}
