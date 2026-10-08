// Tests for scripts/fleet.mjs — run: node --test tests/
// Uses a throwaway XDG_CONFIG_HOME so the user's real fleet is never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FLEET = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "fleet.mjs");

function fleetHome(lanes) {
  const home = mkdtempSync(join(tmpdir(), "orchestrate-fleet-"));
  mkdirSync(join(home, "delegate-skills"));
  writeFileSync(
    join(home, "delegate-skills", "config.json"),
    JSON.stringify({ version: "delegate-fleet.v1", lanes }, null, 2),
  );
  return home;
}

function run(home, ...args) {
  const r = spawnSync("node", [FLEET, ...args, "--cwd", tmpdir()], {
    encoding: "utf8",
    env: { ...process.env, XDG_CONFIG_HOME: home },
  });
  return { ...r, json: r.status === 0 && r.stdout ? JSON.parse(r.stdout) : null };
}

const BASE = {
  implementer: { implementer: "opencode", model: "x/impl", variant: "high" },
  "small-edit": { implementer: "opencode", model: "x/small", variant: "high" },
  "ui-ux": { implementer: "agy", model: "gem" },
  "fix-bugs": { implementer: "opencode", model: "x/kimi", variant: "high" },
  docs: { implementer: "opencode", model: "x/mimo", variant: "high" },
  "review-main": { implementer: "claude", model: "opus", effort: "high", readOnly: true },
  "review-debate": { implementer: "codex", model: "gpt", effort: "high", readOnly: true },
  "plan-main": { implementer: "claude", model: "opus", effort: "high" },
};

test("list reads the live fleet and infers roles from names", () => {
  const { json, stderr } = run(fleetHome(BASE), "list");
  assert.ok(json, stderr);
  const byName = Object.fromEntries(json.lanes.map((l) => [l.name, l]));
  assert.deepEqual(byName["ui-ux"].roles, ["ui"]);
  assert.deepEqual(byName["small-edit"].roles, ["quick"]);
  assert.deepEqual(byName["fix-bugs"].roles, ["debug"]);
  assert.deepEqual(byName["implementer"].roles, ["feature"]);
  assert.deepEqual(byName["review-main"].roles, ["review"]);
  assert.equal(byName["review-main"].readOnly, true);
  assert.equal(byName["ui-ux"].effort.dial, null, "agy has no reasoning dial");
  assert.equal(byName["review-main"].effort.dial, "effort");
  assert.ok(byName["review-main"].effort.values.includes("high"));
  assert.equal(byName["implementer"].effort.dial, "variant");
  assert.equal(byName["implementer"].skill, "opencode-delegate");
  assert.equal(byName["implementer"].model, "x/impl");
});

test("declared roles beat name inference", () => {
  const lanes = { ...BASE, weird: { implementer: "claude", roles: ["tests", "debug"] } };
  const { json } = run(fleetHome(lanes), "list");
  const weird = json.lanes.find((l) => l.name === "weird");
  assert.deepEqual(weird.roles, ["tests", "debug"]);
  assert.equal(weird.rolesSource, "declared");
});

test("pick ranks by role, respects --write, falls back to feature", () => {
  const home = fleetHome(BASE);
  const ui = run(home, "pick", "--need", "ui", "--write").json;
  assert.equal(ui.candidates[0].name, "ui-ux");
  assert.equal(ui.candidates[0].fallback, false);

  const review = run(home, "pick", "--need", "review", "--write").json;
  assert.ok(!review.candidates.some((c) => c.readOnly), "read-only lanes excluded for --write");
  assert.ok(review.candidates.length > 0, "falls back to a writable feature lane");
  assert.equal(review.candidates[0].fallback, true);

  const tests = run(home, "pick", "--need", "tests").json;
  assert.equal(tests.candidates[0].fallback, true, "no tests lane → feature fallback");
  assert.equal(tests.candidates[0].roles[0], "feature");
});

