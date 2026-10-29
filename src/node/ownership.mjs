import { ownsAnchor } from "./anchor.mjs";

/** A restored terminal keeps its device even when its session address changes. */
export function resolveOwnership(anchor, { explicit, caller, status, find }) {
  if (explicit) {
    if (!status.exists) throw new Error(`the explicit pane address ${anchor} has expired`);
    return { anchor, status };
  }
  if (status.exists && (caller === null || ownsAnchor(caller, status.tty))) {
    return { anchor, status };
  }
  if (caller) {
    const actual = find(caller);
    if (actual.exists && actual.session && ownsAnchor(caller, actual.tty)) {
      return { anchor: actual.session, status: actual };
    }
  }
  throw new Error(
    "the command executor could not verify its current terminal; its inherited tab address " +
    (status.exists ? "belongs to another terminal" : "has expired") +
    ". A visible session can remain open after its address changes. No tab was guessed.",
  );
}
