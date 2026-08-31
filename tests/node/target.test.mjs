import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { closeCandidates, normalizeUrl, resolveTarget } from "../../src/node/target.mjs";

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "iterm-pane-target-"));
}

function fixture(name, content = "test") {
  const directory = temporaryDirectory();
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

test("local paths become correctly encoded file URLs", () => {
  const filePath = fixture("a document.html");
  const url = normalizeUrl(filePath);
  assert.equal(fileURLToPath(url), filePath);
});

test("missing files fail before iTerm2 is called", () => {
  assert.throws(() => normalizeUrl("/definitely/missing/document.html"), /no such file/);
});

test("Markdown close accepts source and rendered URLs", () => {
  const filePath = fixture("document.md");
  const candidates = closeCandidates(filePath);
  assert.equal(candidates.length, 2);
  assert.equal(fileURLToPath(candidates[1]), filePath.replace(/\.md$/, ".html"));
});

test("close still resolves a document after its source was deleted", () => {
  const missing = path.join(temporaryDirectory(), "deleted.md");
  const candidates = closeCandidates(missing);
  assert.equal(fileURLToPath(candidates[0]), missing);
  assert.equal(fileURLToPath(candidates[1]), missing.replace(/\.md$/, ".html"));
});

test("raw Markdown skips rendering", () => {
  const filePath = fixture("document.md", "# Document\n");
  assert.equal(fileURLToPath(resolveTarget(filePath, { raw: true })), filePath);
});
