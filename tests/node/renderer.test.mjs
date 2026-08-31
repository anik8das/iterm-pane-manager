import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const renderer = path.join(root, "bin/mdrender.mjs");

test("renderer writes self-contained HTML with safe raw markup", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "iterm-pane-render-"));
  const source = path.join(directory, "document.md");
  fs.writeFileSync(
    source,
    "# Safe title </title><script>bad()</script>\n\n<script>bad()</script>\n\n```text\ncopy me\n```\n",
  );
  const output = execFileSync(process.execPath, [renderer, source, "--no-open"], {
    encoding: "utf8",
  }).trim();
  const html = fs.readFileSync(output, "utf8");
  assert.match(html, /button\.className="copy-button"/);
  assert.doesNotMatch(html, /<script>bad\(\)<\/script>/);
  assert.match(
    html,
    /<title>Safe title &lt;\/title&gt;&lt;script&gt;bad\(\)&lt;\/script&gt;<\/title>/,
  );
});
