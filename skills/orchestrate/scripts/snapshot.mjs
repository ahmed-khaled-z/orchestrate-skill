#!/usr/bin/env node
/**
 * snapshot.mjs — content snapshots of a workspace, compared before/after a task.
 *
 * Tracks git and non-git roots. Metadata is written outside the workspace.
 * Symlink targets are never opened. Ignored dependency/build directories are
 * not walked: git uses ls-files --exclude-standard; non-git skips exact
 * directory names from a small built-in set plus exact `.gitignore` names.
 *
 * Usage:
 *   node snapshot.mjs capture --root <dir> --out <file>
 *   node snapshot.mjs diff --before <file> --after <file> [--read-only] [--scope <rel>]...
 *   node snapshot.mjs --help
 *
 * Exit codes: 0 ok, 1 incomplete snapshot or diff violation, 2 usage.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `snapshot.mjs — content snapshot and delta (no baseline blame)

Usage:
  node snapshot.mjs capture --root <dir> --out <file>
  node snapshot.mjs diff --before <file> --after <file> [--read-only] [--scope <rel>]...

capture writes a snapshot outside the workspace. diff compares two snapshots.
Exit codes: 0 ok, 1 incomplete snapshot or scope/read-only violation, 2 usage.
`;

// ponytail: exact directory names only. Glob gitignores are git's job on a real repo;
// switch non-git walks to git check-ignore if a root depends on patterns.
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  "vendor",
  "target",
  ".git",
  "out",
  "__pycache__",
  ".venv",
  "venv",
]);

export class SnapshotError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function usage(message) {
  return new SnapshotError(message, 2);
}

function incomplete(message) {
  return new SnapshotError(`incomplete snapshot: ${message}`, 1);
}

function hashFile(path) {
  const fd = openSync(path, "r");
  try {
    const hash = createHash("sha256");
    const buf = Buffer.alloc(64 * 1024);
    let read = 0;
    while ((read = readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, read));
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

function gitOutput(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return (result.stdout || "").trim();
}

function nearestExisting(target) {
  const missing = [];
  let cursor = resolve(target);
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) throw usage("snapshot path is not usable");
    missing.push(basename(cursor));
    cursor = parent;
  }
  let real;
  try {
    real = realpathSync(cursor);
  } catch (error) {
    throw usage(`snapshot path is not usable (${error.message})`);
  }
  return missing.length ? join(real, ...missing.reverse()) : real;
}

function escapesRoot(rel) {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function assertMetadataOutside(root, out) {
  const lexical = relative(resolve(root), resolve(out));
  if (!escapesRoot(lexical)) throw usage("snapshot metadata must be outside the workspace");
  let rootReal;
  try {
    rootReal = realpathSync(root);
  } catch (error) {
    throw usage(`snapshot path is not usable (${error.message})`);
  }
  const inside = (candidate) => !escapesRoot(relative(rootReal, candidate));
  const prospective = nearestExisting(out);
  if (inside(prospective) || inside(dirname(prospective))) {
    throw usage("snapshot metadata must be outside the workspace");
  }
  const target = resolve(out);
  if (existsSync(target)) {
    let targetReal;
    try {
      targetReal = realpathSync(target);
    } catch (error) {
      throw usage(`snapshot path is not usable (${error.message})`);
    }
    if (inside(targetReal)) throw usage("snapshot metadata must be outside the workspace");
  }
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true });
  let parentReal;
  try {
    parentReal = realpathSync(parent);
  } catch (error) {
    throw usage(`snapshot path is not usable (${error.message})`);
  }
  if (inside(parentReal)) throw usage("snapshot metadata must be outside the workspace");
}

function entryFor(abs) {
  let st;
  try {
    st = lstatSync(abs);
  } catch (error) {
    if (error.code === "ENOENT") return { kind: "missing", mode: null, sha256: null, target: null };
    throw incomplete(`cannot stat ${abs} (${error.code || error.message})`);
  }
  if (st.isSymbolicLink()) {
    let target;
    try {
      target = readlinkSync(abs);
    } catch (error) {
      throw incomplete(`cannot read link ${abs} (${error.code || error.message})`);
    }
    return { kind: "symlink", mode: st.mode, sha256: null, target };
  }
  if (!st.isFile()) return { kind: "special", mode: st.mode, sha256: null, target: null };
  try {
    return { kind: "file", mode: st.mode, sha256: hashFile(abs), target: null };
  } catch (error) {
    throw incomplete(`cannot read ${abs} (${error.code || error.message})`);
  }
}

function ignoreNames(root) {
  const names = new Set(SKIP_DIRS);
  const gitignore = join(root, ".gitignore");
  let st;
  try {
    st = lstatSync(gitignore);
  } catch (error) {
    if (error.code === "ENOENT") return names;
    throw incomplete(`cannot read .gitignore (${error.code || error.message})`);
  }
  if (st.isSymbolicLink() || !st.isFile()) return names;
  let text;
  let fd;
  try {
    fd = openSync(gitignore, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    text = readFileSync(fd, "utf8");
  } catch (error) {
    if (error.code === "ELOOP" || error.code === "ENOENT") return names;
    throw incomplete(`cannot read .gitignore (${error.code || error.message})`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  for (const line of text.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
    if (/[*?[\]\\]/.test(trimmed)) continue;
    const name = trimmed.replace(/\/$/, "");
    if (!name || name.includes("/")) continue;
    names.add(name);
  }
  return names;
}

function walk(dir, root, skip, entries) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (error) {
    throw incomplete(`cannot list ${dir} (${error.code || error.message})`);
  }
  for (const name of names) {
    const abs = join(dir, name);
    let st;
    try {
      st = lstatSync(abs);
    } catch (error) {
      throw incomplete(`cannot stat ${abs} (${error.code || error.message})`);
    }
    if (st.isDirectory() && !st.isSymbolicLink()) {
      if (skip.has(name)) continue;
      walk(abs, root, skip, entries);
      continue;
    }
    const rel = relative(root, abs).split(sep).join("/");
    entries[rel] = entryFor(abs);
  }
}

function trackedEntry(root, rel) {
  // A tracked path is only safe to open while every ancestor inside the root is a
  // real directory; a symlinked ancestor means the bytes live outside the workspace.
  const parts = rel.split("/");
  let dir = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    dir = join(dir, parts[i]);
    let st;
    try {
      st = lstatSync(dir);
    } catch (error) {
      if (error.code === "ENOENT") return { kind: "missing", mode: null, sha256: null, target: null };
      throw incomplete(`cannot stat ${dir} (${error.code || error.message})`);
    }
    if (st.isSymbolicLink()) {
      throw incomplete(`tracked path ${rel} sits under the symlinked directory ${relative(root, dir)}`);
    }
    if (!st.isDirectory()) throw incomplete(`tracked path ${rel} sits under a non-directory`);
  }
  return entryFor(join(root, rel));
}

function gitPaths(root) {
  const listed = (args) => {
    const result = spawnSync("git", ["-C", root, "ls-files", "-z", ...args], { encoding: "utf8" });
    if (result.error || result.status !== 0) {
      throw incomplete(result.stderr?.trim() || result.error?.message || "git ls-files failed");
    }
    return (result.stdout || "").split("\0").filter(Boolean);
  };
  return [...new Set([...listed(["--cached"]), ...listed(["--others", "--exclude-standard"])])].sort();
}

function indexState(root) {
  // Semantic stage entries (mode, blob id, stage, path), not raw index bytes:
  // a read-only `git status` refresh rewrites stat-cache bytes without a code change.
  const result = spawnSync("git", ["-C", root, "ls-files", "--stage", "-z"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw incomplete(result.stderr?.trim() || result.error?.message || "git index could not be read");
  }
  return { sha256: createHash("sha256").update(result.stdout || "", "utf8").digest("hex") };
}

export function captureSnapshot(root) {
  const abs = resolve(root);
  if (!existsSync(abs) || !lstatSync(abs).isDirectory()) throw usage(`root is not a directory: ${root}`);
  const looksGit = existsSync(join(abs, ".git"));
  const inside = gitOutput(abs, ["rev-parse", "--is-inside-work-tree"]) === "true";
  if (looksGit && !inside) throw incomplete("git metadata is present but the repository cannot be read");
  const entries = {};
  if (inside) {
    for (const rel of gitPaths(abs)) entries[rel] = trackedEntry(abs, rel);
    return { version: 1, root: realpathSync(abs), git: true, index: indexState(abs), entries };
  }
  walk(abs, abs, ignoreNames(abs), entries);
  const ordered = {};
  for (const key of Object.keys(entries).sort()) ordered[key] = entries[key];
  return { version: 1, root: realpathSync(abs), git: false, index: null, entries: ordered };
}

function inScope(file, scopes) {
  return scopes.some((scope) => file === scope || file.startsWith(`${scope}/`));
}

export function diffSnapshots(before, after, { readOnly = false, scopes = [] } = {}) {
  if (!before?.entries || !after?.entries) throw usage("snapshot is missing entries");
  if (before.root && after.root && before.root !== after.root) {
    throw usage("snapshots capture different roots");
  }
  const paths = [...new Set([...Object.keys(before.entries), ...Object.keys(after.entries)])].sort();
  const changes = [];
  const removed = [];
  const added = [];
  for (const path of paths) {
    const left = before.entries[path];
    const right = after.entries[path];
    const leftGone = !left || left.kind === "missing";
    const rightGone = !right || right.kind === "missing";
    if (leftGone && rightGone) continue;
    if (leftGone) {
      added.push(path);
      continue;
    }
    if (rightGone) {
      removed.push(path);
      continue;
    }
    if (left.kind === "symlink" || right.kind === "symlink") {
      if (left.kind !== right.kind || left.target !== right.target) changes.push({ path, kind: "symlink" });
      else if (left.mode !== right.mode) changes.push({ path, kind: "mode" });
      continue;
    }
    if (left.sha256 !== right.sha256) changes.push({ path, kind: "modify" });
    else if (left.mode !== right.mode || left.kind !== right.kind) changes.push({ path, kind: "mode" });
  }
  const removedByHash = new Map();
  for (const path of removed) {
    const sha = before.entries[path]?.sha256;
    if (!sha) continue;
    const list = removedByHash.get(sha) ?? [];
    list.push(path);
    removedByHash.set(sha, list);
  }
  const addedByHash = new Map();
  for (const path of added) {
    const sha = after.entries[path]?.sha256;
    if (!sha) continue;
    const list = addedByHash.get(sha) ?? [];
    list.push(path);
    addedByHash.set(sha, list);
  }
  const pairedRemove = new Set();
  const pairedAdd = new Set();
  for (const [sha, fromPaths] of removedByHash) {
    const toPaths = addedByHash.get(sha) ?? [];
    if (fromPaths.length === 1 && toPaths.length === 1) {
      changes.push({ path: toPaths[0], from: fromPaths[0], kind: "rename" });
      pairedRemove.add(fromPaths[0]);
      pairedAdd.add(toPaths[0]);
    }
  }
  for (const path of removed) if (!pairedRemove.has(path)) changes.push({ path, kind: "delete" });
  for (const path of added) if (!pairedAdd.has(path)) changes.push({ path, kind: "add" });
  const beforeIndex = before.index?.sha256 ?? null;
  const afterIndex = after.index?.sha256 ?? null;
  if ((before.index || after.index) && beforeIndex !== afterIndex) changes.push({ path: null, kind: "index" });
  changes.sort((a, b) => String(a.path).localeCompare(String(b.path)) || a.kind.localeCompare(b.kind));
  const normalizedScopes = scopes.map((scope) => scope.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, ""));
  // A rename is in scope only when BOTH endpoints are: the source path is touched too.
  const changeInScope = (change) =>
    inScope(change.path, normalizedScopes) && (!change.from || inScope(change.from, normalizedScopes));
  const outsideScope = normalizedScopes.length === 0
    ? []
    : changes.filter((change) => change.path && !changeInScope(change));
  const readOnlyViolation = readOnly && changes.length > 0;
  return { ok: !readOnlyViolation && outsideScope.length === 0, changes, outsideScope, readOnlyViolation };
}

function parseArgs(argv) {
  const out = { cmd: argv[0], scopes: [], readOnly: false };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw usage(`${arg} requires a value`);
      return value;
    };
    if (arg === "--root") out.root = next();
    else if (arg === "--out") out.out = next();
    else if (arg === "--before") out.before = next();
    else if (arg === "--after") out.after = next();
    else if (arg === "--scope") out.scopes.push(next());
    else if (arg === "--read-only") out.readOnly = true;
    else throw usage(`unknown option ${arg}`);
  }
  return out;
}

function readSnapshot(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw usage(`cannot read snapshot ${path} (${error.message})`);
  }
}

function main(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    process.exit(argv.length === 0 ? 2 : 0);
  }
  try {
    const opts = parseArgs(argv);
    if (opts.cmd === "capture") {
      if (!opts.root || !opts.out) throw usage("capture requires --root and --out");
      assertMetadataOutside(opts.root, opts.out);
      const snapshot = captureSnapshot(opts.root);
      writeFileSync(opts.out, `${JSON.stringify(snapshot)}\n`);
      process.stdout.write(`${JSON.stringify({ ok: true, out: resolve(opts.out), files: Object.keys(snapshot.entries).length, git: snapshot.git })}\n`);
      return;
    }
    if (opts.cmd === "diff") {
      if (!opts.before || !opts.after) throw usage("diff requires --before and --after");
      const result = diffSnapshots(readSnapshot(opts.before), readSnapshot(opts.after), opts);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exit(result.ok ? 0 : 1);
    }
    throw usage(`unknown command ${JSON.stringify(opts.cmd)}`);
  } catch (error) {
    const code = error instanceof SnapshotError ? error.code : 1;
    const message = error instanceof SnapshotError ? error.message : `incomplete snapshot: ${error.message}`;
    process.stderr.write(`snapshot.mjs: ${message}\n`);
    process.exit(code);
  }
}

const invoked = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invoked) main(process.argv.slice(2));
