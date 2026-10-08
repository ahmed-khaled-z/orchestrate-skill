// Search aliases, twin drift, and instruction coverage.
// Run: node --test tests/specialists-reliability.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "specialists.mjs");

function md(name, description, body = "Body.") {
  return `---\nname: "${name}"\ndescription: "${description}"\n---\n\n${body}\n`;
}

function toml(name, description, body = "Body.") {
  return `name = "${name}"\ndescription = "${description}"\ndeveloper_instructions = ${JSON.stringify(`\n${body}\n`)}\n`;
}

function rosterHome({ claude = {}, codex = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), "orchestrate-spec-rel-"));
  const claudeAgents = join(home, ".claude", "agents");
  const codexAgents = join(home, ".codex", "agents");
  mkdirSync(claudeAgents, { recursive: true });
  mkdirSync(codexAgents, { recursive: true });
  for (const [file, text] of Object.entries(claude)) writeFileSync(join(claudeAgents, file), text);
  for (const [file, text] of Object.entries(codex)) writeFileSync(join(codexAgents, file), text);
  return home;
}

function run(home, args) {
  const r = spawnSync("node", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "", CODEX_HOME: "" },
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    json: (r.stdout ?? "").startsWith("{") ? JSON.parse(r.stdout) : null,
  };
}

test("Arabic auth query matches the authentication profile and reports alias evidence", () => {
  const home = rosterHome({
    claude: {
      "auth.md": md("Authentication Engineer", "Handles login and account access"),
      "pay.md": md("Payment Engineer", "Invoices and checkout"),
    },
    codex: {
      "auth.toml": toml("Authentication Engineer", "Handles login and account access"),
      "pay.toml": toml("Payment Engineer", "Invoices and checkout"),
    },
  });
  const r = run(home, ["find", "--query", "مصادقة"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.query, "مصادقة");
  assert.ok(r.json.normalized.includes("authentication"));
  assert.ok(r.json.normalized.includes("login"));
  assert.deepEqual(
    r.json.candidates.map((c) => c.name),
    ["Authentication Engineer"],
  );
  assert.ok(
    r.json.candidates[0].evidence.some((e) => e.via === "alias" && e.token === "authentication"),
  );
});

test("english sign-in synonym matches the authentication profile", () => {
  const home = rosterHome({
    claude: { "auth.md": md("Authentication Engineer", "account access") },
    codex: { "auth.toml": toml("Authentication Engineer", "account access") },
  });
  const r = run(home, ["find", "--query", "sign-in"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.candidates[0].name, "Authentication Engineer");
  assert.ok(r.json.candidates[0].evidence.some((e) => e.via === "synonym"));
});

test("exact --name stays exact and does not expand synonyms", () => {
  const home = rosterHome({
    claude: { "auth.md": md("Authentication Engineer", "login") },
    codex: { "auth.toml": toml("Authentication Engineer", "login") },
  });
  const r = run(home, ["find", "--name", "login"]);
  assert.equal(r.status, 1);
  assert.deepEqual(r.json.candidates, []);
});

test("instruction drift is reported and excluded from find", () => {
  const home = rosterHome({
    claude: { "auth.md": md("Authentication Engineer", "login security", "alpha instructions") },
    codex: { "auth.toml": toml("Authentication Engineer", "login security", "beta instructions") },
  });
  const audit = run(home, ["audit"]);
  assert.equal(audit.status, 1);
  assert.equal(audit.json.ok, false);
  assert.equal(audit.json.drift.length, 1);
  assert.equal(audit.json.drift[0].name, "Authentication Engineer");
  assert.equal(audit.json.drift[0].instructions, true);
  assert.equal(audit.json.drift[0].description, false);
  const found = run(home, ["find", "--query", "login"]);
  assert.deepEqual(found.json.candidates, []);
  assert.match(found.json.note, /drift/i);
  const named = run(home, ["find", "--name", "Authentication Engineer"]);
  assert.deepEqual(named.json.candidates, []);
});

test("description drift is excluded", () => {
  const home = rosterHome({
    claude: { "pay.md": md("Payment Engineer", "payment billing", "same body") },
    codex: { "pay.toml": toml("Payment Engineer", "payment invoices", "same body") },
  });
  const audit = run(home, ["audit"]);
  assert.equal(audit.json.drift[0].description, true);
  assert.equal(audit.json.drift[0].instructions, false);
  const found = run(home, ["find", "--name", "Payment Engineer"]);
  assert.deepEqual(found.json.candidates, []);
});

test("missing instructions are unavailable and are not claimed to match", () => {
  const home = rosterHome({
    claude: { "auth.md": md("Authentication Engineer", "login security") },
    codex: { "auth.toml": `name = "Authentication Engineer"\ndescription = "login security"\n` },
  });
  const audit = run(home, ["audit"]);
  assert.equal(audit.status, 1);
  assert.equal(audit.json.ok, false);
  assert.equal(audit.json.coverage.identity, "checked");
  assert.equal(audit.json.coverage.description, "checked");
  assert.equal(audit.json.coverage.instructions, "not-checked");
  assert.ok(audit.json.unavailable.some((u) => u.name === "Authentication Engineer"));
  assert.equal(JSON.stringify(audit.json).includes('"instructionsMatch":true'), false);
});

test("standalone Markdown dividers are formatting-only, not drift", () => {
  const claudeBody = "First rule.\n\n---\n\nSecond rule.\n\n***\n\nThird rule.";
  const codexBody = "First rule.\n\nSecond rule.\n\nThird rule.";
  const home = rosterHome({
    claude: { "tw.md": md("Technical Writer", "docs and prose", claudeBody) },
    codex: { "tw.toml": toml("Technical Writer", "docs and prose", codexBody) },
  });
  const audit = run(home, ["audit"]);
  assert.equal(audit.status, 0, audit.stderr);
  assert.equal(audit.json.ok, true);
  assert.deepEqual(audit.json.drift, []);
  assert.deepEqual(audit.json.formattingOnly, ["Technical Writer"]);
  assert.equal(audit.json.coverage.instructions, "checked");
  assert.match(audit.json.coverage.dividers, /divider/i);
  const named = run(home, ["find", "--name", "Technical Writer"]);
  assert.equal(named.status, 0);
  assert.equal(named.json.candidates[0].name, "Technical Writer");
});

test("real instruction drift is still reported when dividers are present", () => {
  const home = rosterHome({
    claude: { "tw.md": md("Technical Writer", "docs", "alpha rules\n\n---\n\nshared tail") },
    codex: { "tw.toml": toml("Technical Writer", "docs", "beta rules\n\nshared tail") },
  });
  const audit = run(home, ["audit"]);
  assert.equal(audit.json.ok, false);
  assert.equal(audit.json.drift.length, 1);
  assert.equal(audit.json.drift[0].instructions, true);
  assert.deepEqual(audit.json.formattingOnly, []);
});

test("a folded multi-line YAML description matches its single-line twin", () => {
  const folded = "---\nname: \"Clinical Evidence Agent\"\ndescription: Evidence standards for AI agents\n  operating in healthcare contexts. Defines how to distinguish validated claims.\n---\n\nBody.\n";
  const home = rosterHome({
    claude: { "cea.md": folded },
    codex: { "cea.toml": toml("Clinical Evidence Agent", "Evidence standards for AI agents operating in healthcare contexts. Defines how to distinguish validated claims.") },
  });
  const audit = run(home, ["audit"]);
  assert.equal(audit.status, 0, `${audit.stderr}\n${audit.stdout}`);
  assert.equal(audit.json.ok, true);
  assert.deepEqual(audit.json.drift, []);
});
