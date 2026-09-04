import { execFileSync } from "node:child_process";

/**
 * The terminal the calling process is really on.
 *
 * A tool-running agent starts its commands without a controlling terminal, so
 * the answer is almost never on the process itself. It is on the nearest
 * ancestor that has one: the agent, or the shell that was typed into. Walking
 * up until a terminal appears accepts that shape and still refuses a detached
 * process, whose walk reaches the init process without ever finding one.
 */
export function parseProcessTable(text) {
  const table = new Map();
  for (const line of String(text || "").split("\n")) {
    const row = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/);
    if (row) table.set(Number(row[1]), { ppid: Number(row[2]), tty: row[3] });
  }
  return table;
}

export function nearestTty(table, pid, limit = 64) {
  let current = Number(pid);
  for (let step = 0; step < limit; step += 1) {
    const row = table.get(current);
    if (!row) return "";
    if (row.tty !== "??" && row.tty !== "-") return row.tty;
    if (row.ppid === current || row.ppid < 1) return "";
    current = row.ppid;
  }
  return "";
}

/**
 * The terminal, `""` when the walk found none, or null when it could not run.
 *
 * Those last two must not be confused. A sandbox that denies process
 * information makes `ps` fail outright, and reading that as "no terminal"
 * would refuse every caller inside one, including the agents this tool is
 * mostly used by. "Could not ask" is not an answer, and the caller decides
 * what to do about it.
 */
export function callerTty(pid = process.pid) {
  let listing;
  try {
    listing = execFileSync("ps", ["-Ao", "pid=,ppid=,tty="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
  } catch {
    return null;
  }
  return nearestTty(parseProcessTable(listing), pid);
}
