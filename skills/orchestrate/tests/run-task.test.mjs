// run-task wrapper. Fake relay and fake CLIs only.
// Run: node --test tests/run-task.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUN = join(ROOT, "scripts", "run-task.mjs");
const NODE = process.execPath;
const NODE_BIN = dirname(NODE);

function fleetHome(lanes) {
  const home = mkdtempSync(join(tmpdir(), "orchestrate-run-xdg-"));
  mkdirSync(join(home, "delegate-skills"));
  writeFileSync(
    join(home, "delegate-skills", "config.json"),
    JSON.stringify({ version: "delegate-fleet.v1", lanes }, null, 2),
  );
  return home;
}

function writeBin(dir, name, body) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body, { mode: 0o755 });
}

function claudeBin(dir) {
  writeBin(
    dir,
    "claude",
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "claude 9.9.9"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo '{"loggedIn":true}'; exit 0; fi
echo unexpected >&2; exit 3
`,
  );
}

function traps(dir, log) {
  const body = `#!/bin/sh\necho "$0 $*" >> ${JSON.stringify(log)}\nexit 99\n`;
  for (const name of ["npm", "pnpm", "yarn", "pytest", "make", "migrate", "jest", "vitest"]) {
    writeBin(dir, name, body);
  }
}

function workspace(parent) {
  const root = parent === undefined
    ? mkdtempSync(join(tmpdir(), "orchestrate-run-ws-"))
    : mkdtempSync(join(parent, "ws-"));
  spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: root });
  writeFileSync(join(root, "keep.txt"), "base\n");
  spawnSync("git", ["add", "keep.txt"], { cwd: root });
  spawnSync("git", ["commit", "-m", "init"], { cwd: root });
  return root;
}

function layout(lanes = { implementer: { implementer: "claude", model: "opus", effort: "high", roles: ["feature"] } }) {
  const home = fleetHome(lanes);
  const bins = mkdtempSync(join(tmpdir(), "orchestrate-run-bin-"));
  const trapLog = join(bins, "traps.log");
  claudeBin(bins);
  traps(bins, trapLog);
  const state = mkdtempSync(join(tmpdir(), "orchestrate-run-state-"));
  const brief = join(state, "brief.md");
  writeFileSync(brief, "Run the task. Do not run npm test or migrations.\n");
  const relayLog = join(state, "relay.log");
  const relay = join(state, "relay.mjs");
  writeFileSync(
    relay,
    `import { writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
if (process.argv.includes("--help")) {
  process.stdout.write("--brief --cd --lane --read-only --effort\\n");
  process.exit(0);
}
const log = process.env.RELAY_LOG;
appendFileSync(log, JSON.stringify(process.argv) + "\\n");
const mode = process.env.RELAY_MODE || "noop";
const ws = process.env.RELAY_WS;
if (mode === "fail") process.exit(1);
if (mode === "write") writeFileSync(ws + "/keep.txt", "changed\\n");
if (mode === "outside") writeFileSync(ws + "/other.txt", "nope\\n");
if (mode === "wait") {
  const deadline = Date.now() + 4000;
  let saw = false;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(readFileSync(process.env.RELAY_STATE, "utf8"));
      if (state.running && state.running.pid && state.running.baseline && state.workspace) {
        saw = true;
        break;
      }
    } catch { /* not reserved yet */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  writeFileSync(process.env.RELAY_SAW, saw ? "yes" : "no");
  process.exit(saw ? 0 : 2);
}
if (mode === "hang") {
  writeFileSync(ws + "/partial.txt", "partial\\n");
  spawn(process.execPath, [process.env.RELAY_DESC], { stdio: "ignore" });
  setInterval(() => {}, 1000);
} else process.exit(0);
`,
  );
  const desc = join(state, "desc.mjs");
  writeFileSync(
    desc,
    `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1000);
`,
  );
  return { home, bins, trapLog, state, brief, relay, relayLog, desc };
}

function invoke(ctx, args, extraEnv = {}) {
  const r = spawnSync(NODE, [RUN, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      XDG_CONFIG_HOME: ctx.home,
      PATH: `${ctx.bins}${delimiter}${NODE_BIN}${delimiter}/usr/bin:/bin`,
      RELAY_LOG: ctx.relayLog,
      RELAY_WS: "",
      RELAY_MODE: "noop",
      RELAY_DESC: ctx.desc,
      RELAY_STATE: "",
      RELAY_SAW: "",
      ORCHESTRATE_PROBE_MS: "2000",
      ...extraEnv,
    },
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    json: (r.stdout ?? "").trim().startsWith("{") ? JSON.parse(r.stdout) : null,
  };
}

function baseArgs(ctx, ws, extra = []) {
  return [
    "--task-id", "task-1",
    "--state-dir", ctx.state,
    "--brief", ctx.brief,
    "--lane", "implementer",
    "--cwd", ws,
    "--scope", "keep.txt",
    "--timeout", "5s",
    "--overall", "30s",
    "--max-attempts", "2",
    "--relay", ctx.relay,
    ...extra,
  ];
}

function relayCount(ctx) {
  if (!existsSync(ctx.relayLog)) return 0;
  return readFileSync(ctx.relayLog, "utf8").trim().split("\n").filter(Boolean).length;
}

