import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const cli = path.join(root, "bin/pane.mjs");

// No test may reach iTerm2 or the real state file. Pointing the helper at a
// Python that cannot exist stops every command that would, on any machine,
// before it closes a pane or resizes a tab someone is using. The state path
// comes from the home directory, and a command that names no tab still takes
// the lock and rewrites the file, so each child gets a home of its own.
const NO_PYTHON = path.join(root, "tests/node/no-such-python");

function run(args, session = "", extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "iterm-pane-home-"));
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      ITERM_SESSION_ID: session,
      PANE_ANCHOR: "",
      ITERM_PANE_PYTHON: NO_PYTHON,
      ...extra,
    },
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

test("a position prefix carrying no session ID is refused", () => {
  const result = run(["document.md"], "w0t1p2:");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ITERM_SESSION_ID is missing/);
});

test("a refused open renders nothing and leaves no output beside the source", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "iterm-pane-cli-"));
  const source = path.join(directory, "document.md");
  fs.writeFileSync(source, "# Document\n");
  const result = run([source]);
  assert.equal(result.status, 1);
  assert.deepEqual(fs.readdirSync(directory), ["document.md"]);
});

test("an explicit anchor supplies the tab when the variable is absent", () => {
  // It must get past the address gate. What it fails on next depends on
  // whether iTerm2 is reachable, which a test must not depend on.
  const result = run(["document.md"], "", { PANE_ANCHOR: "w0t1p2:explicit" });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /ITERM_SESSION_ID is missing/);
});

test("the usage text says a detached process is refused", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /detached from that tab is refused/);
  assert.match(result.stdout, /PANE_ANCHOR/);
});

test("a command with no tab to address does not pay for an ownership check", () => {
  // Outside iTerm2 there is no anchor, so nothing is asked about it.
  const result = run(["--close-all"]);
  assert.doesNotMatch(result.stderr, /no iTerm2 session/);
  assert.doesNotMatch(result.stderr, /not in the tab named by/);
});

test("a tab that has closed is refused before either way out of the check", () => {
  // Naming a tab deliberately, or being unable to place the caller, says
  // nothing about whether the tab is still there. Both returns come after.
  const source = fs.readFileSync(cli, "utf8");
  const body = source.slice(source.indexOf("function requireOwnership"));
  const guard = body.indexOf("status.exists");
  assert.ok(guard > 0 && guard < body.indexOf("process.env.PANE_ANCHOR"));
  assert.ok(guard < body.indexOf("callerTty()"));
});

test("ownership is settled before any Markdown is rendered", () => {
  // Asserted on the source because whether the check engages depends on the
  // machine: a sandbox that hides the process table skips it. The order it
  // runs in must not depend on that, and the guarantee is documented.
  const source = fs.readFileSync(cli, "utf8");
  const body = source.slice(source.indexOf("function openTarget"));
  assert.ok(
    body.indexOf("requireOwnership(anchor)") < body.indexOf("resolveTarget("),
    "requireOwnership must run before resolveTarget",
  );
});

