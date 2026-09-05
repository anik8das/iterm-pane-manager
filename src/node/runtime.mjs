import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

export function openDocument(paths, entry, options = {}) {
  const receiptDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "iterm-pane-open-"));
  const receipt = path.join(receiptDirectory, "created-session");
  const args = [
    "--anchor",
    entry.anchor,
    "--url",
    entry.url,
    "--profile",
    entry.profile,
    "--receipt",
    receipt,
  ];
  if (entry.session) args.push("--existing", entry.session);
  try {
    // Creating an iTerm browser can exceed the general helper deadline when
    // WebKit is retiring another content process. Keep the limit finite, but
    // allow the browser operation to finish and report its own rollback.
    const result = JSON.parse(
      runPython(paths.python, paths.document, args, options.timeoutMs ?? 30_000),
    );
    if (!result.focus_unchanged || !result.session) {
      throw new RuntimeError("document split did not preserve its focus contract");
    }
    return result;
  } catch (error) {
    let cleanupError;
    try {
      const created = fs.existsSync(receipt) ? fs.readFileSync(receipt, "utf8").trim() : "";
      if (created) closeSessions(paths, [created]);
    } catch (caught) {
      cleanupError = caught;
    }
    if (cleanupError) {
      throw new RuntimeError(
        `${error.message}; pane cleanup also failed: ${cleanupError.message}`,
      );
    }
    throw error;
  } finally {
    fs.rmSync(receiptDirectory, { recursive: true, force: true });
  }
}

export function evenPanes(paths, anchor, options = {}) {
  const args = options.all ? ["--all"] : ["--session", anchor];
  if (!options.loud) args.push("--quiet");
  return runPython(paths.python, paths.even, args);
}
