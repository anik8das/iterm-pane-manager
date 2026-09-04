import { execFileSync } from "node:child_process";
import fs from "node:fs";

export class RuntimeError extends Error {}

function runPython(python, script, args, timeout = 10_000) {
  if (!fs.existsSync(python)) {
    throw new RuntimeError(`Python environment is missing: ${python}`);
  }
  try {
    return execFileSync(python, [script, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      killSignal: "SIGKILL",
    }).trim();
  } catch (error) {
    const detail = String(error.stderr || error.message || "").trim();
    throw new RuntimeError(detail || `Python helper failed: ${script}`);
  }
}

export function liveSessionIds(paths) {
  const output = runPython(paths.python, paths.sessions, ["list"]);
  return new Set(output.split("\n").filter(Boolean));
}

export function snapshot(paths) {
  return JSON.parse(runPython(paths.python, paths.sessions, ["snapshot"]));
}

export function sessionStatus(paths, sessionId) {
  return JSON.parse(
    runPython(paths.python, paths.sessions, ["status", "--session", sessionId]),
  );
}

export function closeSessions(paths, sessionIds) {
  const unique = [...new Set(sessionIds.filter(Boolean))];
  if (!unique.length) return;
  const args = ["close"];
  for (const sessionId of unique) args.push("--session", sessionId);
  runPython(paths.python, paths.sessions, args);
}

export function openDocument(paths, entry) {
  const args = [
    "--anchor",
    entry.anchor,
    "--url",
    entry.url,
    "--profile",
    entry.profile,
  ];
  if (entry.session) args.push("--existing", entry.session);
  const result = JSON.parse(runPython(paths.python, paths.document, args));
  if (!result.focus_unchanged || !result.session) {
    throw new RuntimeError("document split did not preserve its focus contract");
  }
  return result;
}

export function evenPanes(paths, anchor, options = {}) {
  const args = options.all ? ["--all"] : ["--session", anchor];
  if (!options.loud) args.push("--quiet");
  return runPython(paths.python, paths.even, args);
}
