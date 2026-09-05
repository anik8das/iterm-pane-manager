import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDocument } from "../../src/node/runtime.mjs";

test("a timed-out document helper closes the pane named in its receipt", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "iterm-pane-runtime-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const document = path.join(directory, "document.mjs");
  const sessions = path.join(directory, "sessions.mjs");
  const cleanup = path.join(directory, "cleanup.log");

  fs.writeFileSync(
    document,
    `import fs from "node:fs";
const args = process.argv.slice(2);
const receipt = args[args.indexOf("--receipt") + 1];
fs.writeFileSync(receipt, "browser-partial");
setTimeout(() => {}, 5_000);
`,
  );
  fs.writeFileSync(
    sessions,
    `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(cleanup)}, process.argv.slice(2).join(" "));
`,
  );

  const started = Date.now();
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
        { timeoutMs: 100, beforeSessionIds: new Set(["anchor-session"]) },
      ),
    /ETIMEDOUT/,
  );
  assert.ok(Date.now() - started < 2_000, "the timeout must remain bounded");
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