function relayArgv(ctx) {
  const lines = readFileSync(ctx.relayLog, "utf8").trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("invalid scope and timeout are rejected before the relay starts", () => {
  const ctx = layout();
  const ws = workspace();
  const badScope = invoke(ctx, baseArgs(ctx, ws, ["--scope", "../escape"]));
  assert.equal(badScope.status, 2);
  assert.equal(relayCount(ctx), 0);
  const badTime = invoke(ctx, [
    "--task-id", "task-1",
    "--state-dir", ctx.state,
    "--brief", ctx.brief,
    "--lane", "implementer",
    "--cwd", ws,
    "--scope", "keep.txt",
    "--timeout", "0s",
    "--overall", "30s",
    "--max-attempts", "2",
    "--relay", ctx.relay,
  ]);
  assert.equal(badTime.status, 2);
  assert.equal(relayCount(ctx), 0);
});

test("unavailable preflight does not dispatch", () => {
  const ctx = layout();
  writeBin(ctx.bins, "claude", "#!/bin/sh\nexit 1\n");
  const ws = workspace();
  const r = invoke(ctx, baseArgs(ctx, ws), { RELAY_WS: ws });
  assert.equal(r.status, 1);
  assert.equal(r.json.dispatched, false);
  assert.equal(r.json.preflight.blocked, true);
  assert.equal(relayCount(ctx), 0);
});

test("unsupported read-only preflight does not dispatch", () => {
  const ctx = layout({ "ui-ux": { implementer: "agy", model: "gem", roles: ["ui"] } });
  writeBin(
    ctx.bins,
    "agy",
    `#!/bin/sh
if [ "$1" = "changelog" ]; then echo "agy: 1.0.0"; exit 0; fi
if [ "$1" = "models" ]; then echo "gem"; exit 0; fi
exit 3
`,
  );
  const ws = workspace();
  const r = invoke(
    ctx,
    [
      "--task-id", "task-ro",
      "--state-dir", ctx.state,
      "--brief", ctx.brief,
      "--lane", "ui-ux",
      "--cwd", ws,
      "--scope", "keep.txt",
      "--timeout", "5s",
      "--overall", "30s",
      "--max-attempts", "2",
      "--read-only",
      "--relay", ctx.relay,
    ],
    { RELAY_WS: ws },
  );
  assert.equal(r.status, 1);
  assert.equal(r.json.dispatched, false);
  assert.equal(r.json.preflight.status, "unsupported");
  assert.equal(relayCount(ctx), 0);
});

test("one invocation dispatches once when the relay fails", () => {
  const ctx = layout();
  const ws = workspace();
  const r = invoke(ctx, baseArgs(ctx, ws), { RELAY_WS: ws, RELAY_MODE: "fail" });
  assert.equal(r.status, 1);
  assert.equal(r.json.dispatched, true);
  assert.equal(relayCount(ctx), 1);
  assert.equal(r.json.verification, "not-run");
});

test("attempt budget survives a fallback lane and a later restart", () => {
  const ctx = layout({
    implementer: { implementer: "claude", model: "opus", effort: "high", roles: ["feature"] },
    backup: { implementer: "claude", model: "sonnet", effort: "high", roles: ["feature"] },
  });
  const ws = workspace();
  const first = invoke(ctx, baseArgs(ctx, ws), { RELAY_WS: ws, RELAY_MODE: "fail" });
  assert.equal(first.json.attemptsUsed, 1);
  const fallback = invoke(
    ctx,
    [
      "--task-id", "task-1",
      "--state-dir", ctx.state,
      "--brief", ctx.brief,
      "--lane", "backup",
      "--cwd", ws,
      "--scope", "keep.txt",
      "--timeout", "30s",
      "--overall", "2h",
      "--max-attempts", "9",
      "--relay", ctx.relay,
    ],
    { RELAY_WS: ws, RELAY_MODE: "fail" },
  );
  assert.equal(fallback.status, 1);
  assert.equal(fallback.json.dispatched, true);
  assert.equal(fallback.json.attemptsUsed, 2);
  assert.equal(fallback.json.lane, "backup");
  const state = JSON.parse(readFileSync(join(ctx.state, "task-1.json"), "utf8"));
  assert.equal(state.attemptLimit, 2);
  assert.equal(state.overallMs, 30000);
  const diagnosis = invoke(
    ctx,
    [
      "--task-id", "task-1",
      "--state-dir", ctx.state,
      "--brief", ctx.brief,
      "--lane", "implementer",
      "--cwd", ws,
      "--scope", "keep.txt",
      "--timeout", "5s",
      "--overall", "30s",
      "--max-attempts", "2",
      "--read-only",
      "--relay", ctx.relay,
    ],
    { RELAY_WS: ws, RELAY_MODE: "noop" },
  );
  assert.equal(diagnosis.json.dispatched, false);
  assert.equal(relayCount(ctx), 2);
});

test("timeout kills relay descendants, keeps partial edits, and blocks retry until inspected", () => {
  const ctx = layout();
  const ws = workspace();
  const pidFile = join(ctx.state, "desc.pid");
  writeFileSync(
    ctx.desc,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
  );
  const r = invoke(
    ctx,
    [
      "--task-id", "task-hang",
      "--state-dir", ctx.state,
      "--brief", ctx.brief,
      "--lane", "implementer",
      "--cwd", ws,
      "--scope", "partial.txt",
      "--timeout", "1s",
      "--overall", "10s",
      "--max-attempts", "2",
      "--relay", ctx.relay,
    ],
    { RELAY_WS: ws, RELAY_MODE: "hang", RELAY_DESC: ctx.desc },
  );
  assert.equal(r.status, 1, `${r.stderr}\n${r.stdout}`);
  assert.equal(r.json.timedOut, true);
  assert.equal(r.json.needsInspection, true);
  assert.equal(readFileSync(join(ws, "partial.txt"), "utf8"), "partial\n");
  assert.ok(r.json.changes.some((c) => c.path === "partial.txt"));
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.equal(alive(pid), false);
  const again = invoke(
    ctx,
    [
      "--task-id", "task-hang",
      "--state-dir", ctx.state,
      "--brief", ctx.brief,
      "--lane", "backup",
      "--cwd", ws,
      "--scope", "partial.txt",
      "--timeout", "5s",
      "--overall", "30s",
      "--max-attempts", "4",
      "--relay", ctx.relay,
    ],
    { RELAY_WS: ws, RELAY_MODE: "noop" },
  );
  assert.equal(again.json.dispatched, false);
  assert.match(`${again.json.error}`, /inspect/i);
  assert.equal(relayCount(ctx), 1);
  const acked = invoke(
    ctx,
    [
      "--task-id", "task-hang",
      "--state-dir", ctx.state,
      "--brief", ctx.brief,
      "--lane", "implementer",
      "--cwd", ws,
      "--scope", "partial.txt",
      "--timeout", "5s",
      "--overall", "30s",
      "--max-attempts", "4",
      "--inspected",
      "--relay", ctx.relay,
    ],
    { RELAY_WS: ws, RELAY_MODE: "noop" },
  );
  assert.equal(acked.status, 0, `${acked.stderr}\n${acked.stdout}`);
  assert.equal(acked.json.dispatched, true);
  assert.equal(relayCount(ctx), 2);
});

test("an edit outside scope fails and the file is left in place", () => {
  const ctx = layout();
  const ws = workspace();
  const r = invoke(ctx, baseArgs(ctx, ws), { RELAY_WS: ws, RELAY_MODE: "outside" });
  assert.equal(r.status, 1);
  assert.equal(r.json.ok, false);
  assert.ok(r.json.outsideScope.some((c) => c.path === "other.txt"));
  assert.equal(readFileSync(join(ws, "other.txt"), "utf8"), "nope\n");
  assert.equal(r.json.needsInspection, true);
});

test("read-only allows an unchanged dirty file and rejects a new edit", () => {
  const ctx = layout();
  const ws = workspace();
  writeFileSync(join(ws, "keep.txt"), "dirty\n");
  const clean = invoke(ctx, baseArgs(ctx, ws, ["--read-only", "--task-id", "task-ro-ok"]), {
    RELAY_WS: ws,
    RELAY_MODE: "noop",
  });
  assert.equal(clean.status, 0, `${clean.stderr}\n${clean.stdout}`);
  assert.equal(clean.json.readOnlyViolation, false);
  assert.deepEqual(clean.json.changes, []);
  const dirty = invoke(
    ctx,
    [
      "--task-id", "task-ro-bad",
      "--state-dir", ctx.state,
      "--brief", ctx.brief,
      "--lane", "implementer",
      "--cwd", ws,
      "--scope", "keep.txt",
      "--timeout", "5s",
      "--overall", "30s",
      "--max-attempts", "2",
      "--read-only",
      "--relay", ctx.relay,
    ],
    { RELAY_WS: ws, RELAY_MODE: "write" },
  );
  assert.equal(dirty.status, 1);
  assert.equal(dirty.json.readOnlyViolation, true);
  assert.equal(readFileSync(join(ws, "keep.txt"), "utf8"), "changed\n");
});

test("the wrapper never launches tests, builds, or migrations", () => {
  const ctx = layout();
  const ws = workspace();
  writeFileSync(ctx.brief, "npm test && make migrate && pytest\n");
  const rejected = invoke(ctx, baseArgs(ctx, ws, ["--verify", "npm test"]), { RELAY_WS: ws });
  assert.equal(rejected.status, 2);
  assert.equal(relayCount(ctx), 0);
  const ran = invoke(ctx, baseArgs(ctx, ws, ["--task-id", "task-verify"]), { RELAY_WS: ws, RELAY_MODE: "noop" });
  assert.equal(ran.status, 0, `${ran.stderr}\n${ran.stdout}`);
  assert.equal(ran.json.verification, "not-run");
  assert.equal(existsSync(ctx.trapLog), false);
});

test("model is never passed and effort is passed only when the fleet maps it", () => {
  const ctx = layout();
  const ws = workspace();
  const withEffort = invoke(ctx, baseArgs(ctx, ws, ["--effort", "high", "--task-id", "task-effort"]), {
    RELAY_WS: ws,
    RELAY_MODE: "noop",
  });
  assert.equal(withEffort.status, 0, `${withEffort.stderr}\n${withEffort.stdout}`);
  const argv = relayArgv(ctx);
  assert.equal(argv.includes("--model"), false);
  assert.ok(argv.includes("--effort"));
  assert.ok(argv.includes("high"));
  assert.ok(argv.includes("--lane"));
  const plain = invoke(ctx, baseArgs(ctx, ws, ["--task-id", "task-plain"]), { RELAY_WS: ws, RELAY_MODE: "noop" });
  assert.equal(plain.status, 0, plain.stderr);
  const plainArgv = relayArgv(ctx);
  assert.equal(plainArgv.includes("--effort"), false);
  assert.equal(plainArgv.includes("--model"), false);
});

function outside(root, target) {
  const rel = relative(realpathSync(root), realpathSync(target));
  return rel === ".." || rel.startsWith(`..${sep}`);
}

function grokRelay(ctx) {
  writeFileSync(
    ctx.relay,
    `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
if (process.argv.includes("--help")) {
  process.stdout.write("--brief --cd --model --effort --read-only --out-dir\\n");
  process.exit(0);
}
appendFileSync(process.env.RELAY_LOG, JSON.stringify(process.argv) + "\\n");
const outFlag = process.argv.indexOf("--out-dir");
if (outFlag < 0) process.exit(2);
const out = process.argv[outFlag + 1];
mkdirSync(out, { recursive: true });
const report = join(out, "final.txt");
writeFileSync(report, "delegate report\\n");
const status = process.env.RESULT_STATUS || "completed";
writeFileSync(join(out, "result.json"), status === "garbage" ? "{not json" : JSON.stringify({
  schema: "delegate-relay.result.v1",
  status,
  exitCode: 0,
  sessionId: "sess-1",
  finalPath: report,
  finalMessage: "delegate report",
}) + "\\n");
process.exit(0);
`,
  );
}

test("grok relay receives the resolved model and effort and keeps the delegate report", () => {
  const ctx = layout();
  grokRelay(ctx);
  const ws = workspace();
  const ok = invoke(ctx, baseArgs(ctx, ws, ["--effort", "high", "--task-id", "task-grok"]), { RELAY_WS: ws });
  assert.equal(ok.status, 0, `${ok.stderr}\n${ok.stdout}`);
  const argv = relayArgv(ctx);
  assert.equal(argv.includes("--lane"), false);
  assert.ok(argv.includes("--model"));
  assert.equal(argv[argv.indexOf("--model") + 1], "opus");
  assert.equal(argv[argv.indexOf("--effort") + 1], "high");
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.artifacts.sessionId, "sess-1");
  assert.equal(readFileSync(ok.json.artifacts.report, "utf8"), "delegate report\n");
  assert.equal(outside(ws, ok.json.artifacts.dir), true);
  assert.equal(existsSync(ok.json.artifacts.stdout), true);
  assert.equal(existsSync(ok.json.artifacts.result), true);

  const failed = invoke(ctx, baseArgs(ctx, ws, ["--task-id", "task-grok-fail"]), {
    RELAY_WS: ws,
    RESULT_STATUS: "failed",
  });
  assert.equal(failed.status, 1, failed.stdout);
  assert.equal(failed.json.ok, false);
  assert.equal(failed.json.artifacts.sessionId, "sess-1");
  assert.equal(readFileSync(failed.json.artifacts.report, "utf8"), "delegate report\n");

  const garbage = invoke(ctx, baseArgs(ctx, ws, ["--task-id", "task-grok-bad"]), {
    RELAY_WS: ws,
    RESULT_STATUS: "garbage",
  });
  assert.equal(garbage.status, 1);
  assert.equal(garbage.json.ok, false);
  assert.equal(garbage.json.needsInspection, true);
});

