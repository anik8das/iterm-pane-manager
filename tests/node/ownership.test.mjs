import assert from "node:assert/strict";
import test from "node:test";
import { resolveOwnership } from "../../src/node/ownership.mjs";

const neverFind = () => { throw new Error("must not resolve another terminal"); };
test("an expired explicit address is refused even when another terminal is known", () => {
  assert.throws(() => resolveOwnership("expired", { explicit: true, caller: "ttys001", status: { exists: false }, find: neverFind }), /explicit.*expired/);
});
test("a restored foreground terminal is recovered by its unique verified device", () => {
  const actual = { exists: true, session: "restored", tty: "/dev/ttys004" };
  const result = resolveOwnership("before-restart", { explicit: false, caller: "ttys004", status: { exists: false }, find: () => actual });
  assert.equal(result.anchor, "restored");
});
test("a stale address for a different live tab cannot redirect a foreground caller", () => {
  const result = resolveOwnership("other-tab", { caller: "ttys004", status: { exists: true, tty: "/dev/ttys005" }, find: () => ({ exists: true, session: "own-tab", tty: "/dev/ttys004" }) });
  assert.equal(result.anchor, "own-tab");
});
test("detached, ambiguous, and mismatched callers cannot claim a live tab", () => {
  for (const [caller, found] of [["", null], ["ttys004", { exists: false, ambiguous: true }], ["ttys004", { exists: true, session: "wrong", tty: "ttys005" }]]) {
    assert.throws(() => resolveOwnership("expired", { caller, status: { exists: false }, find: () => found }), /could not verify/);
  }
});
test("a denied process probe retains the existing valid-address policy without recovering an expired one", () => {
  assert.equal(resolveOwnership("known", { caller: null, status: { exists: true }, find: neverFind }).anchor, "known");
  assert.throws(() => resolveOwnership("expired", { caller: null, status: { exists: false }, find: neverFind }), /could not verify/);
});
