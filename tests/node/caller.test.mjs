import assert from "node:assert/strict";
import test from "node:test";

import { callerTty, nearestTty, parseProcessTable } from "../../src/node/caller.mjs";

const LISTING = `
  4100  4090 ??
  4090  4080 ??
  4080  4001 ttys012
  4001     1 ttys012
     1     0 ??
  5000     1 ??
`;

test("a process listing becomes a parent and terminal lookup", () => {
  const table = parseProcessTable(LISTING);
  assert.equal(table.size, 6);
  assert.deepEqual(table.get(4090), { ppid: 4080, tty: "??" });
});

test("the terminal is taken from the nearest ancestor that has one", () => {
  // A tool-running agent starts commands without a terminal of their own.
  assert.equal(nearestTty(parseProcessTable(LISTING), 4100), "ttys012");
});

test("a process that has its own terminal answers for itself", () => {
  assert.equal(nearestTty(parseProcessTable(LISTING), 4080), "ttys012");
});

test("a detached process reaches the init process without finding one", () => {
  assert.equal(nearestTty(parseProcessTable(LISTING), 5000), "");
});

test("an unknown process has no terminal", () => {
  assert.equal(nearestTty(parseProcessTable(LISTING), 9999), "");
});

test("a parent cycle cannot spin forever", () => {
  const table = parseProcessTable("  10  11 ??\n  11  10 ??\n");
  assert.equal(nearestTty(table, 10), "");
});

test("garbage lines are ignored rather than trusted", () => {
  const table = parseProcessTable("not a row\n\n  7  6 ttys003\n");
  assert.deepEqual([...table.keys()], [7]);
});

test("the live lookup answers with a terminal or with nothing", () => {
  // It must never throw. Either it places the call or it reports that it
  // could not, and both are answers a caller can act on.
  const answer = callerTty();
  assert.ok(answer === null || typeof answer === "string");
});

test("a lookup that cannot run reports null, never \"no terminal\"", () => {
  // A sandbox that denies process information makes the lookup fail outright.
  // Reading that as "no terminal" would refuse every caller inside one.
  const saved = process.env.PATH;
  process.env.PATH = "";
  try {
    assert.equal(callerTty(), null);
  } finally {
    process.env.PATH = saved;
  }
});
