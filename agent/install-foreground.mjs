import fs from "node:fs";
import path from "node:path";

const [action, target, recordDir] = process.argv.slice(2);
const begin = "# iterm-pane-manager:foreground:begin";
const end = "# iterm-pane-manager:foreground:end";
const beforeFile = path.join(recordDir, "foreground-before");
const afterFile = path.join(recordDir, "foreground-after");
const absentFile = path.join(recordDir, "foreground-absent");
const read = (file) => {
  try { return fs.readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
};
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function write(file, text, mode = 0o600) {
  const destination = fs.existsSync(file) ? fs.realpathSync(file) : file;
  const permissions = fs.existsSync(destination) ? fs.statSync(destination).mode & 0o777 : mode;
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { mode: permissions, flag: "wx" });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

try {
  const original = read(target);
  const text = original ?? "";
  const starts = [...text.matchAll(new RegExp(`^${begin}$`, "gm"))];
  const ends = [...text.matchAll(new RegExp(`^${end}$`, "gm"))];
  const managed = starts.length === 1 && ends.length === 1 && starts[0].index < ends[0].index;
  if ((starts.length || ends.length) && !managed) throw new Error("foreground launcher markers are not one ordered pair");
  const from = managed ? starts[0].index : text.length;
  const to = managed ? ends[0].index + end.length + (text[ends[0].index + end.length] === "\n" ? 1 : 0) : text.length;
  const base = managed ? text.slice(0, from) + text.slice(to) : text;
  if (action === "remove") {
    if (!managed || read(afterFile) === null) process.exit(0);
    if (text === read(afterFile)) {
      const before = read(beforeFile);
      if (read(absentFile) !== null && !fs.lstatSync(target).isSymbolicLink()) fs.unlinkSync(target);
      else write(target, before ?? "");
    } else write(target, base);
    for (const file of [beforeFile, afterFile, absentFile]) fs.rmSync(file, { force: true });
    console.log(`foreground launcher removed: ${target}`);
    process.exit(0);
  }
  if (action !== "install") throw new Error("expected install or remove");
  if (/(^|\n)\s*(?:function\s+codex\b|codex\s*\(\)|alias\s+(?:-\w+\s+)*codex=)/.test(base)) {
    throw new Error("an existing foreground launcher is user-owned");
  }
  const classifier = path.join(path.dirname(process.argv[1]), "foreground.mjs");
  const block = `${begin}\nif ! typeset -f codex >/dev/null && ! alias codex >/dev/null 2>&1; then\nfunction codex {\n  local pane_launch_mode\n  pane_launch_mode=$(command node ${quote(classifier)} "$@") || return\n  if [ "$pane_launch_mode" = foreground ]; then\n    command codex --no-daemon "$@"\n  else\n    command codex "$@"\n  fi\n}\nfi\n${end}\n`;
  const next = managed ? text.slice(0, from) + block + text.slice(to) : text + (text && !text.endsWith("\n") ? "\n" : "") + block;
  fs.mkdirSync(recordDir, { recursive: true, mode: 0o700 });
  if (read(beforeFile) === null && read(absentFile) === null) {
    write(original === null ? absentFile : beforeFile, original ?? "");
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  write(afterFile, next);
  write(target, next);
  console.log(`foreground launcher: ${target}`);
} catch (error) {
  console.error(`agent-integration: ${error.message}; ${target} left unchanged`);
  process.exitCode = 1;
}
