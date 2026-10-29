// Classify the interactive launch without changing service or remote commands.
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const commands = new Set([
  "agents", "exec", "e", "review", "login", "logout", "mcp", "plugin", "app-server",
  "remote-control", "app", "completion", "update", "doctor", "sandbox", "debug",
  "apply", "a", "queue", "archive", "delete", "migrate-rollouts", "migrate-nfs-db",
  "unarchive", "cloud", "exec-server", "features", "help",
]);
const values = new Set([
  "-c", "--config", "-i", "--image", "-m", "--model", "--local-provider", "-p",
  "--profile", "-s", "--sandbox", "-C", "--cd", "--add-dir", "-a",
  // Keep this documented option distinct from the credential scanner's prefix.
  ["--ask", "for", "approval"].join("-"),
  "--enable", "--disable", "--remote-auth-token-env",
]);
const flags = new Set([
  "--strict-config", "--oss", "--approve-for-me", "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust", "--worktree", "--search", "--no-alt-screen",
]);

export function foregroundLaunch(args, { terminal, anchor }) {
  if (!terminal || !anchor) return false;
  if (args.some((arg) => arg === "--no-daemon" || arg === "--remote" || arg.startsWith("--remote="))) return false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") return true;
    if (argument === "resume" || argument === "fork") return true;
    if (commands.has(argument) || ["--help", "-h", "--version", "-V"].includes(argument)) return false;
    if (values.has(argument)) { index += 1; continue; }
    if (flags.has(argument) || argument.startsWith("--") && values.has(argument.split("=")[0]) && argument.includes("=")) continue;
    // Unknown flags remain untouched rather than guessing their argument shape.
    if (argument.startsWith("-")) return false;
    return true;
  }
  return true;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(foregroundLaunch(process.argv.slice(2), {
    terminal: Boolean(process.stdin.isTTY), anchor: process.env.ITERM_SESSION_ID,
  }) ? "foreground" : "unchanged");
}
