// Content snapshots: task deltas, not baseline git status.
// Run: node --test tests/snapshot.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync, lstatSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SNAP = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "snapshot.mjs");

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  return (r.stdout || "").trim();
}

function initRepo() {
  const root = mkdtempSync(join(tmpdir(), "orchestrate-snap-"));
  git(root, ["init"]);
  git(root, ["config", "user.email", "t@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  return root;
}

function outs() {
  return mkdtempSync(join(tmpdir(), "orchestrate-snap-out-"));
}

function run(args) {
  const r = spawnSync("node", [SNAP, ...args], { encoding: "utf8" });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    json: (r.stdout ?? "").trim().startsWith("{") ? JSON.parse(r.stdout) : null,
  };
}

function capture(root, out) {
  const r = run(["capture", "--root", root, "--out", out]);
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  return JSON.parse(readFileSync(out, "utf8"));
}

function diff(before, after, extra = []) {
  return run(["diff", "--before", before, "--after", after, ...extra]);
}

function porcelain(root) {
  return git(root, ["status", "--porcelain"]);
}

test("a dirty file edited again is a modify while git status stays the same", () => {
  const root = initRepo();
  const dir = outs();
  writeFileSync(join(root, "f.txt"), "one\n");
  git(root, ["add", "f.txt"]);
  git(root, ["commit", "-m", "init"]);
  writeFileSync(join(root, "f.txt"), "two\n");
  const statusBefore = porcelain(root);
  const before = join(dir, "before.json");
  capture(root, before);
  writeFileSync(join(root, "f.txt"), "three\n");
  const after = join(dir, "after.json");
  capture(root, after);
  const statusAfter = porcelain(root);
  assert.equal(statusBefore, statusAfter);
  assert.match(statusBefore, /M/);
  const d = diff(before, after);
  assert.equal(d.status, 0, d.stderr);
  assert.ok(d.json.changes.some((c) => c.path === "f.txt" && c.kind === "modify"));
});

test("an unchanged dirty file is allowed for a read-only comparison", () => {
  const root = initRepo();
  const dir = outs();
  writeFileSync(join(root, "f.txt"), "one\n");
  git(root, ["add", "f.txt"]);
  git(root, ["commit", "-m", "init"]);
  writeFileSync(join(root, "f.txt"), "two\n");
  const before = join(dir, "before.json");
  const after = join(dir, "after.json");
  capture(root, before);
  capture(root, after);
  const d = diff(before, after, ["--read-only"]);
  assert.equal(d.status, 0, d.stderr);
  assert.deepEqual(d.json.changes, []);
  assert.equal(d.json.readOnlyViolation, false);
});

test("an edit outside declared scope fails the diff", () => {
  const root = initRepo();
  const dir = outs();
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.js"), "a\n");
  writeFileSync(join(root, "src", "b.js"), "b\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  const before = join(dir, "before.json");
  capture(root, before);
  writeFileSync(join(root, "src", "a.js"), "a2\n");
  writeFileSync(join(root, "src", "b.js"), "b2\n");
  const after = join(dir, "after.json");
  capture(root, after);
  const d = diff(before, after, ["--scope", "src/a.js"]);
  assert.equal(d.status, 1);
  assert.equal(d.json.ok, false);
  assert.ok(d.json.outsideScope.some((c) => c.path === "src/b.js"));
  assert.ok(d.json.changes.some((c) => c.path === "src/a.js" && c.kind === "modify"));
});

test("a binary byte change is a modify", () => {
  const root = initRepo();
  const dir = outs();
  writeFileSync(join(root, "blob.bin"), Buffer.from([0, 1, 2, 255]));
  const before = join(dir, "before.json");
  const after = join(dir, "after.json");
  capture(root, before);
  writeFileSync(join(root, "blob.bin"), Buffer.from([0, 1, 2, 254]));
  capture(root, after);
  const d = diff(before, after);
  assert.ok(d.json.changes.some((c) => c.path === "blob.bin" && c.kind === "modify"));
});

test("symlink snapshots store the link text and not an outside target", () => {
  const root = initRepo();
  const dir = outs();
  const outside = join(dir, "secret.txt");
  writeFileSync(outside, "UNIQUE-SECRET-OUTSIDE-xyz\n");
  symlinkSync(outside, join(root, "link"));
  const before = join(dir, "before.json");
  const snap = capture(root, before);
  assert.equal(JSON.stringify(snap).includes("UNIQUE-SECRET-OUTSIDE-xyz"), false);
  assert.equal(snap.entries.link.kind, "symlink");
  assert.equal(snap.entries.link.target, outside);
  symlinkSync(join(dir, "other"), join(root, "link2"));
  rmSync(join(root, "link"));
  symlinkSync(join(dir, "other"), join(root, "link"));
  const after = join(dir, "after.json");
  capture(root, after);
  const d = diff(before, after);
  assert.ok(d.json.changes.some((c) => c.path === "link" && c.kind === "symlink"));
});

test("delete, rename, and mode changes are distinguished", () => {
  const root = initRepo();
  const dir = outs();
  writeFileSync(join(root, "gone.txt"), "gone\n");
  writeFileSync(join(root, "moved.txt"), "moved-unique\n");
  writeFileSync(join(root, "mode.txt"), "mode\n");
  const before = join(dir, "before.json");
  capture(root, before);
  rmSync(join(root, "gone.txt"));
  rmSync(join(root, "moved.txt"));
  writeFileSync(join(root, "renamed.txt"), "moved-unique\n");
  chmodSync(join(root, "mode.txt"), 0o755);
  const after = join(dir, "after.json");
  capture(root, after);
  const d = diff(before, after);
  const kinds = Object.fromEntries(d.json.changes.map((c) => [c.kind === "rename" ? c.from : c.path, c.kind]));
  assert.equal(kinds["gone.txt"], "delete");
  assert.equal(kinds["moved.txt"], "rename");
  assert.equal(kinds["mode.txt"], "mode");
});

test("a git index change is reported when worktree bytes stay the same", () => {
  const root = initRepo();
  const dir = outs();
  writeFileSync(join(root, "f.txt"), "same\n");
  git(root, ["add", "f.txt"]);
  git(root, ["commit", "-m", "init"]);
  const before = join(dir, "before.json");
  capture(root, before);
  git(root, ["update-index", "--chmod=+x", "f.txt"]);
  const after = join(dir, "after.json");
  capture(root, after);
  const worktreeMode = lstatSync(join(root, "f.txt")).mode;
  const beforeSnap = JSON.parse(readFileSync(before, "utf8"));
  assert.equal(beforeSnap.entries["f.txt"].mode, worktreeMode);
  const d = diff(before, after);
  assert.ok(d.json.changes.some((c) => c.kind === "index"));
  assert.equal(d.json.changes.some((c) => c.path === "f.txt" && c.kind === "modify"), false);
});

test("non-git roots snapshot files and do not read an ignored unreadable directory", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrate-snap-nogit-"));
  const dir = outs();
  writeFileSync(join(root, ".gitignore"), "customer/\nnode_modules/\n");
  writeFileSync(join(root, "keep.txt"), "visible\n");
  mkdirSync(join(root, "customer"));
  writeFileSync(join(root, "customer", "secret.txt"), "CUSTOMER-SECRET-DO-NOT-READ\n");
  chmodSync(join(root, "customer"), 0);
  const out = join(dir, "snap.json");
  try {
    const snap = capture(root, out);
    assert.equal(snap.git, false);
    assert.equal(snap.index, null);
    assert.equal(snap.entries["keep.txt"].kind, "file");
    assert.equal(snap.entries["customer/secret.txt"], undefined);
    assert.equal(JSON.stringify(snap).includes("CUSTOMER-SECRET-DO-NOT-READ"), false);
  } finally {
    chmodSync(join(root, "customer"), 0o755);
  }
});

test("gitignored customer files are omitted without their contents appearing", () => {
  const root = initRepo();
  const dir = outs();
  writeFileSync(join(root, ".gitignore"), "customer/\nnode_modules/\n");
  writeFileSync(join(root, "keep.txt"), "visible\n");
  mkdirSync(join(root, "customer", "nested"), { recursive: true });
  writeFileSync(join(root, "customer", "nested", "secret.txt"), "GIT-CUSTOMER-SECRET\n");
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  git(root, ["add", ".gitignore", "keep.txt"]);
  const snap = capture(root, join(dir, "snap.json"));
  assert.equal(snap.git, true);
  assert.ok(snap.entries["keep.txt"]);
  assert.equal(snap.entries["customer/nested/secret.txt"], undefined);
  assert.equal(snap.entries["node_modules/pkg/index.js"], undefined);
  assert.equal(JSON.stringify(snap).includes("GIT-CUSTOMER-SECRET"), false);
});

test("metadata through a symlink is rejected before any workspace directory is created", () => {
  const parent = mkdtempSync(join(tmpdir(), "orchestrate-snap-meta-"));
  const root = join(parent, "workspace");
  const outside = join(parent, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  symlinkSync(root, join(outside, "link"));
  const created = join(root, "newdir");
  const r = run(["capture", "--root", root, "--out", join(outside, "link", "newdir", "snapshot.json")]);
  assert.equal(r.status, 2, `${r.stderr}\n${r.stdout}`);
  assert.match(`${r.stderr}${r.stdout}`, /outside/i);
  assert.equal(existsSync(created), false);
  assert.equal(existsSync(join(outside, "link", "newdir")), false);
});

test("a symlinked .gitignore is not opened and does not hide workspace files", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrate-snap-ignore-"));
  const dir = outs();
  const external = join(dir, "external-ignore");
  writeFileSync(external, "hide\nSECRET-IGNORE-BODY\n");
  symlinkSync(external, join(root, ".gitignore"));
  mkdirSync(join(root, "hide"));
  writeFileSync(join(root, "hide", "a.txt"), "visible-local\n");
  const snap = capture(root, join(dir, "snap.json"));
  assert.equal(snap.entries[".gitignore"].kind, "symlink");
  assert.equal(snap.entries[".gitignore"].target, external);
  assert.equal(snap.entries["hide/a.txt"].kind, "file");
  assert.equal(JSON.stringify(snap).includes("SECRET-IGNORE-BODY"), false);
});

test("snapshot metadata inside the workspace is refused", () => {
  const root = initRepo();
  const r = run(["capture", "--root", root, "--out", join(root, "snap.json")]);
  assert.equal(r.status, 2);
  assert.match(`${r.stderr}${r.stdout}`, /outside/i);
});

test("a workspace child named ..metadata is inside and is refused before it is created", () => {
  const root = initRepo();
  const out = join(root, "..metadata", "snapshot.json");
  const r = run(["capture", "--root", root, "--out", out]);
  assert.equal(r.status, 2, `${r.stderr}\n${r.stdout}`);
  assert.match(`${r.stderr}${r.stdout}`, /outside/i);
  assert.equal(existsSync(join(root, "..metadata")), false);
  assert.equal(existsSync(out), false);
});

test("a sibling directory named ..metadata stays a valid snapshot location", () => {
  const parent = mkdtempSync(join(tmpdir(), "orchestrate-snap-dotdot-"));
  const root = join(parent, "workspace");
  mkdirSync(root);
  writeFileSync(join(root, "f.txt"), "x\n");
  const out = join(parent, "..metadata", "snapshot.json");
  const snap = capture(root, out);
  assert.equal(snap.entries["f.txt"].kind, "file");
  assert.equal(existsSync(out), true);
  assert.equal(existsSync(join(root, "..metadata")), false);
});

test("a broken git directory fails the snapshot visibly and writes nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrate-snap-badgit-"));
  const dir = outs();
  writeFileSync(join(root, "f.txt"), "x\n");
  mkdirSync(join(root, ".git"));
  const out = join(dir, "snap.json");
  const r = run(["capture", "--root", root, "--out", out]);
  assert.notEqual(r.status, 0);
  assert.match(`${r.stderr}${r.stdout}`, /incomplete/i);
  assert.throws(() => readFileSync(out, "utf8"));
});

