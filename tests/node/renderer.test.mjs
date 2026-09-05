import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const renderer = path.join(root, "bin/mdrender.mjs");

function render(t, markdown, name = "document.md") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "iterm-pane-render-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, name);
  fs.writeFileSync(source, markdown);
  const output = execFileSync(process.execPath, [renderer, source, "--no-open"], {
    encoding: "utf8",
  }).trim();
  return fs.readFileSync(output, "utf8");
}

test("renderer writes self-contained HTML with safe raw markup", (t) => {
  const html = render(
    t,
    "# Safe title </title><script>bad()</script>\n\n<script>bad()</script>\n\n```text\ncopy me\n```\n",
  );
  assert.match(html, /button\.className="copy-button"/);
  assert.doesNotMatch(html, /<script>bad\(\)<\/script>/);
  assert.match(
    html,
    /<title>Safe title &lt;\/title&gt;&lt;script&gt;bad\(\)&lt;\/script&gt;<\/title>/,
  );
});

test("a document with no heading is titled by its file name", (t) => {
  const html = render(t, "---\nid: x\n---\n\nbody\n", "24-takes-the-release.md");
  assert.match(html, /<title>24-takes-the-release<\/title>/);
});

test("an uppercase .MD extension is stripped from the fallback title", (t) => {
  const html = render(t, "body\n", "NOTES.MD");
  assert.match(html, /<title>NOTES<\/title>/);
});

test("a Mermaid diagram reaches the page as inline SVG", (t) => {
  const html = render(t, "# Chart\n\n```mermaid\nflowchart LR\n  A --> B\n```\n");
  assert.match(html, /<figure class="diagram">/);
  assert.match(html, /<svg/);
  assert.doesNotMatch(html, /diagram error/);
  assert.doesNotMatch(html, /data-index/);
});

test("a malformed Mermaid block becomes a visible error", (t) => {
  const html = render(t, "# Chart\n\n```mermaid\nnot a diagram\n```\n");
  assert.match(html, /<div class="diagram error">/);
  assert.match(html, /Invalid mermaid header/);
});