test("reservation is on disk before the relay runs", () => {
  const ctx = layout();
  const ws = workspace();
  const saw = join(ctx.state, "saw.txt");
  const r = invoke(ctx, baseArgs(ctx, ws, ["--task-id", "task-reserve"]), {
    RELAY_WS: ws,
    RELAY_MODE: "wait",
    RELAY_STATE: join(ctx.state, "task-reserve.json"),
    RELAY_SAW: saw,
  });
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.equal(readFileSync(saw, "utf8"), "yes");
  const state = JSON.parse(readFileSync(join(ctx.state, "task-reserve.json"), "utf8"));
  assert.equal(state.running, null);
  assert.equal(state.workspace, realpathSync(ws));
  assert.equal(state.attempts.length, 1);
});

test("a live writer blocks a second launch and SIGTERM keeps the partial budget", { timeout: 15000 }, async () => {
  const ctx = layout();
  const ws = workspace();
  const pidFile = join(ctx.state, "desc.pid");
  writeFileSync(
    ctx.desc,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
  );
  const args = [
    "--task-id", "task-live",
    "--state-dir", ctx.state,
    "--brief", ctx.brief,
    "--lane", "implementer",
    "--cwd", ws,
    "--scope", "partial.txt",
    "--timeout", "30s",
    "--overall", "30s",
    "--max-attempts", "2",
    "--relay", ctx.relay,
  ];
  const child = spawn(NODE, [RUN, ...args], {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: ctx.home,
      PATH: `${ctx.bins}${delimiter}${NODE_BIN}${delimiter}/usr/bin:/bin`,
      RELAY_LOG: ctx.relayLog,
      RELAY_WS: ws,
      RELAY_MODE: "hang",
      RELAY_DESC: ctx.desc,
      ORCHESTRATE_PROBE_MS: "2000",
    },
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  try {
    const started = Date.now();
    let reserved = null;
    while (Date.now() - started < 5000) {
      if (existsSync(pidFile) && existsSync(join(ctx.state, "task-live.json"))) {
        reserved = JSON.parse(readFileSync(join(ctx.state, "task-live.json"), "utf8"));
        if (reserved.running?.pid) break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    }
    assert.ok(reserved?.running?.pid, "reservation was not persisted before the relay hung");
    const second = invoke(ctx, [
      "--task-id", "task-live",
      "--state-dir", ctx.state,
      "--brief", ctx.brief,
      "--lane", "backup",
      "--cwd", ws,
      "--scope", "partial.txt",
      "--timeout", "5s",
      "--overall", "2h",
      "--max-attempts", "9",
      "--relay", ctx.relay,
    ], { RELAY_WS: ws, RELAY_MODE: "noop" });
    assert.equal(second.json?.dispatched, false);
    assert.match(`${second.json?.error}`, /running|writer/i);
    assert.equal(relayCount(ctx), 1);
    child.kill("SIGTERM");
    const exitCode = await new Promise((resolve) => child.once("exit", resolve));
    assert.notEqual(exitCode, 0);
    const pid = Number(readFileSync(pidFile, "utf8"));
    const died = Date.now();
    while (alive(pid) && Date.now() - died < 2000) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    }
    assert.equal(alive(pid), false);
    const state = JSON.parse(readFileSync(join(ctx.state, "task-live.json"), "utf8"));
    assert.equal(state.running, null);
    assert.equal(state.attempts.length, 1);
    assert.equal(state.needsInspection, true);
    assert.equal(state.attemptLimit, 2);
    assert.ok(state.spentMs > 0);
    const body = JSON.parse(stdout);
    assert.equal(body.needsInspection, true);
    assert.equal(body.verification, "not-run");
    const again = invoke(ctx, args, { RELAY_WS: ws, RELAY_MODE: "noop" });
    assert.equal(again.json.dispatched, false);
    assert.match(`${again.json.error}`, /inspect/i);
    assert.equal(relayCount(ctx), 1);
    const kept = JSON.parse(readFileSync(join(ctx.state, "task-live.json"), "utf8"));
    assert.equal(kept.attemptLimit, 2);
    assert.equal(kept.overallMs, 30000);
    assert.equal(kept.attempts.length, 1);
  } finally {
    if (alive(child.pid)) child.kill("SIGKILL");
  }
});

test("attempt timeout is capped by the remaining overall budget", () => {
  const ctx = layout();
  const ws = workspace();
  const r = invoke(
    ctx,
    [
      "--task-id", "task-cap",
      "--state-dir", ctx.state,
      "--brief", ctx.brief,
      "--lane", "implementer",
      "--cwd", ws,
      "--scope", "partial.txt",
      "--timeout", "3s",
      "--overall", "1s",
      "--max-attempts", "1",
      "--relay", ctx.relay,
    ],
    { RELAY_WS: ws, RELAY_MODE: "hang", RELAY_DESC: ctx.desc },
  );
  assert.equal(r.status, 1, `${r.stderr}\n${r.stdout}`);
  assert.equal(r.json.timedOut, true);
  const state = JSON.parse(readFileSync(join(ctx.state, "task-cap.json"), "utf8"));
  assert.ok(state.attempts[0].reservedMs <= 1000);
  assert.ok(state.spentMs < 2500);
});

test("a crashed reservation is charged and blocks until inspected", () => {
  const ctx = layout();
  const ws = workspace();
  const task = "task-crash";
  writeFileSync(join(ctx.state, `${task}.json`), `${JSON.stringify({
    version: 1,
    taskId: task,
    workspace: realpathSync(ws),
    attemptLimit: 2,
    timeoutMs: 5000,
    overallMs: 30000,
    spentMs: 0,
    needsInspection: false,
    running: { pid: 999999, childPid: 999998, reservedMs: 5000, lane: "implementer", readOnly: false, baseline: { version: 1 } },
    attempts: [],
  })}\n`);
  const blocked = invoke(ctx, baseArgs(ctx, ws, ["--task-id", task]), { RELAY_WS: ws });
  assert.equal(blocked.status, 1, blocked.stdout);
  assert.equal(blocked.json.dispatched, false);
  assert.match(`${blocked.json.error}`, /inspect/i);
  assert.equal(relayCount(ctx), 0);
  const state = JSON.parse(readFileSync(join(ctx.state, `${task}.json`), "utf8"));
  assert.equal(state.spentMs, 5000);
  assert.equal(state.attempts.length, 1);
  assert.equal(state.running, null);
  const retried = invoke(ctx, baseArgs(ctx, ws, ["--task-id", task, "--inspected"]), { RELAY_WS: ws });
  assert.equal(retried.status, 0, `${retried.stderr}\n${retried.stdout}`);
  assert.equal(retried.json.attemptsUsed, 2);
});

function detachedRelay(ctx, pidFile) {
  writeFileSync(
    ctx.desc,
    `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
  );
  writeFileSync(
    ctx.relay,
    `import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
if (process.argv.includes("--help")) {
  process.stdout.write("--brief --cd --lane --read-only --effort\\n");
  process.exit(0);
}
appendFileSync(process.env.RELAY_LOG, JSON.stringify(process.argv) + "\\n");
const child = spawn(process.execPath, [process.env.RELAY_DESC], { detached: true, stdio: "ignore" });
child.unref();
process.on("SIGTERM", () => {
  setTimeout(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    process.exit(1);
  }, 2000);
});
setInterval(() => {}, 1000);
`,
  );
}

test("timeout kills a detached relay grandchild before the result", { timeout: 20000 }, () => {
  const ctx = layout();
  const ws = workspace();
  const pidFile = join(ctx.state, "grand.pid");
  detachedRelay(ctx, pidFile);
  const r = invoke(
    ctx,
    baseArgs(ctx, ws, ["--task-id", "task-detach", "--timeout", "1s", "--scope", "keep.txt"]),
    { RELAY_WS: ws, RELAY_DESC: ctx.desc },
  );
  try {
    assert.equal(r.status, 1, `${r.stderr}\n${r.stdout}`);
    assert.equal(r.json.timedOut, true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.equal(alive(pid), false);
  } finally {
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* already gone */ }
    }
  }
});

test("cancellation kills a detached relay grandchild before the result", { timeout: 20000 }, async () => {
  const ctx = layout();
  const ws = workspace();
  const pidFile = join(ctx.state, "grand.pid");
  detachedRelay(ctx, pidFile);
  const args = baseArgs(ctx, ws, ["--task-id", "task-detach-cancel", "--timeout", "30s"]);
  const child = spawn(NODE, [RUN, ...args], {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: ctx.home,
      PATH: `${ctx.bins}${delimiter}${NODE_BIN}${delimiter}/usr/bin:/bin`,
      RELAY_LOG: ctx.relayLog,
      RELAY_WS: ws,
      RELAY_DESC: ctx.desc,
      ORCHESTRATE_PROBE_MS: "2000",
    },
  });
  try {
    const started = Date.now();
    while (!existsSync(pidFile) && Date.now() - started < 5000) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    }
    assert.equal(existsSync(pidFile), true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    child.kill("SIGTERM");
    const exitCode = await new Promise((resolve) => child.once("exit", resolve));
    assert.notEqual(exitCode, 0);
    assert.equal(alive(pid), false);
  } finally {
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* already gone */ }
    }
    if (alive(child.pid)) child.kill("SIGKILL");
  }
});

test("nonzero or empty relay help blocks dispatch instead of inventing flags", () => {
  const ctx = layout();
  const ws = workspace();
  writeFileSync(
    ctx.relay,
    `import { appendFileSync } from "node:fs";
if (process.argv.includes("--help")) {
  process.stdout.write("--brief --cd --lane --read-only --effort\\n");
  process.exit(2);
}
appendFileSync(process.env.RELAY_LOG, JSON.stringify(process.argv) + "\\n");
process.exit(0);
`,
  );
  const nonzero = invoke(ctx, baseArgs(ctx, ws, ["--task-id", "task-help-status"]), { RELAY_WS: ws });
  assert.equal(nonzero.status, 1, `${nonzero.stderr}\n${nonzero.stdout}`);
  assert.equal(nonzero.json.dispatched, false);
  assert.equal(relayCount(ctx), 0);
  writeFileSync(
    ctx.relay,
    `import { appendFileSync } from "node:fs";
if (process.argv.includes("--help")) {
  process.stdout.write("usage changed\\n");
  process.exit(0);
}
appendFileSync(process.env.RELAY_LOG, JSON.stringify(process.argv) + "\\n");
process.exit(0);
`,
  );
  const unparsed = invoke(ctx, baseArgs(ctx, ws, ["--task-id", "task-help-empty"]), { RELAY_WS: ws });
  assert.equal(unparsed.status, 1, `${unparsed.stderr}\n${unparsed.stdout}`);
  assert.equal(unparsed.json.dispatched, false);
  assert.equal(relayCount(ctx), 0);
});

test("a lane-less relay blocks when configured model, effort, or variant cannot be passed", () => {
  const ctx = layout();
  const ws = workspace();
  writeFileSync(
    ctx.relay,
    `import { appendFileSync } from "node:fs";
if (process.argv.includes("--help")) {
  process.stdout.write("--brief --cd --read-only\\n");
  process.exit(0);
}
appendFileSync(process.env.RELAY_LOG, JSON.stringify(process.argv) + "\\n");
process.exit(0);
`,
  );
  const droppedModel = invoke(ctx, baseArgs(ctx, ws, ["--task-id", "task-no-model", "--effort", "high"]), { RELAY_WS: ws });
  assert.equal(droppedModel.status, 1, `${droppedModel.stderr}\n${droppedModel.stdout}`);
  assert.equal(droppedModel.json.dispatched, false);
  assert.match(`${droppedModel.json.error}`, /model/i);
  assert.equal(relayCount(ctx), 0);
  writeFileSync(
    ctx.relay,
    `import { appendFileSync } from "node:fs";
if (process.argv.includes("--help")) {
  process.stdout.write("--brief --cd --model --read-only\\n");
  process.exit(0);
}
appendFileSync(process.env.RELAY_LOG, JSON.stringify(process.argv) + "\\n");
process.exit(0);
`,
  );
  const droppedEffort = invoke(ctx, baseArgs(ctx, ws, ["--task-id", "task-no-effort", "--effort", "high"]), { RELAY_WS: ws });
  assert.equal(droppedEffort.status, 1, `${droppedEffort.stderr}\n${droppedEffort.stdout}`);
  assert.equal(droppedEffort.json.dispatched, false);
  assert.match(`${droppedEffort.json.error}`, /effort/i);
  assert.equal(relayCount(ctx), 0);
});

test("a lane-less relay receives the configured effort dial", () => {
  const ctx = layout();
  const ws = workspace();
  grokRelay(ctx);
  const r = invoke(ctx, baseArgs(ctx, ws, ["--task-id", "task-configured-effort"]), { RELAY_WS: ws });
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  const argv = relayArgv(ctx);
  assert.equal(argv.includes("--lane"), false);
  assert.equal(argv[argv.indexOf("--model") + 1], "opus");
  assert.equal(argv[argv.indexOf("--effort") + 1], "high");
});

test("a lane-less relay blocks when a configured variant cannot be passed", () => {
  const ctx = layout({
    implementer: { implementer: "opencode", model: "x/impl", variant: "high", roles: ["feature"] },
  });
  writeBin(
    ctx.bins,
    "opencode",
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "opencode 1.0.0"; exit 0; fi
if [ "$1" = "auth" ]; then echo "● default"; exit 0; fi
if [ "$1" = "models" ]; then echo "x/impl"; exit 0; fi
exit 3
`,
  );
  writeFileSync(
    ctx.relay,
    `import { appendFileSync } from "node:fs";
if (process.argv.includes("--help")) {
  process.stdout.write("--brief --cd --model --read-only\\n");
  process.exit(0);
}
appendFileSync(process.env.RELAY_LOG, JSON.stringify(process.argv) + "\\n");
process.exit(0);
`,
  );
  const ws = workspace();
  const r = invoke(ctx, baseArgs(ctx, ws, ["--task-id", "task-no-variant"]), { RELAY_WS: ws });
  assert.equal(r.status, 1, `${r.stderr}\n${r.stdout}`);
  assert.equal(r.json.dispatched, false);
  assert.match(`${r.json.error}`, /variant/i);
  assert.equal(relayCount(ctx), 0);
});

