import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export class TargetError extends Error {}

export function normalizeUrl(target, options = {}) {
  const mustExist = options.mustExist ?? true;
  if (/^https?:\/\//i.test(target) || /^file:\/\//i.test(target)) {
    let url;
    try {
      url = new URL(target);
    } catch (error) {
      throw new TargetError(`invalid URL: ${error.message}`);
    }
    if (mustExist && url.protocol === "file:" && !fs.existsSync(fileURLToPath(url))) {
      throw new TargetError(`no such file: ${fileURLToPath(url)}`);
    }
    return url.href;
  }
  const absolute = path.resolve(target);
  if (mustExist && !fs.existsSync(absolute)) {
    throw new TargetError(`no such file: ${absolute}`);
  }
  return pathToFileURL(absolute).href;
}

export function resolveTarget(target, options = {}) {
  const direct = normalizeUrl(target);
  if (options.skipRender || options.raw || !direct.toLowerCase().endsWith(".md")) {
    return direct;
  }
  if (!options.renderer) throw new TargetError("no Markdown renderer configured");
  const source = fileURLToPath(direct);
  let output;
  try {
    output = execFileSync(process.execPath, [options.renderer, source, "--no-open"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.renderTimeoutMs ?? 30_000,
    })
      .trim()
      .split("\n")
      .pop();
  } catch (error) {
    const detail = String(error.stderr || error.message || "").trim();
    throw new TargetError(`Markdown rendering failed: ${detail}`);
  }
  if (!output || !fs.existsSync(output)) {
    throw new TargetError("Markdown renderer did not produce an HTML file");
  }
  return pathToFileURL(output).href;
}

export function closeCandidates(target) {
  const direct = normalizeUrl(target, { mustExist: false });
  const candidates = [direct];
  if (direct.toLowerCase().endsWith(".md")) {
    candidates.push(`${direct.slice(0, -3)}.html`);
  }
  return candidates;
}
