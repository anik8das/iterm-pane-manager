import { renderMermaidSVG } from "beautiful-mermaid";

function namespaceIds(svg, index) {
  const ids = new Map();
  const prefixed = svg.replace(/\bid="([^"]+)"/g, (match, id) => {
    const replacement = `pane-diagram-${index}-${id}`;
    ids.set(id, replacement);
    return `id="${replacement}"`;
  });
  return prefixed
    .replace(/url\(#([^)]+)\)/g, (match, id) =>
      ids.has(id) ? `url(#${ids.get(id)})` : match,
    )
    .replace(/\b(xlink:href|href)="#([^"]+)"/g, (match, attribute, id) =>
      ids.has(id) ? `${attribute}="#${ids.get(id)}"` : match,
    );
}

export function renderDiagrams(charts) {
  return charts.map((source, index) => {
    try {
      const svg = renderMermaidSVG(source, {
        bg: "#fbfcfd",
        fg: "#1c2024",
        accent: "#2f6feb",
        font: "system-ui",
        transparent: true,
      });
      return {
        // The renderer estimates text locally but includes an optional remote
        // font import. The page uses system fonts, so remove that network
        // request and keep the generated document self-contained.
        svg: namespaceIds(
          svg.replace(/^\s*@import url\([^\n]+\);\s*$/gm, ""),
          index,
        ),
      };
    } catch (error) {
      return { error: (error.message || String(error)).split("\n")[0] };
    }
  });
}