test("an empty or malformed lock blocks a second writer", () => {
  const ctx = layout();
  const ws = workspace();
  const lock = join(ctx.state, "task-1.lock");
  writeFileSync(lock, "");
  const empty = invoke(ctx, baseArgs(ctx, ws), { RELAY_WS: ws });
  assert.equal(empty.status, 1, `${empty.stderr}\n${empty.stdout}`);
  assert.equal(empty.json.dispatched, false);
  assert.match(`${empty.json.error}`, /writer|running/i);
  assert.equal(relayCount(ctx), 0);
  assert.equal(readFileSync(lock, "utf8"), "");
  writeFileSync(lock, "{");
  const malformed = invoke(ctx, baseArgs(ctx, ws, ["--task-id", "task-1"]), { RELAY_WS: ws });
  assert.equal(malformed.json.dispatched, false);
  assert.equal(relayCount(ctx), 0);
  assert.equal(readFileSync(lock, "utf8"), "{");
});

test("a well-formed dead lock owner can be recovered", () => {
  const ctx = layout();
  const ws = workspace();
  const owner = spawnSync(NODE, ["-e", "process.exit(0)"]);
  writeFileSync(join(ctx.state, "task-1.lock"), JSON.stringify({ pid: owner.pid }));
  const r = invoke(ctx, baseArgs(ctx, ws), { RELAY_WS: ws, RELAY_MODE: "noop" });
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.equal(r.json.dispatched, true);
  assert.equal(relayCount(ctx), 1);
});

