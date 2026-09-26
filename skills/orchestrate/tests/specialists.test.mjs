// Tests for scripts/specialists.mjs — run: node --test tests/
// Fake rosters under a throwaway HOME; the real roster is never touched here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "specialists.mjs");

const md = (name, description) => `---\nname: "${name}"\ndescription: "${description}"\n---\n\nBody.\n`;
const toml = (name, description) => `name = "${name}"\ndescription = "${description}"\n`;

function rosterHome({ claude = {}, codex = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), "orchestrate-specialists-"));
  const claudeAgents = join(home, ".claude", "agents");
  const codexAgents = join(home, ".codex", "agents");
  mkdirSync(claudeAgents, { recursive: true });
  mkdirSync(codexAgents, { recursive: true });
  for (const [file, text] of Object.entries(claude)) writeFileSync(join(claudeAgents, file), text);
  for (const [file, text] of Object.entries(codex)) writeFileSync(join(codexAgents, file), text);
  return { home, claudeAgents, codexAgents };
}

function run(home, args, extraEnv = {}) {
  const r = spawnSync("node", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "", CODEX_HOME: "", ...extraEnv },
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    json: r.stdout.startsWith("{") ? JSON.parse(r.stdout) : null,
  };
}

test("1. joins twins by profile name, not filename", () => {
  const { home, claudeAgents } = rosterHome({
    claude: {
      "engineering-foo.md": md("Foo Engineer", "foo things"),
      "engineering-bar.md": md("Bar Engineer", "bar things"),
    },
    codex: {
      "foo-engineer.toml": toml("Foo Engineer", "toml foo things"),
      "bar.toml": toml("Bar Engineer", "toml bar things"),
    },
  });
  const a = run(home, ["audit"]);
  assert.equal(a.status, 0);
  assert.deepEqual(a.json.counts, { claude: 2, codex: 2, paired: 2 });
  assert.equal(a.json.ok, true);
  assert.deepEqual(a.json.claudeOnly, []);
  assert.deepEqual(a.json.codexOnly, []);
  const f = run(home, ["find", "--name", "Foo Engineer"]);
  assert.equal(f.status, 0);
  assert.equal(f.json.candidates.length, 1);
  assert.equal(f.json.candidates[0].profile, join(claudeAgents, "engineering-foo.md"), "briefs get the .md path");
  assert.equal(f.json.note, null);
});

test("2. reads CLAUDE_CONFIG_DIR and CODEX_HOME instead of HOME", () => {
  const home = mkdtempSync(join(tmpdir(), "orchestrate-spec-decoy-"));
  mkdirSync(join(home, ".claude", "agents"), { recursive: true });
  writeFileSync(join(home, ".claude", "agents", "decoy.md"), md("Decoy Engineer", "must not appear"));
  const cfg = mkdtempSync(join(tmpdir(), "orchestrate-spec-claude-"));
  const cx = mkdtempSync(join(tmpdir(), "orchestrate-spec-codex-"));
  mkdirSync(join(cfg, "agents"), { recursive: true });
  mkdirSync(join(cx, "agents"), { recursive: true });
  writeFileSync(join(cfg, "agents", "real.md"), md("Real Engineer", "real things"));
  writeFileSync(join(cx, "agents", "real.toml"), toml("Real Engineer", "toml real"));
  const env = { CLAUDE_CONFIG_DIR: cfg, CODEX_HOME: cx };
  const a = run(home, ["audit"], env);
  assert.equal(a.status, 0);
  assert.equal(a.json.counts.paired, 1);
  assert.ok(!a.stdout.includes("Decoy"), "decoy under HOME is ignored");
  const f = run(home, ["find", "--name", "Real Engineer"], env);
  assert.equal(f.status, 0);
  assert.equal(f.json.candidates[0].codex, join(cx, "agents", "real.toml"));
});

test("3. mismatch is loud: claudeOnly, codexOnly, ok false, exit 1", () => {
  const { home, claudeAgents, codexAgents } = rosterHome({
    claude: { "solo.md": md("Solo Engineer", "only in claude") },
    codex: { "lonely.toml": toml("Lonely Engineer", "only in codex") },
  });
  const a = run(home, ["audit"]);
  assert.equal(a.status, 1);
  assert.equal(a.json.ok, false);
  assert.deepEqual(a.json.claudeOnly, [{ name: "Solo Engineer", path: join(claudeAgents, "solo.md") }]);
  assert.deepEqual(a.json.codexOnly, [{ name: "Lonely Engineer", path: join(codexAgents, "lonely.toml") }]);
  assert.deepEqual(a.json.counts, { claude: 1, codex: 1, paired: 0 });
});

