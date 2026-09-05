#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { renderDiagrams } from "../src/node/diagram.mjs";
import { fillDiagrams, markdownToBody } from "../src/node/markdown.mjs";

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function writeAtomic(output, content) {
  const temporary = path.join(
    path.dirname(output),
    `.${path.basename(output)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, content, { mode: 0o644 });
    fs.renameSync(temporary, output);
  } catch (error) {
    let cleanupError;
    try {
      fs.unlinkSync(temporary);
    } catch (caught) {
      if (caught.code !== "ENOENT") cleanupError = caught;
    }
    if (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "render output and cleanup failed",
        { cause: error },
      );
    }
    throw error;
  }
}

function pageTemplate(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{--bg:#fff;--fg:#1c2024;--muted:#5b6470;--line:#e3e6ea;--card:#f7f9fb;--accent:#2f6feb;--code:#f2f4f7}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--fg:#dfe3e8;--muted:#98a2b0;--line:#252b33;--card:#161b21;--accent:#7aa2f7;--code:#161b21}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:900px;margin:0 auto;padding:48px 28px 96px}
h1{font-size:2rem;line-height:1.2;margin:0 0 .6em;letter-spacing:-.02em}
h2{font-size:1.35rem;margin:2.4em 0 .7em;padding-top:.9em;border-top:1px solid var(--line)}
h3{font-size:1.08rem;margin:1.8em 0 .5em}
li{margin:.25em 0}strong{font-weight:650}a{color:var(--accent)}
code{font:.87em ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);padding:.15em .4em;border-radius:4px}
pre{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;overflow-x:auto}
pre code{background:none;padding:0;font-size:.85rem;line-height:1.55}
blockquote{margin:1.2em 0;padding:.2em 1.1em;border-left:3px solid var(--line);color:var(--muted)}
.table-wrap{overflow-x:auto;margin:1.3em 0}
table{border-collapse:collapse;width:100%;font-size:.94rem}
th,td{padding:9px 16px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-weight:650;color:var(--muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}
tbody tr:last-child td{border-bottom:none}tbody tr:hover{background:var(--card)}
figure.diagram{margin:1.6em 0}.diagram-scroll{overflow-x:auto;background:#fbfcfd;border:1px solid var(--line);border-radius:12px;padding:22px;display:flex;justify-content:safe center;color:#1c2024}
.diagram-scroll svg{max-width:none;height:auto;flex:none}.diagram-scroll svg text{fill:#1c2024}
.diagram.error{background:#ffe9e9;color:#8a1f1f;padding:14px;border-radius:8px;font-family:monospace;font-size:.85rem}
.codeblock{position:relative;margin:1.3em 0}.codeblock pre{margin:0}
.copy-button{position:absolute;top:8px;right:8px;font:600 .7rem/1 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:6px 10px;cursor:pointer;opacity:.5}
.codeblock:hover .copy-button,.copy-button:focus-visible{opacity:1}.copy-button.ok{color:#1a7f37;border-color:#1a7f37;opacity:1}.copy-button.bad{color:#b3261e;border-color:#b3261e;opacity:1}
hr{border:none;border-top:1px solid var(--line);margin:2.4em 0}
</style>
</head>
<body><main>${body}</main>
<script>
document.querySelectorAll("table").forEach(function(table){var wrap=document.createElement("div");wrap.className="table-wrap";table.replaceWith(wrap);wrap.appendChild(table)});
document.querySelectorAll("pre").forEach(function(pre){
  var wrap=document.createElement("div");wrap.className="codeblock";pre.replaceWith(wrap);wrap.appendChild(pre);
  var button=document.createElement("button");button.className="copy-button";button.type="button";button.textContent="Copy";button.setAttribute("aria-label","Copy code block to clipboard");
  button.addEventListener("click",function(){
    var code=pre.querySelector("code");var text=code?code.textContent:pre.textContent;
    function flash(ok){button.textContent=ok?"Copied":"Failed";button.classList.add(ok?"ok":"bad");setTimeout(function(){button.textContent="Copy";button.classList.remove("ok","bad")},1400)}
    function fallback(){try{var area=document.createElement("textarea");area.value=text;area.setAttribute("readonly","");area.style.position="fixed";area.style.top="-1000px";document.body.appendChild(area);area.select();var ok=document.execCommand("copy");document.body.removeChild(area);flash(ok)}catch(error){flash(false)}}
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(function(){flash(true)},fallback)}else{fallback()}
  });
  wrap.appendChild(button);
});
</script>
</body>
</html>
`;
}

async function main(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: mdrender <file.md> [--no-open]");
    return 0;
  }
  const sourceArgument = args.find((argument) => !argument.startsWith("-"));
  if (!sourceArgument) throw new Error("usage: mdrender <file.md> [--no-open]");
  const source = path.resolve(sourceArgument);
  if (!fs.existsSync(source)) throw new Error(`no such file: ${source}`);
  if (!source.toLowerCase().endsWith(".md")) throw new Error("input must end in .md");

  const markdown = fs.readFileSync(source, "utf8");
  const { body: rawBody, charts, title: heading } = await markdownToBody(markdown);
  const diagrams = await renderDiagrams(charts);
  const body = fillDiagrams(rawBody, (index) => {
    const result = diagrams[index];
    if (!result || result.error) {
      return `<div class="diagram error">Diagram ${index + 1} failed: ${escapeHtml(result?.error ?? "missing result")}</div>`;
    }
    return `<figure class="diagram"><div class="diagram-scroll">${result.svg}</div></figure>`;
  });

  const title = heading || path.basename(source).replace(/\.md$/i, "");
  const output = source.replace(/\.md$/i, ".html");
  writeAtomic(output, pageTemplate(title, body));
  console.log(output);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(`mdrender: ${error.message}`);
  process.exitCode = 1;
}