test("a held recovery guard blocks acquisition and keeps the dead lock in place", () => {
  const ctx = layout();
  const ws = workspace();
  const owner = spawnSync(NODE, ["-e", "process.exit(0)"]);
  const lock = join(ctx.state, "task-1.lock");
  const dead = JSON.stringify({ pid: owner.pid });
  writeFileSync(lock, dead);
  // Another writer is inside its dead-lock recovery section (or crashed there).
  mkdirSync(join(ctx.state, "task-1.lock.guard"));
  const r = invoke(ctx, baseArgs(ctx, ws), { RELAY_WS: ws, RELAY_MODE: "noop" });
  assert.equal(r.status, 1, `${r.stderr}\n${r.stdout}`);
  assert.equal(r.json.dispatched, false);
  // The diagnostic names the guard and reports that acquisition may be active
  // or crash-left; it does not claim a writer is definitely still running.
  assert.match(`${r.json.error}`, /recovery guard/i);
  assert.match(`${r.json.error}`, /task-1\.lock\.guard/);
  assert.match(`${r.json.error}`, /crash/i);
  assert.doesNotMatch(`${r.json.error}`, /writer for this task is still running/);
  assert.equal(relayCount(ctx), 0);
  assert.equal(readFileSync(lock, "utf8"), dead);
});