test("an unreadable tracked file fails the snapshot visibly", () => {
  const root = initRepo();
  const dir = outs();
  const file = join(root, "secret.txt");
  writeFileSync(file, "hidden\n");
  git(root, ["add", "secret.txt"]);
  git(root, ["commit", "-m", "init"]);
  chmodSync(file, 0);
  const out = join(dir, "snap.json");
  try {
    const r = run(["capture", "--root", root, "--out", out]);
    assert.notEqual(r.status, 0);
    assert.match(`${r.stderr}${r.stdout}`, /incomplete/i);
    assert.throws(() => readFileSync(out, "utf8"));
  } finally {
    chmodSync(file, 0o644);
  }
});

test("a rename whose source is outside scope fails the diff", () => {
  const root = initRepo();
  const dir = outs();
  mkdirSync(join(root, "outside"));
  mkdirSync(join(root, "owned"));
  writeFileSync(join(root, "outside", "a.txt"), "rename-me-unique\n");
  writeFileSync(join(root, "owned", "keep.txt"), "keep\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  const before = join(dir, "before.json");
  capture(root, before);
  rmSync(join(root, "outside", "a.txt"));
  writeFileSync(join(root, "owned", "a.txt"), "rename-me-unique\n");
  const after = join(dir, "after.json");
  capture(root, after);
  const d = diff(before, after, ["--scope", "owned"]);
  assert.equal(d.status, 1);
  assert.equal(d.json.ok, false);
  assert.ok(d.json.changes.some((c) => c.kind === "rename" && c.from === "outside/a.txt" && c.path === "owned/a.txt"));
  assert.ok(d.json.outsideScope.some((c) => c.kind === "rename" && c.from === "outside/a.txt"));
});

test("a tracked path under a replaced symlinked directory fails the capture", () => {
  const root = initRepo();
  const dir = outs();
  mkdirSync(join(root, "outside"));
  writeFileSync(join(root, "outside", "a.txt"), "tracked\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  const external = mkdtempSync(join(tmpdir(), "orchestrate-snap-ext-"));
  writeFileSync(join(external, "a.txt"), "EXTERNAL-SECRET-BYTES\n");
  rmSync(join(root, "outside"), { recursive: true });
  symlinkSync(external, join(root, "outside"));
  const out = join(dir, "snap.json");
  const r = run(["capture", "--root", root, "--out", out]);
  assert.notEqual(r.status, 0);
  assert.match(`${r.stderr}${r.stdout}`, /incomplete/i);
  assert.equal(existsSync(out), false);
  assert.equal(`${r.stdout}${r.stderr}`.includes("EXTERNAL-SECRET-BYTES"), false);
});

test("a read-only git status refresh is not an index change", () => {
  const root = initRepo();
  const dir = outs();
  writeFileSync(join(root, "f.txt"), "same\n");
  git(root, ["add", "f.txt"]);
  git(root, ["commit", "-m", "init"]);
  const before = join(dir, "before.json");
  const after = join(dir, "after.json");
  capture(root, before);
  const stale = new Date(Date.now() - 3600_000);
  utimesSync(join(root, "f.txt"), stale, stale);
  git(root, ["status"]);
  capture(root, after);
  const d = diff(before, after);
  assert.equal(d.status, 0, d.stderr);
  assert.deepEqual(d.json.changes, []);
});

test("diff refuses snapshots from different roots", () => {
  const a = initRepo();
  const b = initRepo();
  const dir = outs();
  writeFileSync(join(a, "f.txt"), "a\n");
  writeFileSync(join(b, "f.txt"), "b\n");
  const sa = join(dir, "a.json");
  const sb = join(dir, "b.json");
  capture(a, sa);
  capture(b, sb);
  const d = diff(sa, sb);
  assert.equal(d.status, 2);
  assert.match(`${d.stderr}${d.stdout}`, /different roots/i);
});
