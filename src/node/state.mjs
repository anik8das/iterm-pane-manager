import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const STATE_VERSION = 1;

export class StateError extends Error {}

export function emptyState() {
  return { version: STATE_VERSION, documents: {} };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeEntry(entry, key) {
  if (!isObject(entry)) throw new StateError(`state entry ${key} is not an object`);
  for (const field of ["anchor", "url", "profile"]) {
    if (typeof entry[field] !== "string" || !entry[field]) {
      throw new StateError(`state entry ${key} has no valid ${field}`);
    }
  }
  if (entry.session !== null && typeof entry.session !== "string") {
    throw new StateError(`state entry ${key} has an invalid session`);
  }
  return {
    anchor: entry.anchor,
    url: entry.url,
    profile: entry.profile,
    session: entry.session,
  };
}

export function decodeState(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new StateError(`state file is not valid JSON: ${error.message}`);
  }
  if (!isObject(parsed)) throw new StateError("state file root is not an object");

  if (parsed.version === STATE_VERSION) {
    if (!isObject(parsed.documents)) {
      throw new StateError("state file has no documents object");
    }
    const state = emptyState();
    for (const [key, entry] of Object.entries(parsed.documents)) {
      state.documents[key] = normalizeEntry(entry, key);
    }
    return { state, migrated: false };
  }

  // Version 0 stored entries directly at the root. Accept it once so existing
  // installations keep their tracked panes during upgrade.
  if (parsed.version === undefined) {
    const state = emptyState();
    for (const [key, entry] of Object.entries(parsed)) {
      if (!isObject(entry) || !entry.anchor || !entry.url || !entry.profile) continue;
      const session = entry.session ?? entry.staged_session ?? null;
      state.documents[key] = normalizeEntry({ ...entry, session }, key);
    }
    return { state, migrated: true };
  }
  throw new StateError(`unsupported state version: ${parsed.version}`);
}

export function readState(statePath) {
  try {
    return decodeState(fs.readFileSync(statePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { state: emptyState(), migrated: false };
    if (error instanceof StateError) throw error;
    throw new StateError(`cannot read state file: ${error.message}`);
  }
}

export function writeStateAtomic(statePath, state) {
  const directory = path.dirname(statePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(statePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, statePath);
  } catch (error) {
    const cleanupErrors = [];
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (caught) {
        cleanupErrors.push(caught);
      }
    }
    try {
      fs.unlinkSync(temporary);
    } catch (caught) {
      if (caught.code !== "ENOENT") cleanupErrors.push(caught);
    }
    const cause = cleanupErrors.length
      ? new AggregateError([error, ...cleanupErrors], "state write cleanup failed")
      : error;
    throw new StateError(`cannot atomically write state file: ${error.message}`, {
      cause,
    });
  }
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function wait(milliseconds) {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, milliseconds);
}

export function withStateLock(statePath, callback, options = {}) {
  const lockPath = `${statePath}.lock`;
  const ownerPath = path.join(lockPath, "owner.json");
  const timeoutMs = options.timeoutMs ?? 20_000;
  const staleMs = options.staleMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  const token = crypto.randomUUID();
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });

  while (true) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      fs.writeFileSync(
        ownerPath,
        JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }),
        { mode: 0o600 },
      );
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let age = 0;
      let owner = null;
      try {
        age = Date.now() - fs.statSync(lockPath).mtimeMs;
        owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
      } catch (caught) {
        if (caught.code !== "ENOENT" && !(caught instanceof SyntaxError)) throw caught;
      }
      if (age > staleMs && !processExists(owner?.pid)) {
        try {
          fs.rmSync(lockPath, { recursive: true });
        } catch (caught) {
          if (caught.code !== "ENOENT") throw caught;
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new StateError(`state lock was held for more than ${timeoutMs}ms`);
      }
      wait(100);
    }
  }

  let result;
  let callbackError;
  try {
    result = callback();
  } catch (caught) {
    callbackError = caught;
  }

  let releaseError;
  let owner;
  try {
    owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    if (owner.token === token) fs.rmSync(lockPath, { recursive: true });
  } catch (caught) {
    if (caught.code !== "ENOENT") releaseError = caught;
  }

  if (callbackError && releaseError) {
    throw new AggregateError(
      [callbackError, releaseError],
      "state operation and lock release both failed",
      { cause: callbackError },
    );
  }
  if (callbackError) throw callbackError;
  if (releaseError) throw releaseError;
  return result;
}

export function keyFor(anchor, url) {
  return `${anchor}::${url}`;
}

export function pruneState(state, liveSessionIds) {
  let changed = false;
  for (const [key, entry] of Object.entries(state.documents)) {
    if (
      !liveSessionIds.has(entry.anchor)
      || !entry.session
      || !liveSessionIds.has(entry.session)
    ) {
      delete state.documents[key];
      changed = true;
    }
  }
  return changed;
}