test("concurrent recovery of a dead lock admits exactly one writer", { timeout: 20000 }, async () => {
  const ctx = layout();
  const ws = workspace();
  const owner = spawnSync(NODE, ["-e", "process.exit(0)"]);
  writeFileSync(join(ctx.state, "task-race.lock"), JSON.stringify({ pid: owner.pid }));
  const args = baseArgs(ctx, ws, ["--task-id", "task-race"]);
  const launch = () => {
    const child = spawn(NODE, [RUN, ...args], {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: ctx.home,
        PATH: `${ctx.bins}${delimiter}${NODE_BIN}${delimiter}/usr/bin:/bin`,
        RELAY_LOG: ctx.relayLog,
        RELAY_WS: ws,
        RELAY_MODE: "noop",
        RELAY_DESC: ctx.desc,
        ORCHESTRATE_PROBE_MS: "2000",
      },
    });
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("exit", (code) => resolve({ code, stdout, stderr }));
    });
  };
  const results = await Promise.all([launch(), launch()]);
  const outcomes = results.map((r) => JSON.parse(r.stdout));
  const dispatched = outcomes.filter((o) => o.dispatched === true);
  assert.equal(dispatched.length, 1, results.map((r) => `${r.code}: ${r.stderr}\n${r.stdout}`).join("\n"));
  assert.equal(relayCount(ctx), 1);
  const state = JSON.parse(readFileSync(join(ctx.state, "task-race.json"), "utf8"));
  assert.equal(state.attempts.length, 1);
});

test("a null childPid reservation stays blocked when inspected", () => {
  const ctx = layout();
  const ws = workspace();
  const task = "task-orphan";
  const body = {
    version: 1,
    taskId: task,
    workspace: realpathSync(ws),
    attemptLimit: 2,
    timeoutMs: 5000,
    overallMs: 30000,
    spentMs: 0,
    needsInspection: false,
    running: { pid: 999999, childPid: null, reservedMs: 5000, lane: "implementer", readOnly: false, baseline: { version: 1 } },
    attempts: [],
  };
  writeFileSync(join(ctx.state, `${task}.json`), `${JSON.stringify(body)}\n`);
  const retried = invoke(ctx, baseArgs(ctx, ws, ["--task-id", task, "--inspected"]), { RELAY_WS: ws });
  assert.equal(retried.status, 1, `${retried.stderr}\n${retried.stdout}`);
  assert.equal(retried.json.dispatched, false);
  assert.match(`${retried.json.error}`, /unknown|orphan/i);
  assert.equal(relayCount(ctx), 0);
  const state = JSON.parse(readFileSync(join(ctx.state, `${task}.json`), "utf8"));
  assert.equal(state.running.childPid, null);
  assert.equal(state.spentMs, 0);
  assert.equal(state.attempts.length, 0);
  assert.equal(state.attemptLimit, 2);
  assert.equal(state.overallMs, 30000);
});

