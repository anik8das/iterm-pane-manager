import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { foregroundLaunch } from "../../agent/foreground.mjs";

const visible = { terminal: true, anchor: "w0t1p0:own-tab" };
test("visible interactive launches retain their own terminal execution", () => {
  for (const args of [[], ["hello"], ["resume", "--last"], ["fork", "--last"], ["-m", "configured-model", "hello"], ["--config=x=1", "hello"]]) {
    assert.equal(foregroundLaunch(args, visible), true, JSON.stringify(args));
  }
});
test("service, remote, help, and explicit execution choices remain unchanged", () => {
  for (const args of [["agents"], ["exec", "hello"], ["review"], ["app-server"], ["remote-control"], ["--remote=unix://", "resume"], ["--remote", "unix://"], ["--no-daemon"], ["--help"], ["resume", "--help"], ["fork", "--help"], ["--version"], ["--unknown-option", "exec"]]) {
    assert.equal(foregroundLaunch(args, visible), false, JSON.stringify(args));
  }
  assert.equal(foregroundLaunch([], { terminal: false, anchor: "inherited" }), false);
  assert.equal(foregroundLaunch([], { terminal: true, anchor: "" }), false);
});

test("launcher install is idempotent, preserves symlinks, and removes byte-exactly", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pane-foreground-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = path.join(directory, "real-zshrc");
  const rc = path.join(directory, "zshrc");
  const records = path.join(directory, "records");
  fs.writeFileSync(original, "# owned shell setup without final newline");
  fs.symlinkSync(original, rc);
  const run = (action) => spawnSync(process.execPath, [path.resolve("agent/install-foreground.mjs"), action, rc, records], { encoding: "utf8" });
  assert.equal(run("install").status, 0);
  const first = fs.readFileSync(rc, "utf8");
  assert.equal(run("install").status, 0);
  assert.equal(fs.readFileSync(rc, "utf8"), first);
  assert.equal(run("remove").status, 0);
  assert.equal(fs.readFileSync(rc, "utf8"), "# owned shell setup without final newline");
  assert.equal(fs.lstatSync(rc).isSymbolicLink(), true);
});

test("launcher installation preserves foreign definitions and malformed markers", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pane-foreground-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const rc = path.join(directory, "zshrc");
  for (const source of ["codex() { existing-command; }\n", "# iterm-pane-manager:foreground:begin\nuser content\n"]) {
    fs.writeFileSync(rc, source);
    const result = spawnSync(process.execPath, [path.resolve("agent/install-foreground.mjs"), "install", rc, path.join(directory, "records")], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(fs.readFileSync(rc, "utf8"), source);
  }
});

test("removing an absent launcher forgets obsolete restoration records", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pane-foreground-records-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const rc = path.join(directory, "zshrc");
  const records = path.join(directory, "records");
  const run = (action) => spawnSync(process.execPath, [path.resolve("agent/install-foreground.mjs"), action, rc, records], { encoding: "utf8" });
  for (const [original, replacement] of [["# obsolete startup file\n", null], [null, null], ["# obsolete startup file\n", "# manually replaced startup file\n"]]) {
    fs.rmSync(rc, { force: true });
    if (original !== null) fs.writeFileSync(rc, original);
    assert.equal(run("install").status, 0);
    if (replacement === null) fs.unlinkSync(rc);
    else fs.writeFileSync(rc, replacement);
    assert.equal(run("remove").status, 0);
    assert.deepEqual(fs.readdirSync(records), []);
    const fresh = "# fresh startup file without final newline";
    fs.writeFileSync(rc, fresh);
    assert.equal(run("install").status, 0);
    assert.equal(run("remove").status, 0);
    assert.equal(fs.readFileSync(rc, "utf8"), fresh);
  }
});

test("classification still runs through the installed current-release symlink", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pane-release-link-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const link = path.join(directory, "foreground.mjs");
  fs.symlinkSync(path.resolve("agent/foreground.mjs"), link);
  const result = spawnSync(process.execPath, [link], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "unchanged\n");
});

test("a dangling startup-file symlink is preserved before any integration state is written", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pane-foreground-link-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const rc = path.join(directory, "zshrc");
  const destination = path.join(directory, "missing-target");
  const records = path.join(directory, "records");
  fs.symlinkSync(destination, rc);
  const result = spawnSync(process.execPath, [path.resolve("agent/install-foreground.mjs"), "install", rc, records], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(fs.readlinkSync(rc), destination);
  assert.equal(fs.existsSync(records), false);
  const removed = spawnSync(process.execPath, [path.resolve("agent/install-foreground.mjs"), "remove", rc, records], { encoding: "utf8" });
  assert.equal(removed.status, 0);
  assert.equal(fs.readlinkSync(rc), destination);
});

test("classifier failures remain visible and leave the underlying command available", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pane-classifier-failure-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const payload = path.join(directory, "payload");
  fs.mkdirSync(payload);
  const installer = path.join(payload, "install-foreground.mjs");
  fs.copyFileSync(path.resolve("agent/install-foreground.mjs"), installer);
  const rc = path.join(directory, "shellrc");
  const installed = spawnSync(process.execPath, [installer, "install", rc, path.join(directory, "records")]);
  assert.equal(installed.status, 0);
  fs.writeFileSync(path.join(directory, "codex"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  for (const scenario of ["missing classifier", "classifier exception", "missing node"]) {
    if (scenario !== "missing classifier") fs.writeFileSync(path.join(payload, "foreground.mjs"), 'throw new Error("classifier unavailable");\n');
    const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", 'source "$PANE_FIXTURE_RC"; codex "a prompt with spaces"'], {
      encoding: "utf8", env: { ...process.env, PANE_FIXTURE_RC: rc, PATH: scenario === "missing node" ? directory : `${directory}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "a prompt with spaces\n");
    assert.match(result.stderr, /foreground routing unavailable/, scenario);
  }
});

test("the installed shell function preserves arguments and distinguishes interactive from service use", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pane-launch-tty-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const rc = path.join(directory, "shellrc");
  const installed = spawnSync(process.execPath, [path.resolve("agent/install-foreground.mjs"), "install", rc, path.join(directory, "records")], { encoding: "utf8" });
  assert.equal(installed.status, 0);
  fs.writeFileSync(path.join(directory, "codex"), '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
  const probe = `import json, os, pty, subprocess, sys
master, slave = pty.openpty()
try:
    result = subprocess.run(["bash", "--noprofile", "--norc", "-c", 'source "$PANE_FIXTURE_RC"; codex "$@"', "fixture", *json.loads(sys.argv[1])], stdin=slave, capture_output=True, text=True, check=True)
    print(result.stdout.strip())
finally:
    os.close(master)
    os.close(slave)
`;
  for (const [args, expected] of [
    [["resume", "--last"], ["--no-daemon", "resume", "--last"]],
    [["exec", "a prompt with spaces"], ["exec", "a prompt with spaces"]],
    [["--remote=unix://", "resume"], ["--remote=unix://", "resume"]],
  ]) {
    const result = spawnSync("python3", ["-c", probe, JSON.stringify(args)], {
      encoding: "utf8", env: { ...process.env, PANE_FIXTURE_RC: rc, ITERM_SESSION_ID: "own-tab", PATH: `${directory}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
});
