import assert from "node:assert/strict";
import test from "node:test";

import { renderDiagrams } from "../../src/node/diagram.mjs";

test("supported diagram types render to self-contained inline SVG", () => {
  const charts = [
    'flowchart LR\n  A["Start"] --> B["Done"]',
    "sequenceDiagram\n  participant A as Agent\n  participant P as pane\n  A->>P: Open document",
    "stateDiagram-v2\n  [*] --> Ready\n  Ready --> Done: render",
    "classDiagram\n  Animal <|-- Duck",
    "erDiagram\n  CUSTOMER ||--o{ ORDER : places",
    "xychart-beta\n  x-axis [one, two]\n  bar [1, 2]",
  ];
  const results = renderDiagrams(charts);
  assert.equal(results.length, charts.length);
  for (const result of results) {
    assert.match(result.svg, /^<svg[\s>]/);
    assert.doesNotMatch(result.svg, /@import|fonts\.googleapis\.com/);
  }
});

test("diagram labels cannot inject markup", () => {
  const [result] = renderDiagrams([
    'flowchart LR\n  A["<script>alert(1)</script>"] --> B["safe"]',
  ]);
  assert.doesNotMatch(result.svg, /<script/i);
  assert.match(result.svg, /&lt;script&gt;/);
});

test("multiple inline diagrams do not reuse SVG identifiers", () => {
  const results = renderDiagrams([
    "flowchart LR\n  A --> B",
    "flowchart LR\n  C --> D",
  ]);
  assert.match(results[0].svg, /id="pane-diagram-0-arrowhead"/);
  assert.match(results[0].svg, /url\(#pane-diagram-0-arrowhead\)/);
  assert.match(results[1].svg, /id="pane-diagram-1-arrowhead"/);
  assert.match(results[1].svg, /url\(#pane-diagram-1-arrowhead\)/);
  const ids = results.flatMap((result) =>
    Array.from(result.svg.matchAll(/\bid="([^"]+)"/g), (match) => match[1]),
  );
  assert.equal(new Set(ids).size, ids.length);
});

test("a malformed diagram becomes a visible per-diagram error", () => {
  const [result] = renderDiagrams(["not a diagram"]);
  assert.equal(typeof result.error, "string");
  assert.ok(result.error.length > 0);
});