test("an alive recorded child is not overlapped and its budget is kept", () => {
  const ctx = layout();
  const ws = workspace();
  const task = "task-alive";
  const body = {
    version: 1,
    taskId: task,
    workspace: realpathSync(ws),
    attemptLimit: 2,
    timeoutMs: 5000,
    overallMs: 30000,
    spentMs: 1000,
    needsInspection: false,
    running: { pid: 999999, childPid: process.pid, reservedMs: 4000, lane: "implementer", readOnly: false, baseline: { version: 1 } },
    attempts: [],
  };
  writeFileSync(join(ctx.state, `${task}.json`), `${JSON.stringify(body)}\n`);
  const r = invoke(ctx, baseArgs(ctx, ws, ["--task-id", task]), { RELAY_WS: ws });
  assert.equal(r.status, 1, `${r.stderr}\n${r.stdout}`);
  assert.equal(r.json.dispatched, false);
  assert.match(`${r.json.error}`, /running|writer/i);
  assert.equal(relayCount(ctx), 0);
  const state = JSON.parse(readFileSync(join(ctx.state, `${task}.json`), "utf8"));
  assert.equal(state.spentMs, 1000);
  assert.equal(state.attempts.length, 0);
  assert.equal(state.running.childPid, process.pid);
});

test("empty brief, non-directory root, and symlinked state dir fail before any state write", () => {
  const ctx = layout();
  const ws = workspace();
  writeFileSync(ctx.brief, "");
  const empty = invoke(ctx, baseArgs(ctx, ws), { RELAY_WS: ws });
  assert.equal(empty.status, 2);
  assert.equal(existsSync(join(ctx.state, "task-1.json")), false);
  assert.equal(relayCount(ctx), 0);
  writeFileSync(ctx.brief, "Run the task.\n");
  const fileRoot = join(ctx.state, "not-a-dir.txt");
  writeFileSync(fileRoot, "x\n");
  const rooted = invoke(ctx, baseArgs(ctx, fileRoot), { RELAY_WS: fileRoot });
  assert.equal(rooted.status, 2);
  assert.equal(relayCount(ctx), 0);
  const linkParent = mkdtempSync(join(tmpdir(), "orchestrate-run-link-"));
  const link = join(linkParent, "state");
  const inside = join(ws, "hidden-state");
  mkdirSync(inside);
  symlinkSync(inside, link);
  const linked = invoke(ctx, baseArgs(ctx, ws, ["--state-dir", link, "--task-id", "task-link"]), { RELAY_WS: ws });
  assert.equal(linked.status, 2, linked.stderr);
  assert.equal(existsSync(join(inside, "task-link.json")), false);
  assert.equal(existsSync(join(inside, "task-link.lock")), false);
  assert.equal(relayCount(ctx), 0);
});

test("invalid budget numbers and a foreign workspace are refused", () => {
  const ctx = layout();
  const ws = workspace();
  const task = "task-bad-budget";
  const path = join(ctx.state, `${task}.json`);
  writeFileSync(path, `${JSON.stringify({
    version: 1,
    taskId: task,
    workspace: realpathSync(ws),
    attemptLimit: "2",
    timeoutMs: 5000,
    overallMs: 30000,
    spentMs: 0,
    needsInspection: false,
    attempts: [],
  })}\n`);
  const bad = invoke(ctx, baseArgs(ctx, ws, ["--task-id", task]), { RELAY_WS: ws });
  assert.equal(bad.status, 2, bad.stderr);
  assert.equal(relayCount(ctx), 0);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).attemptLimit, "2");
  const foreign = "task-foreign";
  writeFileSync(join(ctx.state, `${foreign}.json`), `${JSON.stringify({
    version: 1,
    taskId: foreign,
    workspace: "/tmp/orchestrate-other-workspace",
    attemptLimit: 2,
    timeoutMs: 5000,
    overallMs: 30000,
    spentMs: 0,
    needsInspection: false,
    attempts: [],
  })}\n`);
  const moved = invoke(ctx, baseArgs(ctx, ws, ["--task-id", foreign]), { RELAY_WS: ws });
  assert.equal(moved.status, 2, moved.stderr);
  assert.equal(relayCount(ctx), 0);
  assert.equal(JSON.parse(readFileSync(join(ctx.state, `${foreign}.json`), "utf8")).workspace, "/tmp/orchestrate-other-workspace");
});

test("brief-only effort on a dial-less lane still dispatches without an effort flag", () => {
  const ctx = layout({ "ui-ux": { implementer: "agy", model: "gem", roles: ["ui"] } });
  writeBin(
    ctx.bins,
    "agy",
    `#!/bin/sh
if [ "$1" = "changelog" ]; then echo "agy: 1.0.0"; exit 0; fi
if [ "$1" = "models" ]; then echo "gem"; exit 0; fi
exit 3
`,
  );
  grokRelay(ctx);
  const ws = workspace();
  const r = invoke(
    ctx,
    [
      "--task-id", "task-brief-effort",
      "--state-dir", ctx.state,
      "--brief", ctx.brief,
      "--lane", "ui-ux",
      "--cwd", ws,
      "--scope", "keep.txt",
      "--timeout", "5s",
      "--overall", "30s",
      "--max-attempts", "1",
      "--effort", "high",
      "--relay", ctx.relay,
    ],
    { RELAY_WS: ws },
  );
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.equal(r.json.dispatched, true);
  assert.equal(r.json.preflight.checks.effort.briefOnly, true);
  const argv = relayArgv(ctx);
  assert.equal(argv.includes("--effort"), false);
  assert.equal(argv.includes("--lane"), false);
  assert.equal(argv[argv.indexOf("--model") + 1], "gem");
});

