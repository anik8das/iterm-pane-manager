import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { normalizeTty, ownsAnchor, parseAnchor } from "../../src/node/anchor.mjs";

test("the position prefix is dropped and the stable ID kept", () => {
  assert.equal(parseAnchor("w0t1p2:2F8A1C3D-0000-4000-8000-000000000001"), "2F8A1C3D-0000-4000-8000-000000000001");
});

test("a value with no prefix is taken as the ID", () => {
  assert.equal(parseAnchor("2F8A1C3D-0000-4000-8000-000000000001"), "2F8A1C3D-0000-4000-8000-000000000001");
});

test("an absent variable yields no anchor", () => {
  assert.equal(parseAnchor(undefined), "");
  assert.equal(parseAnchor(""), "");
});

test("a prefix with no ID yields no anchor", () => {
  assert.equal(parseAnchor("w0t1p2:"), "");
});

test("only the final segment is the ID", () => {
  assert.equal(parseAnchor("w0t1p2:extra:final"), "final");
});

test("surrounding whitespace is kept, so a padded value cannot match a session", () => {
  // Pinned deliberately: a padded value must fail to locate a session rather
  // than be trimmed into a neighbouring one.
  assert.equal(parseAnchor("w0t1p2:padded "), "padded ");
});

test("the anchor is read from the value alone, never from the calling process", () => {
  // The delivery rule must stay a pure parse. If a caller-identity check is
  // ever added it belongs beside this rule, and this assertion should be
  // replaced by one that states the new rule.
  const source = fs.readFileSync(
    path.join(import.meta.dirname, "../../src/node/anchor.mjs"),
    "utf8",
  );
  for (const forbidden of ["process.env", "process.ppid", "ctermid", "ttyname", "execSync"]) {
    assert.equal(source.includes(forbidden), false, `${forbidden} must not decide the anchor`);
  }
});

test("a terminal is the same terminal with or without its device prefix", () => {
  assert.equal(normalizeTty("/dev/ttys012"), "ttys012");
  assert.equal(normalizeTty("ttys012"), "ttys012");
});

test("no terminal at all reads as unknown", () => {
  assert.equal(normalizeTty("??"), "");
  assert.equal(normalizeTty("-"), "");
  assert.equal(normalizeTty(null), "");
  assert.equal(normalizeTty("  "), "");
});

test("a caller on the tab's own terminal owns it", () => {
  assert.equal(ownsAnchor("ttys012", "/dev/ttys012"), true);
});

test("a caller with no terminal above it owns nothing", () => {
  // The detached background process this guard exists for.
  assert.equal(ownsAnchor("", "/dev/ttys012"), false);
  assert.equal(ownsAnchor("??", "/dev/ttys012"), false);
});

test("a caller on a different terminal is refused", () => {
  // A stale address from another tab, or a shell inside a multiplexer.
  assert.equal(ownsAnchor("ttys004", "/dev/ttys012"), false);
});

test("a tab that reports no terminal cannot be owned", () => {
  // Browser panes have no terminal, so nothing may claim to be running in one.
  assert.equal(ownsAnchor("ttys012", null), false);
  assert.equal(ownsAnchor("", null), false);
});
