import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { liveSessionIds, openDocument } from "../../src/node/runtime.mjs";

test("helpers do not create bytecode inside their source tree", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pane-readonly-helper-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "owned_module.py"), 'SESSION = "fixture"\n');
  fs.writeFileSync(path.join(directory, "sessions.py"), 'from owned_module import SESSION\nprint(SESSION)\n');
  const python = execFileSync(process.env.PYTHON || "python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
  assert.deepEqual([...liveSessionIds({ python, sessions: path.join(directory, "sessions.py") })], ["fixture"]);
  assert.equal(fs.existsSync(path.join(directory, "__pycache__")), false);
});

test("a timed-out document helper closes the pane named in its receipt", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "iterm-pane-runtime-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const document = path.join(directory, "document.mjs");
  const sessions = path.join(directory, "sessions.mjs");
  const cleanup = path.join(directory, "cleanup.log");

  fs.writeFileSync(
    sessions,
    `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(cleanup)}, process.argv.slice(2).join(" "));
`,
  );

  // Publish the receipt before injecting the timeout. Child startup latency
  // must not decide which cleanup state this test exercises.
  const originalExec = childProcess.execFileSync;
  const execute = t.mock.method(childProcess, "execFileSync", (python, args, options) => {
    if (args[0] !== document) return originalExec(python, args, options);
    assert.equal(options.timeout, 2_000);
    assert.equal(options.killSignal, "SIGKILL");
    fs.writeFileSync(args[args.indexOf("--receipt") + 1], "browser-partial");
    throw Object.assign(new Error("document helper ETIMEDOUT"), { code: "ETIMEDOUT" });
  });
  t.after(() => {
    execute.mock.restore();
    syncBuiltinESMExports();
  });
  syncBuiltinESMExports();
  assert.throws(
    () =>
      openDocument(
        { python: process.execPath, document, sessions },
        {
          anchor: "anchor-session",
          url: "file:///document.html",
          profile: "document",
          session: null,
        },
        { timeoutMs: 2_000, beforeSessionIds: new Set(["anchor-session"]) },
      ),
    /ETIMEDOUT/,
  );
  assert.equal(fs.readFileSync(cleanup, "utf8"), "close --session browser-partial");
});

test("a timeout before receipt publication recovers and closes the new pane", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "iterm-pane-runtime-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const document = path.join(directory, "document.mjs");
  const sessions = path.join(directory, "sessions.mjs");
  const cleanup = path.join(directory, "cleanup.log");
  const recovery = path.join(directory, "recovery.log");

  fs.writeFileSync(document, "setTimeout(() => {}, 5_000);\n");
  fs.writeFileSync(
    sessions,
    `import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "recover") {
  fs.writeFileSync(${JSON.stringify(recovery)}, args.join(" "));
  console.log("browser-before-receipt");
} else if (args[0] === "close") {
  fs.writeFileSync(${JSON.stringify(cleanup)}, args.join(" "));
}
`,
  );

  assert.throws(
    () =>
      openDocument(
        { python: process.execPath, document, sessions },
        {
          anchor: "anchor-session",
          url: "file:///document.html",
          profile: "pane document marker",
          session: null,
        },
        {
          timeoutMs: 100,
          beforeSessionIds: new Set(["anchor-session", "existing-session"]),
        },
      ),
    /ETIMEDOUT/,
  );
  assert.equal(
    fs.readFileSync(recovery, "utf8"),
    "recover --anchor anchor-session --profile pane document marker " +
      "--before anchor-session --before existing-session",
  );
  assert.equal(
    fs.readFileSync(cleanup, "utf8"),
    "close --session browser-before-receipt",
  );
});

test("a pane is kept when the person moved while it opened", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "iterm-pane-runtime-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const document = path.join(directory, "document.mjs");
  const sessions = path.join(directory, "sessions.mjs");
  const cleanup = path.join(directory, "cleanup.log");

  // The helper only returns when focus did not land on the document, so a
  // false `focus_unchanged` means the person moved, not that the tool did.
  fs.writeFileSync(
    document,
    `console.log(JSON.stringify({
  session: "browser-new",
  target_tab: "hidden-tab",
  elapsed: 0.4,
  focus_unchanged: false,
}));
`,
  );
  fs.writeFileSync(
    sessions,
    `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(cleanup)}, process.argv.slice(2).join(" "));
`,
  );

  const result = openDocument(
    { python: process.execPath, document, sessions },
    { anchor: "anchor-session", url: "file:///d.html", profile: "d", session: null },
    { beforeSessionIds: new Set(["anchor-session"]) },
  );

  assert.equal(result.session, "browser-new");
  assert.equal(result.focus_unchanged, false);
  assert.equal(fs.existsSync(cleanup), false, "nothing may be closed");
});

test("a helper that names no pane is still a failure", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "iterm-pane-runtime-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const document = path.join(directory, "document.mjs");
  const sessions = path.join(directory, "sessions.mjs");

  fs.writeFileSync(
    document,
    'console.log(JSON.stringify({ target_tab: "t", focus_unchanged: true }));\n',
  );
  fs.writeFileSync(sessions, "\n");

  assert.throws(
    () =>
      openDocument(
        { python: process.execPath, document, sessions },
        { anchor: "anchor-session", url: "file:///d.html", profile: "d", session: null },
        { beforeSessionIds: new Set(["anchor-session"]) },
      ),
    /did not report the pane it created/,
  );
});