test("a state dir named ..state inside the workspace is refused before any write", () => {
  const ctx = layout();
  const ws = workspace();
  const state = join(ws, "..state");
  const r = invoke(ctx, baseArgs(ctx, ws, ["--state-dir", state, "--task-id", "task-dot"]), { RELAY_WS: ws });
  assert.equal(r.status, 2, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stderr, /outside/i);
  assert.equal(existsSync(state), false);
  assert.equal(existsSync(join(state, "task-dot.json")), false);
  assert.equal(existsSync(join(state, "task-dot.lock")), false);
  assert.equal(relayCount(ctx), 0);
});

test("a sibling state dir named ..state stays outside the workspace", () => {
  const ctx = layout();
  const parent = mkdtempSync(join(tmpdir(), "orchestrate-run-sib-"));
  const ws = workspace(parent);
  const state = join(parent, "..state");
  const r = invoke(ctx, baseArgs(ctx, ws, ["--state-dir", state, "--task-id", "task-sib"]), { RELAY_WS: ws });
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.equal(r.json.dispatched, true);
  assert.equal(existsSync(join(ws, "..state")), false);
  assert.equal(existsSync(join(state, "task-sib.json")), true);
});

test("a configured read-only lane restricts a relay when the flag is omitted", () => {
  const ctx = layout({
    implementer: { implementer: "claude", model: "opus", effort: "high", roles: ["feature"], readOnly: true },
  });
  const ws = workspace();
  const saw = join(ctx.state, "reserved-ro.txt");
  writeFileSync(
    ctx.relay,
    `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
if (process.argv.includes("--help")) {
  process.stdout.write("--brief --cd --lane --read-only --effort\\n");
  process.exit(0);
}
appendFileSync(process.env.RELAY_LOG, JSON.stringify(process.argv) + "\\n");
const state = JSON.parse(readFileSync(process.env.RELAY_STATE, "utf8"));
writeFileSync(process.env.RELAY_SAW, state.running?.readOnly === true ? "yes" : "no");
writeFileSync(process.env.RELAY_WS + "/keep.txt", "changed\\n");
process.exit(0);
`,
  );
  const r = invoke(ctx, baseArgs(ctx, ws, ["--task-id", "task-ro-lane"]), {
    RELAY_WS: ws,
    RELAY_STATE: join(ctx.state, "task-ro-lane.json"),
    RELAY_SAW: saw,
  });
  assert.equal(r.status, 1, `${r.stderr}\n${r.stdout}`);
  assert.equal(r.json.dispatched, true);
  assert.equal(r.json.readOnlyViolation, true);
  assert.equal(r.json.preflight.readOnly, true);
  assert.equal(r.json.ok, false);
  const argv = relayArgv(ctx);
  assert.ok(argv.includes("--read-only"));
  assert.ok(argv.includes("--lane"));
  assert.equal(readFileSync(saw, "utf8"), "yes");
  const state = JSON.parse(readFileSync(join(ctx.state, "task-ro-lane.json"), "utf8"));
  assert.equal(state.attempts[0].readOnly, true);
  assert.equal(readFileSync(join(ws, "keep.txt"), "utf8"), "changed\n");
});

test("a configured read-only lane is forwarded on a lane-less relay", () => {
  const ctx = layout({
    implementer: { implementer: "claude", model: "opus", effort: "high", roles: ["feature"], readOnly: true },
  });
  const ws = workspace();
  writeFileSync(
    ctx.relay,
    `import { appendFileSync } from "node:fs";
if (process.argv.includes("--help")) {
  process.stdout.write("--brief --cd --model --effort --read-only\\n");
  process.exit(0);
}
appendFileSync(process.env.RELAY_LOG, JSON.stringify(process.argv) + "\\n");
process.exit(0);
`,
  );
  const r = invoke(ctx, baseArgs(ctx, ws, ["--task-id", "task-ro-model"]), { RELAY_WS: ws });
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.equal(r.json.preflight.readOnly, true);
  const argv = relayArgv(ctx);
  assert.equal(argv.includes("--lane"), false);
  assert.ok(argv.includes("--read-only"));
  assert.equal(argv[argv.indexOf("--model") + 1], "opus");
  const state = JSON.parse(readFileSync(join(ctx.state, "task-ro-model.json"), "utf8"));
  assert.equal(state.attempts[0].readOnly, true);
});

test("a read-only lane blocks when the relay cannot accept --read-only", () => {
  const ctx = layout({
    implementer: { implementer: "claude", model: "opus", effort: "high", roles: ["feature"], readOnly: true },
  });
  const ws = workspace();
  writeFileSync(
    ctx.relay,
    `import { appendFileSync } from "node:fs";
if (process.argv.includes("--help")) {
  process.stdout.write("--brief --cd --lane --effort\\n");
  process.exit(0);
}
appendFileSync(process.env.RELAY_LOG, JSON.stringify(process.argv) + "\\n");
process.exit(0);
`,
  );
  const flagged = invoke(ctx, baseArgs(ctx, ws, ["--task-id", "task-ro-lane-cap"]), { RELAY_WS: ws });
  assert.equal(flagged.status, 1, `${flagged.stderr}\n${flagged.stdout}`);
  assert.equal(flagged.json.dispatched, false);
  assert.match(`${flagged.json.error}`, /read-only/i);
  assert.equal(relayCount(ctx), 0);
  writeFileSync(
    ctx.relay,
    `import { appendFileSync } from "node:fs";
if (process.argv.includes("--help")) {
  process.stdout.write("--brief --cd --model --effort\\n");
  process.exit(0);
}
appendFileSync(process.env.RELAY_LOG, JSON.stringify(process.argv) + "\\n");
process.exit(0);
`,
  );
  const laneLess = invoke(ctx, baseArgs(ctx, ws, ["--task-id", "task-ro-model-cap"]), { RELAY_WS: ws });
  assert.equal(laneLess.status, 1, `${laneLess.stderr}\n${laneLess.stdout}`);
  assert.equal(laneLess.json.dispatched, false);
  assert.match(`${laneLess.json.error}`, /read-only/i);
  assert.equal(relayCount(ctx), 0);
});

test("omitting --read-only on a writable lane does not restrict the relay", () => {
  const ctx = layout();
  const ws = workspace();
  const r = invoke(ctx, baseArgs(ctx, ws, ["--task-id", "task-write"]), { RELAY_WS: ws, RELAY_MODE: "write" });
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.equal(r.json.readOnlyViolation, false);
  assert.equal(r.json.preflight.readOnly, false);
  assert.equal(relayArgv(ctx).includes("--read-only"), false);
  assert.equal(readFileSync(join(ws, "keep.txt"), "utf8"), "changed\n");
});
