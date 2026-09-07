import assert from "node:assert/strict";
import test from "node:test";

import { DOCUMENTS_PER_TAB, documentsToEvict } from "../../src/node/budget.mjs";

function entry(overrides) {
  return {
    anchor: "code",
    url: "file:///d.html",
    profile: "pane d",
    session: "browser",
    tab: "tab-1",
    opened: 0,
    ...overrides,
  };
}

function stateOf(pairs) {
  return { version: 2, documents: Object.fromEntries(pairs) };
}

const live = (...ids) => new Set(ids);

test("a tab under its budget gives up nothing", () => {
  const state = stateOf([
    ["a", entry({ session: "one", opened: 1 })],
    ["b", entry({ session: "two", opened: 2 })],
  ]);
  const evicted = documentsToEvict(state, {
    key: "new",
    anchor: "code",
    tabId: "tab-1",
    live: live("one", "two"),
  });
  assert.deepEqual(evicted, []);
});

test("a full tab gives up its oldest pane, and only that one", () => {
  const state = stateOf([
    ["b", entry({ session: "two", opened: 200 })],
    ["a", entry({ session: "one", opened: 100 })],
    ["c", entry({ session: "three", opened: 300 })],
  ]);
  const evicted = documentsToEvict(state, {
    key: "new",
    anchor: "code",
    tabId: "tab-1",
    live: live("one", "two", "three"),
  });
  assert.equal(evicted.length, 1);
  assert.equal(evicted[0][0], "a");
});

test("panes in other tabs are never touched", () => {
  const state = stateOf([
    ["a", entry({ session: "one", opened: 1, tab: "tab-9" })],
    ["b", entry({ session: "two", opened: 2, tab: "tab-9" })],
    ["c", entry({ session: "three", opened: 3, tab: "tab-9" })],
    ["d", entry({ session: "four", opened: 4, tab: "tab-9" })],
  ]);
  const evicted = documentsToEvict(state, {
    key: "new",
    anchor: "code",
    tabId: "tab-1",
    live: live("one", "two", "three", "four"),
  });
  assert.deepEqual(evicted, []);
});

test("the pane being read is never closed under the cursor", () => {
  const state = stateOf([
    ["a", entry({ session: "one", opened: 100 })],
    ["b", entry({ session: "two", opened: 200 })],
    ["c", entry({ session: "three", opened: 300 })],
  ]);
  const evicted = documentsToEvict(state, {
    key: "new",
    anchor: "code",
    tabId: "tab-1",
    reading: "one",
    live: live("one", "two", "three"),
  });
  assert.equal(evicted.length, 1);
  assert.equal(evicted[0][1].session, "two", "the oldest that is not being read");
});

test("reopening the same document takes no one else's slot", () => {
  const state = stateOf([
    ["same", entry({ session: "one", opened: 100 })],
    ["b", entry({ session: "two", opened: 200 })],
    ["c", entry({ session: "three", opened: 300 })],
  ]);
  const evicted = documentsToEvict(state, {
    key: "same",
    anchor: "code",
    tabId: "tab-1",
    live: live("one", "two", "three"),
  });
  assert.deepEqual(evicted, [], "its own pane is the slot it reuses");
});

test("a dead pane is not counted and not closed again", () => {
  const state = stateOf([
    ["a", entry({ session: "gone", opened: 1 })],
    ["b", entry({ session: "two", opened: 2 })],
    ["c", entry({ session: "three", opened: 3 })],
  ]);
  const evicted = documentsToEvict(state, {
    key: "new",
    anchor: "code",
    tabId: "tab-1",
    live: live("two", "three"),
  });
  assert.deepEqual(evicted, []);
});

test("an entry from before tabs were recorded shares its opener's tab", () => {
  const state = stateOf([
    ["a", entry({ session: "one", opened: 0, tab: null })],
    ["b", entry({ session: "two", opened: 2 })],
    ["c", entry({ session: "three", opened: 3 })],
  ]);
  const evicted = documentsToEvict(state, {
    key: "new",
    anchor: "code",
    tabId: "tab-1",
    live: live("one", "two", "three"),
  });
  assert.equal(evicted.length, 1);
  assert.equal(evicted[0][1].session, "one", "the legacy entry sorts oldest");
});

test("a legacy entry opened from another session is left alone", () => {
  const state = stateOf([
    ["a", entry({ session: "one", opened: 0, tab: null, anchor: "someone-else" })],
    ["b", entry({ session: "two", opened: 2 })],
    ["c", entry({ session: "three", opened: 3 })],
  ]);
  const evicted = documentsToEvict(state, {
    key: "new",
    anchor: "code",
    tabId: "tab-1",
    live: live("one", "two", "three"),
  });
  assert.deepEqual(evicted, [], "it cannot be proved to be in this tab");
});

test("an unknown tab closes nothing", () => {
  const state = stateOf([
    ["a", entry({ session: "one", opened: 1 })],
    ["b", entry({ session: "two", opened: 2 })],
    ["c", entry({ session: "three", opened: 3 })],
  ]);
  const evicted = documentsToEvict(state, {
    key: "new",
    anchor: "code",
    tabId: null,
    live: live("one", "two", "three"),
  });
  assert.deepEqual(evicted, []);
});

test("a tab far over budget is brought back to the budget in one pass", () => {
  const pairs = [];
  for (let index = 0; index < 8; index += 1) {
    pairs.push([`k${index}`, entry({ session: `s${index}`, opened: index })]);
  }
  const state = stateOf(pairs);
  const evicted = documentsToEvict(state, {
    key: "new",
    anchor: "code",
    tabId: "tab-1",
    live: live(...pairs.map(([, value]) => value.session)),
  });
  assert.equal(evicted.length, 8 - (DOCUMENTS_PER_TAB - 1));
  assert.deepEqual(
    evicted.map(([, value]) => value.session),
    ["s0", "s1", "s2", "s3", "s4", "s5"],
  );
});
