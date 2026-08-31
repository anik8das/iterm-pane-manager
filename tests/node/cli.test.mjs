import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const cli = path.join(root, "bin/pane.mjs");

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ITERM_SESSION_ID: "" },
  });
}

test("help is available without an iTerm2 connection", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /exact tab/);
});

test("removed duplicate mode fails clearly", () => {
  const result = run(["document.md", "--new"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--new was removed/);
});

test("opening outside iTerm2 fails before rendering", () => {
  const result = run(["document.md"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ITERM_SESSION_ID is missing/);
});
