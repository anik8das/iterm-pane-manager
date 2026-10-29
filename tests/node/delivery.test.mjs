import assert from "node:assert/strict";
import test from "node:test";
import { deliverDocument } from "../../src/node/delivery.mjs";

function fixture() {
  const previous = { anchor: "code", url: "file:///doc.html", profile: "pane doc", session: "old", tab: "tab", opened: 1 };
  const state = { version: 1, documents: { doc: previous } };
  const events = [];
  const operations = {
    open: () => ({ session: "new", target_tab: "tab" }),
    snapshot: () => ({ minimum_browser_width: 395, sessions: {
      code: { tab_id: "tab", selected_session: "code", tab_width: 1440, columns: 3 },
      old: { tab_id: "tab" }, new: { tab_id: "tab" },
    } }),
    save: () => events.push(["saved", structuredClone(state)]),
    remove: (session) => events.push(["removed", session]),
    retire: (document) => {
      events.push(["retired", structuredClone(document.retiring)]);
      return { closed: Object.keys(document.retiring), kept: [] };
    },
  };
  const deliver = () => deliverDocument({}, "unused", state, "doc", previous, new Set(["code", "old"]), operations);
  return { state, previous, operations, events, deliver };
}

test("replacement is durably tracked before the previous document is retired", () => {
  const f = fixture();
  f.deliver();
  assert.deepEqual(f.events.map(([event]) => event), ["saved", "retired", "saved"]);
  assert.equal(f.events[0][1].documents.doc.session, "new");
  assert.deepEqual(f.events[0][1].documents.doc.retiring, { old: "pane doc" });
  assert.equal(f.state.documents.doc.session, "new");
  assert.equal(f.state.documents.doc.retiring, undefined);
});

test("a failed split leaves the previous document and capacity victims alone", () => {
  const f = fixture();
  f.operations.open = () => { throw new Error("CANNOT_SPLIT"); };
  assert.throws(f.deliver, /CANNOT_SPLIT/);
  assert.deepEqual(f.events, []);
  assert.equal(f.state.documents.doc, f.previous);
});

test("a failed state write removes only the candidate and keeps the old document", () => {
  const f = fixture();
  f.operations.save = () => { throw new Error("disk full"); };
  assert.throws(f.deliver, /disk full/);
  assert.deepEqual(f.events, [["removed", "new"]]);
  assert.equal(f.state.documents.doc, f.previous);
});

test("failed retirement leaves the replacement tracked with recoverable old-pane identity", () => {
  const f = fixture();
  f.operations.retire = () => { throw new Error("connection closed"); };
  assert.throws(f.deliver, /opened and tracked.*connection closed/);
  assert.equal(f.state.documents.doc.session, "new");
  assert.deepEqual(f.state.documents.doc.retiring, { old: "pane doc" });
  assert.equal(f.events.some(([event]) => event === "removed"), false);
});

test("a narrow tab retires a document before it can accumulate unreadable columns", () => {
  const f = fixture();
  f.state.documents.other = { ...f.previous, session: "second", profile: "pane other", opened: 2 };
  f.operations.snapshot = () => ({ minimum_browser_width: 395, sessions: {
    code: { tab_id: "tab", selected_session: "code", tab_width: 1440, columns: 4 },
    old: { tab_id: "tab" }, second: { tab_id: "tab" }, new: { tab_id: "tab" },
  } });
  const entry = { ...f.previous, url: "file:///third.html", session: null };
  deliverDocument({}, "unused", f.state, "third", entry, new Set(["code", "old", "second"]), f.operations);
  assert.deepEqual(Object.keys(f.state.documents).sort(), ["other", "third"]);
  assert.deepEqual(f.events.find(([event]) => event === "retired")[1], { old: "pane doc" });
});

test("a pane moved to another tab is never a capacity victim", () => {
  const f = fixture();
  f.state.documents.other = { ...f.previous, session: "second", opened: 2 };
  f.operations.snapshot = () => ({ minimum_browser_width: 395, sessions: {
    code: { tab_id: "tab", selected_session: "code", tab_width: 1440, columns: 3 },
    old: { tab_id: "elsewhere" }, second: { tab_id: "tab" }, new: { tab_id: "tab" },
  } });
  const entry = { ...f.previous, session: null };
  deliverDocument({}, "unused", f.state, "third", entry, new Set(["code", "old", "second"]), f.operations);
  assert.equal(f.state.documents.doc.session, "old");
  assert.equal(f.events.some(([event]) => event === "retired"), false);
});