test("pick --read-only prefers readOnly lanes and prints the relay command", () => {
  const { json } = run(fleetHome(BASE), "pick", "--need", "review", "--read-only");
  assert.equal(json.candidates[0].name, "review-main");
  assert.match(json.candidates[0].command, /relay\.mjs" --brief <brief> --lane review-main --cd <repo>/);
  assert.match(json.candidates[0].command, /--read-only/);
});

test("Scenario G: a changed fleet is picked up with no change to this skill", () => {
  const home = fleetHome(BASE);
  const before = run(home, "pick", "--need", "ui").json.candidates[0];
  assert.equal(before.implementer, "agy");
  assert.equal(before.model, "gem");

  // Reconfigure the fleet (as delegate-setup would): swap the UI lane and add a tests lane.
  writeFileSync(
    join(home, "delegate-skills", "config.json"),
    JSON.stringify({
      version: "delegate-fleet.v1",
      lanes: {
        ...BASE,
        "ui-ux": { implementer: "codex", model: "gpt-ui", effort: "medium" },
        "unit-tests": { implementer: "claude", effort: "low", roles: ["tests"] },
      },
    }),
  );
  const after = run(home, "pick", "--need", "ui").json.candidates[0];
  assert.equal(after.implementer, "codex");
  assert.equal(after.model, "gpt-ui");
  assert.equal(after.effort.dial, "effort");
  const tests = run(home, "pick", "--need", "tests").json.candidates[0];
  assert.equal(tests.name, "unit-tests");
  assert.equal(tests.fallback, false);
});

test("pick fails loud when nothing can serve the need", () => {
  const home = fleetHome({ "review-main": BASE["review-main"] });
  const r = run(home, "pick", "--need", "feature", "--write");
  assert.equal(r.json.candidates.length, 0);
  assert.match(r.json.note, /no lane/i);
});

test("effort mapping: level → dial value per implementer", () => {
  const { json } = run(fleetHome(BASE), "effort", "--lane", "review-main", "--level", "medium");
  assert.deepEqual(json, { lane: "review-main", dial: "effort", value: "medium", flag: "--effort medium" });
  const oc = run(fleetHome(BASE), "effort", "--lane", "implementer", "--level", "low").json;
  assert.equal(oc.dial, "variant");
  assert.equal(oc.value, null, "variant values are model-specific: keep the lane dial");
  assert.equal(oc.flag, null);
  const agy = run(fleetHome(BASE), "effort", "--lane", "ui-ux", "--level", "high").json;
  assert.equal(agy.dial, null);
});

function fakeSkills(helpBody, helpStatus) {
  const root = mkdtempSync(join(tmpdir(), "orchestrate-fleet-skills-"));
  const setupScripts = join(root, "delegate-setup", "scripts");
  mkdirSync(setupScripts, { recursive: true });
  const realScripts = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "delegate-setup", "scripts");
  symlinkSync(join(realScripts, "config.mjs"), join(setupScripts, "config.mjs"));
  symlinkSync(join(realScripts, "implementers.mjs"), join(setupScripts, "implementers.mjs"));
  const relayDir = join(root, "grok-delegate", "scripts");
  mkdirSync(relayDir, { recursive: true });
  writeFileSync(
    join(relayDir, "relay.mjs"),
    `if (process.argv.includes("--help")) {\n  process.stdout.write(${JSON.stringify(helpBody)});\n  process.exit(${helpStatus});\n}\nprocess.exit(0);\n`,
  );
  return join(root, "delegate-setup");
}

function runIn(home, setupDir, args) {
  const r = spawnSync("node", [FLEET, ...args], {
    encoding: "utf8",
    env: { ...process.env, XDG_CONFIG_HOME: home, DELEGATE_SETUP_DIR: setupDir },
  });
  return {
    status: r.status,
    stderr: r.stderr ?? "",
    stdout: r.stdout ?? "",
    json: (r.stdout ?? "").trim().startsWith("{") ? JSON.parse(r.stdout) : null,
  };
}

test("nonzero or incomplete relay help does not invent selector flags", () => {
  const home = fleetHome({
    "fix-bugs": { implementer: "grok", model: "grok-code-fast-1", effort: "high", roles: ["debug"] },
  });
  const failed = runIn(home, fakeSkills("--brief --cd --lane --model --effort\n", 2), ["pick", "--need", "debug", "--cwd", tmpdir()]);
  assert.equal(failed.status, 0, failed.stderr);
  assert.equal(failed.json.candidates[0].command, null);
  assert.equal(`${failed.stdout}`.includes("--lane"), false);
  const thin = runIn(home, fakeSkills("--brief --cd\n", 0), ["pick", "--need", "debug", "--cwd", tmpdir()]);
  assert.equal(thin.status, 0, thin.stderr);
  assert.equal(thin.json.candidates[0].command, null);
  assert.equal(`${thin.stdout}`.includes("--model"), false);
  const preserved = runIn(home, fakeSkills("--brief --cd --model --effort\n", 0), ["pick", "--need", "debug", "--cwd", tmpdir()]);
  assert.equal(preserved.status, 0, preserved.stderr);
  assert.match(preserved.json.candidates[0].command, /--model grok-code-fast-1/);
  assert.equal(preserved.json.candidates[0].command.includes("--lane"), false);
});

test("pick prints only flags the actual relay accepts (grok has no --lane)", () => {
  const home = fleetHome({
    "fix-bugs": { implementer: "grok", model: "grok-code-fast-1", effort: "high" },
    "plan-main": { implementer: "claude", model: "opus", effort: "high" },
  });
  const grok = run(home, "pick", "--need", "debug").json;
  assert.equal(grok.candidates[0].name, "fix-bugs");
  assert.equal(grok.candidates[0].command.includes("--lane"), false);
  assert.match(grok.candidates[0].command, /--model grok-code-fast-1/);
  assert.match(grok.candidates[0].command, /--brief <brief>/);
  const claude = run(home, "pick", "--need", "plan").json;
  assert.equal(claude.candidates[0].name, "plan-main");
  assert.match(claude.candidates[0].command, /--lane plan-main/);
});
