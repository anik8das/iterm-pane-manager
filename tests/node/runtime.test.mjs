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
        { timeoutMs: 100 },
      ),
    /ETIMEDOUT/,
  );
  assert.ok(Date.now() - started < 2_000, "the timeout must remain bounded");
  assert.equal(fs.readFileSync(cleanup, "utf8"), "close --session browser-partial");
});
