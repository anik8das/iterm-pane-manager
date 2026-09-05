#!/usr/bin/env node

import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  keyFor,
  pruneState,
  readState,
  withStateLock,
  writeStateAtomic,
} from "../src/node/state.mjs";
import { ownsAnchor, parseAnchor } from "../src/node/anchor.mjs";
import { callerTty } from "../src/node/caller.mjs";
import { renderDiagrams } from "../src/node/diagram.mjs";
import { closeCandidates, resolveTarget } from "../src/node/target.mjs";
import {
  closeSessions,
  evenPanes,
  liveSessionIds,
  openDocument,
  sessionStatus,
  snapshot,
} from "../src/node/runtime.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PYTHON_SOURCE = path.join(ROOT, "src/iterm_pane");
const STATE_DIR = path.join(os.homedir(), ".local/state/iterm-pane");
const STATE_PATH = path.join(STATE_DIR, "state.json");
const PAUSE_PATH = path.join(STATE_DIR, "watch-paused");
const LOG_PATH = path.join(STATE_DIR, "watch.log");
const PYTHON =
  process.env.ITERM_PANE_PYTHON || path.join(ROOT, "venv/bin/python3");
const PATHS = {
  python: PYTHON,
  document: path.join(PYTHON_SOURCE, "document.py"),
  even: path.join(PYTHON_SOURCE, "even.py"),
  sessions: path.join(PYTHON_SOURCE, "sessions.py"),
  watch: path.join(PYTHON_SOURCE, "watch.py"),
};
const RENDERER = path.join(ROOT, "bin/mdrender.mjs");
const LABEL = "io.github.anik8das.iterm-pane-manager";
const PLIST_PATH = path.join(os.homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const DOMAIN = `gui/${process.getuid()}`;

class CliError extends Error {}

function fail(message) {
  throw new CliError(message);
}

function allowOnly(args, allowed) {
  for (const argument of args) {
    if (!allowed.has(argument)) fail(`option is not valid for this command: ${argument}`);
  }
}

function printHelp() {
  console.log(`Usage:
  pane <file.md|file.html|url> [--raw]
  pane --list [--all]
  pane --close <target>
  pane --close-all [--all]
  pane --even [--all]

Automatic evening:
  pane --watch [watch options]
  pane --watch-install | --watch-uninstall | --watch-status
  pane --pause | --resume
  pane --doctor

Behavior:
  Documents open in the calling session's exact tab, including hidden tabs.
  A process detached from that tab is refused; PANE_ANCHOR overrides.
  Opening the same document again replaces its tracked browser pane.
  The watcher resizes only the selected tab while iTerm2 is active.`);
}

function anchorSession() {
  // On the parsed value, not the raw one: `PANE_ANCHOR=w0t1p2:` is truthy and
  // names nothing, and must not shadow a variable that does.
  return parseAnchor(process.env.PANE_ANCHOR) || parseAnchor(process.env.ITERM_SESSION_ID);
}

/**
 * Refuse to act on a tab this process is not in.
 *
 * `ITERM_SESSION_ID` is inherited, so a detached background job keeps a valid
 * address for the tab that started it long after leaving it, and would
 * otherwise split, close, or resize a tab nobody there asked it to touch.
 * Setting `PANE_ANCHOR` names a tab deliberately and skips this, which is the
 * way out for a caller behind a multiplexer or a remote shell.
 */
function requireOwnership(anchor) {
  if (!anchor) return;
  // Asked before either way out below, so a tab that has closed is refused
  // here rather than after a document has been rendered for it. Naming a tab
  // deliberately says which tab, not that it still exists.
  const status = sessionStatus(PATHS, anchor);
  if (!status.exists) fail(`no iTerm2 session ${anchor}; its tab has closed`);
  if (parseAnchor(process.env.PANE_ANCHOR)) return;
  const caller = callerTty();
  // A sandbox that denies process information leaves the call unplaceable.
  // Refusing then would break every caller inside one, so an unanswerable
  // question is not treated as a failed answer. `--doctor` reports it.
  if (caller === null) return;
  if (ownsAnchor(caller, status.tty)) return;
  fail(
    "this process is not in the tab named by ITERM_SESSION_ID, so it inherited " +
      "that address rather than earning it. Set PANE_ANCHOR to open there anyway.",
  );
}

function launchctl(...args) {
  try {
    return {
      ok: true,
      output: execFileSync("launchctl", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (error) {
    return {
      ok: false,
      output: `${String(error.stdout || "")}${String(error.stderr || "")}`,
    };
  }
}

function processCount(name) {
  try {
    const output = execFileSync("pgrep", ["-x", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output ? output.split("\n").length : 0;
  } catch (error) {
    if (error.status === 1) return 0;
    return null;
  }
}

function wait(milliseconds) {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, milliseconds);
}

function xmlEscape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function atomicText(filePath, text, mode = 0o644) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { mode });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    let cleanupError;
    try {
      fs.unlinkSync(temporary);
    } catch (caught) {
      if (caught.code !== "ENOENT") cleanupError = caught;
    }
    if (cleanupError) {
      throw new AggregateError([error, cleanupError], "file write and cleanup failed", {
        cause: error,
      });
    }
    throw error;
  }
}

function plist() {
  const python = xmlEscape(PYTHON);
  const watcher = xmlEscape(PATHS.watch);
  const log = xmlEscape(LOG_PATH);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${python}</string><string>${watcher}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

function installWatcher() {
  if (!fs.existsSync(PYTHON)) fail(`Python environment is missing: ${PYTHON}`);
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  atomicText(PLIST_PATH, plist());
  launchctl("bootout", `${DOMAIN}/${LABEL}`);
  let result = { ok: false, output: "" };
  for (let attempt = 0; attempt < 10; attempt += 1) {
    result = launchctl("bootstrap", DOMAIN, PLIST_PATH);
    if (result.ok) break;
    wait(200);
  }
  if (!result.ok) fail(`launchctl bootstrap failed:\n${result.output.trim()}`);
  console.log(`installed ${LABEL}\n  log ${LOG_PATH}`);
}

function uninstallWatcher() {
  launchctl("bootout", `${DOMAIN}/${LABEL}`);
  if (fs.existsSync(PLIST_PATH)) fs.unlinkSync(PLIST_PATH);
  console.log(`stopped and removed ${LABEL}`);
}

function watcherStatus() {
  const result = launchctl("print", `${DOMAIN}/${LABEL}`);
  const pid = (result.output.match(/\bpid = (\d+)/) || [])[1];
  console.log(`installed ${fs.existsSync(PLIST_PATH) ? "yes" : "no"}`);
  console.log(`running   ${pid ? `yes, pid ${pid}` : "no"}`);
  console.log(`paused    ${fs.existsSync(PAUSE_PATH) ? "yes" : "no"}`);
  if (fs.existsSync(LOG_PATH)) {
    console.log(`log       ${LOG_PATH}`);
    const lines = fs.readFileSync(LOG_PATH, "utf8").trimEnd().split("\n");
    for (const line of lines.slice(-8)) console.log(`  ${line}`);
  }
  return Boolean(pid);
}

function setPaused(value) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  if (value) atomicText(PAUSE_PATH, `${new Date().toISOString()}\n`, 0o600);
  else if (fs.existsSync(PAUSE_PATH)) fs.unlinkSync(PAUSE_PATH);
  console.log(value ? "automatic evening paused" : "automatic evening resumed");
}

function scoped(entry, anchor, all) {
  return all || entry.anchor === anchor;
}

function safeProfileName(anchor, url) {
  const hash = crypto.createHash("sha256").update(`${anchor}::${url}`).digest("hex").slice(0, 8);
  let base;
  try {
    base = path.basename(decodeURIComponent(new URL(url).pathname));
  } catch {
    base = "document";
  }
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40) || "document";
  return `pane ${safe} ${hash}`;
}

function listDocuments(anchor, all) {
  const { state } = readState(STATE_PATH);
  const live = liveSessionIds(PATHS);
  const entries = Object.values(state.documents).filter((entry) =>
    scoped(entry, anchor, all),
  );
  if (!entries.length) {
    console.log("no panes tracked");
    return;
  }
  for (const entry of entries) {
    const status = entry.session && live.has(entry.session) ? entry.session : "missing";
    console.log(`${status}  ${entry.profile}\n    ${entry.url}`);
  }
}

function openTarget(target, raw) {
  const anchor = anchorSession();
  if (!anchor) {
    fail("ITERM_SESSION_ID is missing; run pane from the iTerm2 tab that should receive the document");
  }
  requireOwnership(anchor);
  const url = resolveTarget(target, { raw, renderer: RENDERER });
  const key = keyFor(anchor, url);
  let result;
  let openError;

  withStateLock(STATE_PATH, () => {
    const loaded = readState(STATE_PATH);
    const state = loaded.state;
    const live = liveSessionIds(PATHS);
    const changed = pruneState(state, live);
    const previous = state.documents[key] ?? null;
    const entry = {
      anchor,
      url,
      profile: previous?.profile ?? safeProfileName(anchor, url),
      session: previous?.session ?? null,
    };
    try {
      result = openDocument(PATHS, entry, { beforeSessionIds: live });
      state.documents[key] = { ...entry, session: result.session };
      writeStateAtomic(STATE_PATH, state);
    } catch (error) {
      openError = error;
      if (previous) state.documents[key] = previous;
      else delete state.documents[key];
      const after = liveSessionIds(PATHS);
      if (previous?.session && !after.has(previous.session)) {
        delete state.documents[key];
      }
      if (loaded.migrated || changed || previous) writeStateAtomic(STATE_PATH, state);
    }
  });

  if (openError) fail(`document was not opened:\n${openError.message}`);
  console.log(
    `${result.session}  ${url}\n  ready in target tab; focus unchanged (${result.elapsed}s)`,
  );
}

function closeTarget(target) {
  const anchor = anchorSession();
  if (!anchor) fail("ITERM_SESSION_ID is missing");
  requireOwnership(anchor);
  const keys = closeCandidates(target).map((url) => keyFor(anchor, url));
  let closedUrl;
  withStateLock(STATE_PATH, () => {
    const { state } = readState(STATE_PATH);
    const key = keys.find((candidate) => state.documents[candidate]);
    if (!key) fail(`no tracked pane in this tab for ${target}`);
    const entry = state.documents[key];
    closeSessions(PATHS, [entry.session]);
    closedUrl = entry.url;
    delete state.documents[key];
    writeStateAtomic(STATE_PATH, state);
  });
  console.log(`closed ${closedUrl}`);
}

function closeAll(anchor, all) {
  requireOwnership(anchor);
  let count = 0;
  withStateLock(STATE_PATH, () => {
    const { state } = readState(STATE_PATH);
    const targets = Object.entries(state.documents).filter(([, entry]) =>
      scoped(entry, anchor, all),
    );
    closeSessions(
      PATHS,
      targets.map(([, entry]) => entry.session),
    );
    for (const [key] of targets) delete state.documents[key];
    count = targets.length;
    writeStateAtomic(STATE_PATH, state);
  });
  console.log(`closed ${count} pane(s)`);
}

function runDoctor() {
  const checks = [];
  checks.push(["platform", process.platform === "darwin", process.platform]);
  checks.push(["Node.js", Number(process.versions.node.split(".")[0]) >= 20, process.versions.node]);
  checks.push(["Python environment", fs.existsSync(PYTHON), PYTHON]);
  checks.push(["watcher source", fs.existsSync(PATHS.watch), PATHS.watch]);
  checks.push(["renderer", fs.existsSync(RENDERER), RENDERER]);
  const placement = callerTty();
  checks.push([
    "caller placement",
    true,
    placement === null
      ? "unavailable: the process table cannot be read, so the tab-ownership check is skipped"
      : placement || "no terminal above this process",
  ]);
  const watcher = launchctl("print", `${DOMAIN}/${LABEL}`);
  checks.push(["background watcher", watcher.ok, watcher.ok ? "loaded" : "not loaded"]);
  const webContent = processCount("com.apple.WebKit.WebContent");
  checks.push([
    "iTerm browser capacity",
    webContent !== null && webContent < 400,
    webContent === null
      ? "process count unavailable"
      : `${webContent} WebKit content processes${
          webContent >= 400 ? "; macOS is rejecting new browser processes" : ""
        }`,
  ]);
  try {
    const results = renderDiagrams([
      "flowchart LR\n  A --> B",
      "sequenceDiagram\n  A->>B: check",
      "stateDiagram-v2\n  [*] --> Ready",
    ]);
    const rendered = results.every(
      (result) => typeof result.svg === "string" && /<svg[\s>]/.test(result.svg),
    );
    checks.push([
      "Mermaid round trip",
      rendered,
      rendered
        ? "flow, sequence, and state diagrams returned inline SVG"
        : "a required diagram type returned no SVG",
    ]);
  } catch (error) {
    checks.push(["Mermaid round trip", false, error.message]);
  }
  try {
    const current = snapshot(PATHS);
    checks.push(["iTerm2 Python API", true, `${Object.keys(current.sessions).length} sessions`]);
  } catch (error) {
    checks.push(["iTerm2 Python API", false, error.message]);
  }
  let healthy = true;
  for (const [name, ok, detail] of checks) {
    healthy = healthy && ok;
    console.log(`${ok ? "ok  " : "fail"} ${name}: ${detail}`);
  }
  return healthy ? 0 : 1;
}

function main(args) {
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    printHelp();
    return 0;
  }
  if (args.includes("--new")) {
    fail("--new was removed because duplicate panes cannot be tracked safely");
  }

  const operations = [
    "--list",
    "--close",
    "--close-all",
    "--even",
    "--watch",
    "--watch-install",
    "--watch-uninstall",
    "--watch-status",
    "--pause",
    "--resume",
    "--doctor",
  ].filter((flag) => args.includes(flag));
  if (operations.length > 1) fail(`conflicting commands: ${operations.join(", ")}`);

  const operation = operations[0];
  const all = args.includes("--all");
  const anchor = anchorSession();
  if (operation === "--list") {
    allowOnly(args, new Set(["--list", "--all"]));
    listDocuments(anchor, all);
    return 0;
  }
  if (operation === "--close") {
    const index = args.indexOf("--close");
    if (index !== 0 || args.length !== 2 || args[1].startsWith("--")) {
      fail("usage: pane --close <target>");
    }
    closeTarget(args[index + 1]);
    return 0;
  }
  if (operation === "--close-all") {
    allowOnly(args, new Set(["--close-all", "--all"]));
    closeAll(anchor, all);
    return 0;
  }
  if (operation === "--even") {
    allowOnly(args, new Set(["--even", "--all"]));
    requireOwnership(anchor);
    const output = evenPanes(PATHS, anchor, { all, loud: true });
    if (output) console.log(output);
    return 0;
  }
  if (operation === "--watch") {
    if (!fs.existsSync(PYTHON)) fail(`Python environment is missing: ${PYTHON}`);
    const forwarded = args.filter((argument) => argument !== "--watch");
    return spawnSync(PYTHON, [PATHS.watch, ...forwarded], { stdio: "inherit" }).status ?? 1;
  }
  if (operation === "--watch-install") {
    allowOnly(args, new Set(["--watch-install"]));
    installWatcher();
    return 0;
  }
  if (operation === "--watch-uninstall") {
    allowOnly(args, new Set(["--watch-uninstall"]));
    uninstallWatcher();
    return 0;
  }
  if (operation === "--watch-status") {
    allowOnly(args, new Set(["--watch-status"]));
    return watcherStatus() ? 0 : 1;
  }
  if (operation === "--pause") {
    allowOnly(args, new Set(["--pause"]));
    setPaused(true);
    return 0;
  }
  if (operation === "--resume") {
    allowOnly(args, new Set(["--resume"]));
    setPaused(false);
    return 0;
  }
  if (operation === "--doctor") {
    allowOnly(args, new Set(["--doctor"]));
    return runDoctor();
  }

  const unknown = args.filter((argument) => argument.startsWith("-") && argument !== "--raw");
  if (unknown.length) fail(`unknown option: ${unknown[0]}`);
  const targets = args.filter((argument) => !argument.startsWith("-"));
  if (targets.length !== 1) fail("provide exactly one file or URL");
  openTarget(targets[0], args.includes("--raw"));
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`pane: ${error.message}`);
  process.exitCode = 1;
}
