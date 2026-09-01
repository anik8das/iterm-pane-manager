import assert from "node:assert/strict";
import test from "node:test";

import { fillDiagrams, markdownToBody } from "../../src/node/markdown.mjs";

const body = async (markdown) => (await markdownToBody(markdown)).body;
const title = async (markdown) => (await markdownToBody(markdown)).title;

test("frontmatter is dropped, not rendered as a rule plus a heading", async () => {
  const html = await body(
    "---\nid: 24-takes-the-release\nwave: 9\ndepends_on: [23-the-release]\n---\n\n**Gap.** the body survives.\n",
  );
  assert.doesNotMatch(html, /<hr>|<h2>|depends_on/);
  assert.match(html, /<strong>Gap\.<\/strong> the body survives\./);
});

test("frontmatter is still recognised after a stray leading blank line", async () => {
  assert.equal(await body("\n\n---\nid: x\n---\n\nbody\n"), "<p>body</p>");
});

test("TOML frontmatter is dropped too", async () => {
  assert.equal(await body('+++\ntitle = "x"\n+++\n\nbody\n'), "<p>body</p>");
});

test("an unterminated frontmatter fence degrades visibly, swallowing nothing", async () => {
  // No closing fence means no frontmatter, so the block renders as it always
  // did. The failure that matters is losing the rest of the file; that is what
  // this pins down.
  const html = await body("---\nid: x\n\n# Title\n\nbody\n");
  assert.match(html, /<hr>/);
  assert.match(html, /<p>id: x<\/p>/);
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<p>body<\/p>/);
});

test("a document opening with a thematic break loses its first block", async () => {
  // Known and shared with every frontmatter-aware renderer: an opening "---"
  // is a fence, not a rule. Pinned so the trade-off stays deliberate.
  assert.equal(await body("---\n\nA note.\n\n---\n\n# Real Title\n"), "<h1>Real Title</h1>");
  // A rule anywhere else is untouched.
  assert.match(await body("# Real Title\n\nbefore\n\n---\n\nafter\n"), /<hr>/);
});

test("the title comes from the first real top-level heading", async () => {
  const cases = [
    ["---\n# generated, do not edit\n---\n\n# Real Title\n", "Real Title"],
    ["```bash\n# install the thing\n```\n\n# Real Title\n", "Real Title"],
    ["Real Title\n==========\n\nbody\n", "Real Title"],
    ["# The `pane` tool\n", "The pane tool"],
    // An empty or image-only heading is a masthead, not a title; keep looking.
    ["# \n\nintro\n\n# Real Title\n", "Real Title"],
    ["# ![logo](x.png)\n\n# Real Title\n", "Real Title"],
    // An image beside real text still yields the text.
    ["# ![](x.png) Getting Started\n", "Getting Started"],
    // A heading quoted inside a blockquote or list is someone else's title.
    ["> # Quoted\n\n# Actual Title\n", "Actual Title"],
    ["- # Listed\n\n# Actual Title\n", "Actual Title"],
    ["## Sub\n\nbody\n", ""],
  ];
  for (const [markdown, expected] of cases) {
    assert.equal(await title(markdown), expected, markdown);
  }
});

test("a Mermaid block survives as a placeholder the caller can fill", async () => {
  const { body: html, charts } = await markdownToBody(
    "before\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nafter\n",
  );
  assert.deepEqual(charts, ["flowchart LR\n  A --> B"]);
  assert.match(html, /<div class="diagram" data-index="0"><\/div>/);
  assert.match(fillDiagrams(html, (index) => `<svg data-i="${index}"/>`), /<svg data-i="0"\/>/);
});

test("raw HTML in the source is still stripped, whatever its case", async () => {
  for (const raw of ["<script>bad()</script>", "<SCRIPT>bad()</SCRIPT>"]) {
    assert.doesNotMatch(await body(`${raw}\n\n# Title\n`), /<script>/i);
  }
});
