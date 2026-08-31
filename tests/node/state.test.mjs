import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  StateError,
  decodeState,
  emptyState,
  pruneState,
  readState,
  withStateLock,
  writeStateAtomic,
} from "../../src/node/state.mjs";

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "iterm-pane-state-"));
}

test("missing state starts empty", () => {
  const statePath = path.join(temporaryDirectory(), "state.json");
  assert.deepEqual(readState(statePath), { state: emptyState(), migrated: false });
});

test("invalid JSON fails loudly", () => {
  assert.throws(() => decodeState("{"), StateError);
});

test("legacy state migrates without queue fields", () => {
  const legacy = {
    "anchor::file:///doc.html": {
      anchor: "anchor",
      url: "file:///doc.html",
      profile: "pane doc",
      session: "browser",
      pending: false,
      guid: "old-guid",
    },
  };
  const loaded = decodeState(JSON.stringify(legacy));
  assert.equal(loaded.migrated, true);
  assert.deepEqual(loaded.state.documents["anchor::file:///doc.html"], {
    anchor: "anchor",
    url: "file:///doc.html",
    profile: "pane doc",
    session: "browser",
  });
});

test("atomic write leaves valid state and no temporary files", () => {
  const directory = temporaryDirectory();
  const statePath = path.join(directory, "state.json");
  const state = emptyState();
  state.documents.key = {
    anchor: "anchor",
    url: "file:///doc.html",
    profile: "pane doc",
    session: "browser",
  };
  writeStateAtomic(statePath, state);
  assert.deepEqual(readState(statePath).state, state);
  assert.deepEqual(fs.readdirSync(directory), ["state.json"]);
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
});

test("lock cannot be stolen from a live owner", () => {
  const statePath = path.join(temporaryDirectory(), "state.json");
  withStateLock(statePath, () => {
    assert.throws(
      () => withStateLock(statePath, () => {}, { timeoutMs: 20, staleMs: 1 }),
      /state lock was held/,
    );
  });
  withStateLock(statePath, () => {});
});

test("pruning removes dead anchors and browser sessions", () => {
  const state = emptyState();
  state.documents.live = {
    anchor: "a",
    url: "file:///live.html",
    profile: "live",
    session: "b",
  };
  state.documents.dead = {
    anchor: "a",
    url: "file:///dead.html",
    profile: "dead",
    session: "c",
  };
  assert.equal(pruneState(state, new Set(["a", "b"])), true);
  assert.deepEqual(Object.keys(state.documents), ["live"]);
});
