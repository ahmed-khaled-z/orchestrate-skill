// fleet.mjs preflight — fake binaries only; never calls a real provider.
// Run: node --test tests/fleet-preflight.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const FLEET = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "fleet.mjs");
const NODE_BIN = dirname(process.execPath);

function fleetHome(lanes) {
  const home = mkdtempSync(join(tmpdir(), "orchestrate-preflight-"));
  mkdirSync(join(home, "delegate-skills"));
  const configPath = join(home, "delegate-skills", "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ version: "delegate-fleet.v1", lanes }, null, 2),
  );
  return { home, configPath };
}

function binDir() {
  return mkdtempSync(join(tmpdir(), "orchestrate-bins-"));
}

function writeBin(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, body, { mode: 0o755 });
  return path;
}

function envFor(home, bins) {
  return {
    ...process.env,
    XDG_CONFIG_HOME: home,
    PATH: `${bins}${delimiter}${NODE_BIN}${delimiter}/usr/bin:/bin`,
    ORCHESTRATE_PROBE_MS: process.env.ORCHESTRATE_PROBE_MS || "2000",
  };
}

function run(home, bins, args, extraEnv = {}) {
  const r = spawnSync("node", [FLEET, ...args], {
    encoding: "utf8",
    env: { ...envFor(home, bins), ...extraEnv },
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    json: (r.stdout ?? "").trim().startsWith("{") ? JSON.parse(r.stdout) : null,
  };
}

const CLAUDE_LANE = {
  implementer: { implementer: "claude", model: "opus", effort: "high" },
};

test("ready lane reports version and auth without leaking probe output", () => {
  const { home, configPath } = fleetHome(CLAUDE_LANE);
  const bins = binDir();
  const before = statSync(configPath).mtimeMs;
  writeBin(
    bins,
    "claude",
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "claude 9.9.9"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo '{"loggedIn":true,"token":"secret-token-XYZ"}'; exit 0; fi
echo unexpected >&2; exit 3
`,
  );
  const r = run(home, bins, ["preflight", "--lane", "implementer", "--level", "high", "--cwd", tmpdir()]);
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.equal(r.json.status, "ready");
  assert.equal(r.json.blocked, false);
  assert.equal(r.json.checks.binary.status, "ready");
  assert.equal(r.json.checks.binary.version, "claude 9.9.9");
  assert.equal(r.json.checks.auth.status, "ready");
  assert.equal(r.json.checks.model.status, "ready");
  assert.equal(r.json.checks.effort.flag, "--effort high");
  assert.equal(`${r.stdout}${r.stderr}`.includes("secret-token-XYZ"), false);
  assert.equal(statSync(configPath).mtimeMs, before);
});

test("a missing binary is unavailable and blocks", () => {
  const { home } = fleetHome(CLAUDE_LANE);
  const r = run(home, binDir(), ["preflight", "--lane", "implementer", "--cwd", tmpdir()]);
  assert.equal(r.status, 1);
  assert.equal(r.json.status, "unavailable");
  assert.equal(r.json.blocked, true);
  assert.equal(r.json.checks.binary.status, "unavailable");
});

test("auth false is unavailable and blocks", () => {
  const { home } = fleetHome(CLAUDE_LANE);
  const bins = binDir();
  writeBin(
    bins,
    "claude",
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "claude 1.0.0"; exit 0; fi
if [ "$1" = "auth" ]; then echo '{"loggedIn":false}'; exit 0; fi
exit 3
`,
  );
  const r = run(home, bins, ["preflight", "--lane", "implementer", "--cwd", tmpdir()]);
  assert.equal(r.status, 1);
  assert.equal(r.json.checks.auth.status, "unavailable");
  assert.equal(r.json.blocked, true);
});

test("a full model name outside the static alias list is unknown, not unavailable", () => {
  const { home } = fleetHome({
    implementer: { implementer: "claude", model: "claude-opus-5-5", effort: "high" },
  });
  const bins = binDir();
  writeBin(
    bins,
    "claude",
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "claude 1.0.0"; exit 0; fi
if [ "$1" = "auth" ]; then echo '{"loggedIn":true}'; exit 0; fi
exit 3
`,
  );
  const r = run(home, bins, ["preflight", "--lane", "implementer", "--cwd", tmpdir()]);
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.equal(r.json.checks.model.status, "unknown");
  assert.equal(r.json.blocked, false);
  assert.equal(Object.hasOwn(r.json.checks.model, "values"), false);
  assert.equal(`${r.stdout}`.includes("claude-opus-4"), false);
});

test("a lane with no model configured is not reported model-ready", () => {
  const { home } = fleetHome({
    implementer: { implementer: "claude", effort: "high" },
  });
  const bins = binDir();
  writeBin(
    bins,
    "claude",
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "claude 1.0.0"; exit 0; fi
if [ "$1" = "auth" ]; then echo '{"loggedIn":true}'; exit 0; fi
exit 3
`,
  );
  const r = run(home, bins, ["preflight", "--lane", "implementer", "--cwd", tmpdir()]);
  assert.equal(r.json.checks.model.status, "unknown");
  assert.notEqual(r.json.checks.model.status, "ready");
});

test("effort on dial-less and variant lanes is brief-only, not unsupported", () => {
  const { home } = fleetHome({
    "ui-ux": { implementer: "agy", model: "gem" },
    implementer: { implementer: "opencode", model: "x/impl", variant: "high" },
  });
  const bins = binDir();
  writeBin(
    bins,
    "agy",
    `#!/bin/sh
if [ "$1" = "changelog" ]; then echo "agy: 1.2.3"; exit 0; fi
if [ "$1" = "models" ]; then echo "gem"; exit 0; fi
exit 3
`,
  );
  writeBin(
    bins,
    "opencode",
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "opencode 1.0.0"; exit 0; fi
if [ "$1" = "auth" ]; then echo "● default"; exit 0; fi
if [ "$1" = "models" ]; then echo "x/impl"; exit 0; fi
exit 3
`,
  );
  const agy = run(home, bins, ["preflight", "--lane", "ui-ux", "--level", "high", "--cwd", tmpdir()]);
  assert.equal(agy.json.checks.effort.status, "ready");
  assert.equal(agy.json.checks.effort.flag, null);
  assert.equal(agy.json.checks.effort.briefOnly, true);
  const oc = run(home, bins, ["preflight", "--lane", "implementer", "--level", "low", "--cwd", tmpdir()]);
  assert.equal(oc.json.checks.effort.status, "ready");
  assert.equal(oc.json.checks.effort.flag, null);
  assert.equal(oc.json.checks.effort.briefOnly, true);
  assert.equal(oc.json.blocked, false);
});

test("read-only on an implementer that does not support it is unsupported and blocks", () => {
  const { home } = fleetHome({
    "ui-ux": { implementer: "agy", model: "gem" },
  });
  const bins = binDir();
  writeBin(
    bins,
    "agy",
    `#!/bin/sh
if [ "$1" = "changelog" ]; then echo "agy: 1.2.3"; exit 0; fi
if [ "$1" = "models" ]; then echo "gem"; exit 0; fi
echo "flag $1" >&2; exit 3
`,
  );
  const r = run(home, bins, ["preflight", "--lane", "ui-ux", "--level", "high", "--read-only", "--cwd", tmpdir()]);
  assert.equal(r.status, 1);
  assert.equal(r.json.status, "unsupported");
  assert.equal(r.json.blocked, true);
  assert.equal(r.json.checks.readOnly.status, "unsupported");
  assert.equal(r.json.checks.effort.flag, null);
  assert.equal(r.json.checks.effort.status, "ready");
  assert.equal(r.json.checks.effort.briefOnly, true);
});

test("a hanging version probe is bounded and blocks", () => {
  const { home } = fleetHome(CLAUDE_LANE);
  const bins = binDir();
  writeBin(bins, "claude", `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
  const started = Date.now();
  const r = run(home, bins, ["preflight", "--lane", "implementer", "--cwd", tmpdir()], {
    ORCHESTRATE_PROBE_MS: "300",
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3000, `probe was not bounded (${elapsed}ms)`);
  assert.equal(r.status, 1);
  assert.equal(r.json.blocked, true);
  assert.equal(r.json.checks.binary.status, "unavailable");
});

test("untrusted project config blocks preflight and pick still lists the lane", () => {
  const home = mkdtempSync(join(tmpdir(), "orchestrate-preflight-xdg-"));
  mkdirSync(join(home, "delegate-skills"));
  writeFileSync(
    join(home, "delegate-skills", "config.json"),
    JSON.stringify({ version: "delegate-fleet.v1", lanes: {} }),
  );
  const repo = mkdtempSync(join(tmpdir(), "orchestrate-preflight-repo-"));
  spawnSync("git", ["init"], { cwd: repo, encoding: "utf8" });
  mkdirSync(join(repo, ".delegate"));
  writeFileSync(
    join(repo, ".delegate", "config.json"),
    JSON.stringify({
      version: "delegate-fleet.v1",
      lanes: { implementer: { implementer: "claude", model: "opus", effort: "high", roles: ["feature"] } },
    }),
  );
  const bins = binDir();
  writeBin(bins, "claude", "#!/bin/sh\nsleep 30\n");
  const started = Date.now();
  const pre = run(home, bins, ["preflight", "--lane", "implementer", "--cwd", repo]);
  assert.ok(Date.now() - started < 2000, "untrusted config must not run probes");
  assert.equal(pre.status, 1);
  assert.equal(pre.json.blocked, true);
  assert.equal(pre.json.untrustedProjectConfig, true);
  const pick = run(home, bins, ["pick", "--need", "feature", "--cwd", repo]);
  assert.equal(pick.status, 0, pick.stderr);
  assert.equal(pick.json.candidates[0].name, "implementer");
  assert.equal(pick.json.untrustedProjectConfig, true);
});

test("an implementer with no model listing is not reported ready and invents no models", () => {
  const { home } = fleetHome({
    docs: { implementer: "kimi", model: "kimi-latest" },
  });
  const bins = binDir();
  writeBin(
    bins,
    "kimi",
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "kimi 1.0.0"; exit 0; fi
if [ "$1" = "provider" ]; then echo "source=oauth"; exit 0; fi
echo should-not-list-models >&2; exit 3
`,
  );
  const r = run(home, bins, ["preflight", "--lane", "docs", "--cwd", tmpdir()]);
  assert.equal(r.json.checks.model.status === "ready", false);
  assert.equal(Object.hasOwn(r.json.checks.model, "values"), false);
  assert.equal(`${r.stdout}${r.stderr}`.includes("should-not-list-models"), false);
});

test("changed grok model output is unknown, not an exhaustive miss", () => {
  const { home } = fleetHome({
    implementer: { implementer: "grok", model: "grok-4", effort: "high" },
  });
  const bins = binDir();
  writeBin(
    bins,
    "grok",
    `#!/bin/sh
if [ "$1" = "version" ]; then echo "grok 1.0.0"; exit 0; fi
if [ "$1" = "models" ]; then echo "model list format changed"; exit 0; fi
exit 3
`,
  );
  const r = run(home, bins, ["preflight", "--lane", "implementer", "--cwd", tmpdir()]);
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.equal(r.json.checks.model.status, "unknown");
  assert.equal(r.json.blocked, false);
  assert.equal(r.json.status, "unknown");
});

test("a recognized grok listing can still call a missing model unavailable", () => {
  const { home } = fleetHome({
    implementer: { implementer: "grok", model: "grok-missing", effort: "high" },
  });
  const bins = binDir();
  writeBin(
    bins,
    "grok",
    `#!/bin/sh
if [ "$1" = "version" ]; then echo "grok 1.0.0"; exit 0; fi
if [ "$1" = "models" ]; then printf '%s\\n' "* grok-4 (default)" "* grok-3"; exit 0; fi
exit 3
`,
  );
  const r = run(home, bins, ["preflight", "--lane", "implementer", "--cwd", tmpdir()]);
  assert.equal(r.status, 1, `${r.stderr}\n${r.stdout}`);
  assert.equal(r.json.checks.model.status, "unavailable");
  assert.equal(r.json.blocked, true);
});

test("untrusted project config blocks a global lane before probes", () => {
  const home = mkdtempSync(join(tmpdir(), "orchestrate-preflight-xdg-"));
  mkdirSync(join(home, "delegate-skills"));
  writeFileSync(
    join(home, "delegate-skills", "config.json"),
    JSON.stringify({
      version: "delegate-fleet.v1",
      lanes: { implementer: { implementer: "grok", model: "grok-4", effort: "high", roles: ["feature"] } },
    }),
  );
  const repo = mkdtempSync(join(tmpdir(), "orchestrate-preflight-repo-"));
  spawnSync("git", ["init"], { cwd: repo, encoding: "utf8" });
  mkdirSync(join(repo, ".delegate"));
  writeFileSync(
    join(repo, ".delegate", "config.json"),
    JSON.stringify({
      version: "delegate-fleet.v1",
      lanes: { other: { implementer: "claude", model: "opus", effort: "high", roles: ["docs"] } },
    }),
  );
  const bins = binDir();
  const probeLog = join(bins, "probes.log");
  writeBin(
    bins,
    "grok",
    `#!/bin/sh
echo "$1" >> ${JSON.stringify(probeLog)}
if [ "$1" = "version" ]; then echo "grok 1.0.0"; exit 0; fi
if [ "$1" = "models" ]; then echo "* grok-4"; exit 0; fi
exit 3
`,
  );
  const started = Date.now();
  const pre = run(home, bins, ["preflight", "--lane", "implementer", "--cwd", repo]);
  assert.ok(Date.now() - started < 2000, "untrusted config must not run probes");
  assert.equal(pre.status, 1, `${pre.stderr}\n${pre.stdout}`);
  assert.equal(pre.json.blocked, true);
  assert.equal(pre.json.untrustedProjectConfig, true);
  assert.equal(pre.json.checks?.binary, undefined);
  assert.equal(existsSync(probeLog), false);
  const pick = run(home, bins, ["pick", "--need", "feature", "--cwd", repo]);
  assert.equal(pick.status, 0, pick.stderr);
  assert.equal(pick.json.untrustedProjectConfig, true);
  assert.equal(pick.json.candidates[0].name, "implementer");
});

test("preflight --help exits 0 and list still works", () => {
  const { home } = fleetHome(CLAUDE_LANE);
  const help = run(home, binDir(), ["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /preflight/);
  const list = run(home, binDir(), ["list", "--cwd", tmpdir()]);
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.json.lanes[0].name, "implementer");
});
