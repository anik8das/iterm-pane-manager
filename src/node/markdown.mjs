import { toString as mdastToString } from "mdast-util-to-string";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { unified } from "unified";
import { EXIT, SKIP, visit } from "unist-util-visit";

// Kept in one file with fillDiagrams: emitting and consuming the placeholder
// are two halves of the same contract.
const PLACEHOLDER = /<div class="diagram" data-index="(\d+)"><\/div>/g;

// Frontmatter is only recognised at the very start of the document, so a stray
// leading blank line would otherwise render the whole block as a thematic
// break plus a setext heading. Leading blank lines produce no output anyway.
const LEADING_BLANK_LINES = /^(?:[ \t]*\r?\n)+/;

// Reading the title from the tree rather than the raw text keeps "# ..." lines
// inside code fences and frontmatter out of it. Only top-level headings count:
// a heading quoted inside a blockquote or list item is someone else's title.
function titleExtractor(holder) {
  return () => (tree) => {
    visit(tree, "heading", (node, _index, parent) => {
      if (node.depth !== 1 || parent?.type !== "root") return;
      const text = mdastToString(node).trim();
      if (!text) return;
      holder.text = text;
      return EXIT;
    });
  };
}

function mermaidExtractor(charts) {
  return () => (tree) => {
    visit(tree, "code", (node, index, parent) => {
      if (!parent || index === null || index === undefined) return;
      if ((node.lang ?? "").toLowerCase() !== "mermaid") return;
      const chartIndex = charts.push(node.value) - 1;
      // hName/hProperties rather than a raw `html` node: remark-rehype drops
      // raw HTML (which keeps untrusted markup out of the page), and would
      // drop the placeholder with it.
      parent.children[index] = {
        type: "paragraph",
        data: {
          hName: "div",
          hProperties: { className: ["diagram"], dataIndex: chartIndex },
        },
        children: [],
      };
      return SKIP;
    });
  };
}

// Converts Markdown to the page body, leaving one placeholder per Mermaid
// block. Frontmatter is parsed so it is dropped rather than rendered.
export async function markdownToBody(markdown) {
  const charts = [];
  const heading = {};
  const body = String(
    await unified()
      .use(remarkParse)
      .use(remarkFrontmatter, ["yaml", "toml"])
      .use(titleExtractor(heading))
      .use(mermaidExtractor(charts))
      .use(remarkGfm)
      .use(remarkRehype)
      .use(rehypeStringify)
      .process(markdown.replace(LEADING_BLANK_LINES, "")),
  );
  return { body, charts, title: heading.text ?? "" };
}

// Replaces each diagram placeholder with render(index).
export function fillDiagrams(body, render) {
  return body.replace(PLACEHOLDER, (_match, index) => render(Number(index)));
}