test("4. duplicates and bad files are reported and excluded from find", () => {
  const { home, claudeAgents, codexAgents } = rosterHome({
    claude: {
      "dup-a.md": md("Dup Engineer", "first copy"),
      "dup-b.md": md("Dup Engineer", "second copy"),
      "bad.md": "no frontmatter here\n",
    },
    codex: { "lit.toml": "name = 'Lit Engineer'\ndescription = \"literal\"\n" },
  });
  const a = run(home, ["audit"]);
  assert.equal(a.status, 1);
  assert.equal(a.json.ok, false);
  assert.deepEqual(a.json.duplicates, [
    { name: "Dup Engineer", paths: [join(claudeAgents, "dup-a.md"), join(claudeAgents, "dup-b.md")] },
  ]);
  assert.deepEqual(a.json.problems.map((p) => p.path).sort(), [
    join(claudeAgents, "bad.md"),
    join(codexAgents, "lit.toml"),
  ]);
  const q = run(home, ["find", "--query", "dup engineer"]);
  assert.equal(q.json.candidates.length, 1);
  assert.equal(q.json.candidates[0].profile, join(claudeAgents, "dup-a.md"), "first sorted duplicate wins, deterministically");
  const lit = run(home, ["find", "--query", "literal"]);
  assert.deepEqual(lit.json.candidates, [], "problem files never appear in find results");
});

test("5. deterministic find: score order, name tiebreak, byte-identical runs, --limit", () => {
  const { home } = rosterHome({
    claude: {
      "persist.md": md("Postgres Migration Engineer", "schema tools for databases"),
      "schemadoc.md": md("Schema Doc Writer", "postgres migration guides"),
      "db.md": md("Database Helper", "postgres tips"),
    },
    codex: {
      "persist.toml": toml("Postgres Migration Engineer", "schema tools"),
      "schemadoc.toml": toml("Schema Doc Writer", "postgres migration guides"),
      "db.toml": toml("Database Helper", "postgres tips"),
    },
  });
  const args = ["find", "--query", "postgres schema"];
  const r1 = run(home, args);
  const r2 = run(home, args);
  assert.equal(r1.status, 0);
  assert.equal(r1.stdout, r2.stdout, "two runs are byte-identical");
  assert.equal(r1.json.query, "postgres schema");
  assert.deepEqual(
    r1.json.candidates.map((c) => [c.name, c.score]),
    [
      ["Postgres Migration Engineer", 4],
      ["Schema Doc Writer", 4],
      ["Database Helper", 1],
    ],
    "name hits outrank description hits; equal scores order by name",
  );
  const limited = run(home, [...args, "--limit", "1"]);
  assert.equal(limited.status, 0);
  assert.deepEqual(limited.json.candidates.map((c) => c.name), ["Postgres Migration Engineer"]);
});

test("6. --name is exact: case matters, missing name notes and exits 1", () => {
  const { home } = rosterHome({
    claude: { "foo.md": md("Foo Engineer", "foo things") },
    codex: { "foo.toml": toml("Foo Engineer", "toml foo") },
  });
  const hit = run(home, ["find", "--name", "Foo Engineer"]);
  assert.equal(hit.status, 0);
  assert.equal(hit.json.candidates.length, 1);
  assert.equal(hit.json.candidates[0].name, "Foo Engineer");
  const lower = run(home, ["find", "--name", "foo engineer"]);
  assert.equal(lower.status, 1);
  assert.deepEqual(lower.json.candidates, []);
  assert.equal(lower.json.note, 'no installed profile named "foo engineer"');
  const missing = run(home, ["find", "--name", "Nobody Here"]);
  assert.equal(missing.status, 1);
  assert.deepEqual(missing.json.candidates, []);
  assert.equal(missing.json.note, 'no installed profile named "Nobody Here"');
  assert.equal(missing.json.name, "Nobody Here");
});

test("7. no cache: roster changes are visible to the next invocation", () => {
  const { home, claudeAgents, codexAgents } = rosterHome({
    claude: { "foo.md": md("Foo Engineer", "foo things") },
    codex: { "foo.toml": toml("Foo Engineer", "toml foo") },
  });
  assert.equal(run(home, ["find", "--name", "Bar Engineer"]).status, 1);
  writeFileSync(join(claudeAgents, "bar.md"), md("Bar Engineer", "bar things"));
  writeFileSync(join(codexAgents, "bar.toml"), toml("Bar Engineer", "toml bar"));
  const after = run(home, ["find", "--name", "Bar Engineer"]);
  assert.equal(after.status, 0);
  assert.equal(after.json.candidates[0].name, "Bar Engineer");
});

test("8. no token overlap: empty candidates, broaden note, exit 1", () => {
  const { home } = rosterHome({
    claude: { "foo.md": md("Foo Engineer", "foo things") },
    codex: { "foo.toml": toml("Foo Engineer", "toml foo") },
  });
  const r = run(home, ["find", "--query", "kubernetes helmfile"]);
  assert.equal(r.status, 1);
  assert.deepEqual(r.json.candidates, []);
  assert.equal(r.json.note, "no profile matched; broaden the query, then stop and report");
});

test("9. usage errors exit 2 with a stderr message; --help exits 0", () => {
  assert.equal(run(rosterHome().home, []).status, 2);
  const noFlags = run(rosterHome().home, ["find"]);
  assert.equal(noFlags.status, 2);
  assert.match(noFlags.stderr, /specialists\.mjs:/);
  assert.equal(run(rosterHome().home, ["find", "--query", "x", "--limit", "0"]).status, 2);
  assert.equal(run(rosterHome().home, ["frobnicate"]).status, 2);
  const help = run(rosterHome().home, ["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /usage/i);
});
