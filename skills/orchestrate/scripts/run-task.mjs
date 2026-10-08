#!/usr/bin/env node
/**
 * run-task.mjs — one dispatch of a fleet lane relay, with budget, preflight,
 * and content snapshots. Does not retry, does not run tests or migrations,
 * and passes model/effort only when fleet resolved them and the relay accepts them.
 *
 * Usage:
 *   node run-task.mjs --task-id <id> --state-dir <dir> --brief <file> --lane <name>
 *     --cwd <repo> --scope <rel>... --timeout <dur> --overall <dur> --max-attempts <n>
 *     [--read-only] [--effort low|medium|high] [--inspected] [--relay <script>]
 *
 * State file: <state-dir>/<task-id>.json (outside the workspace). The first
 * invocation stores the attempt, timeout, and overall limits. Later invocations
 * keep those limits, including fallback lanes and read-only diagnosis.
 * A reservation is written before the relay starts. One invocation spawns at most once.
 *
 * Exit codes: 0 relay finished inside scope with a coherent result,
 * 1 blocked, failed, timed out, or scope/read-only violation, 2 usage.
 * verification is always "not-run" — the orchestrator runs checks.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { captureSnapshot, diffSnapshots } from "./snapshot.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FLEET = join(HERE, "fleet.mjs");
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
// Delegate relays SIGKILL a detached grandchild 2000ms after SIGTERM. Killing the
// relay sooner drops that cleanup and leaves the grandchild behind.
const RELAY_CLEANUP_MS = 2500;

const HELP = `run-task.mjs — dispatch one fleet lane attempt

Usage:
  node run-task.mjs --task-id <id> --state-dir <dir> --brief <file> --lane <name> \\
    --cwd <repo> --scope <rel>... --timeout <dur> --overall <dur> --max-attempts <n> \\
    [--read-only] [--effort low|medium|high] [--inspected] [--relay <script>]

--relay defaults to the lane relay from fleet.mjs. Production omits it.
The wrapper never runs tests, builds, or migrations (verification is "not-run").
Exit codes: 0 success, 1 blocked or failed, 2 usage.
`;

let activeChild = null;
let stopSignal = null;
let stopPending = null;

function usage(message) {
  const error = new Error(message);
  error.code = 2;
  return error;
}

function parseDuration(value) {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value ?? "");
  if (!match || (match[1] == null && match[2] == null && match[3] == null)) return null;
  if (!match[1] && !match[2] && !match[3]) return null;
  const ms = (Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)) * 1000;
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > 2_147_483_647) return null;
  return ms;
}

function parseArgs(argv) {
  const out = { scopes: [], readOnly: false, inspected: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw usage(`${arg} requires a value`);
      return value;
    };
    if (arg === "--task-id") out.taskId = next();
    else if (arg === "--state-dir") out.stateDir = next();
    else if (arg === "--brief") out.brief = next();
    else if (arg === "--lane") out.lane = next();
    else if (arg === "--cwd") out.cwd = resolve(next());
    else if (arg === "--scope") out.scopes.push(next());
    else if (arg === "--timeout") out.timeout = next();
    else if (arg === "--overall") out.overall = next();
    else if (arg === "--max-attempts") out.maxAttempts = next();
    else if (arg === "--effort") out.effort = next();
    else if (arg === "--relay") out.relay = next();
    else if (arg === "--read-only") out.readOnly = true;
    else if (arg === "--inspected") out.inspected = true;
    else throw usage(`unknown option ${arg}`);
  }
  return out;
}

function escapesRoot(rel) {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function isInside(rootReal, candidate) {
  return !escapesRoot(relative(rootReal, candidate));
}

function canonicalPath(target) {
  const abs = resolve(target);
  const missing = [];
  let cursor = abs;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) throw usage("--state-dir is not a usable path");
    missing.push(basename(cursor));
    cursor = parent;
  }
  let real;
  try {
    real = realpathSync(cursor);
  } catch (error) {
    throw usage(`--state-dir is not usable (${error.message})`);
  }
  return missing.length ? join(real, ...missing.reverse()) : real;
}

function validate(opts) {
  if (!opts.taskId || !TASK_ID.test(opts.taskId)) throw usage("--task-id must be an explicit safe token");
  if (!opts.stateDir) throw usage("--state-dir is required");
  let briefStat;
  try {
    briefStat = statSync(opts.brief);
  } catch {
    throw usage("--brief must be an existing nonempty file");
  }
  if (!briefStat.isFile() || briefStat.size === 0) throw usage("--brief must be an existing nonempty file");
  if (!opts.lane) throw usage("--lane is required");
  let cwdStat;
  try {
    cwdStat = statSync(opts.cwd);
  } catch {
    throw usage("--cwd must be an existing directory");
  }
  if (!cwdStat.isDirectory()) throw usage("--cwd must be an existing directory");
  opts.rootReal = realpathSync(opts.cwd);
  if (opts.scopes.length === 0) throw usage("at least one --scope path is required");
  for (const scope of opts.scopes) {
    if (!scope || isAbsolute(scope) || scope.split(/[\\/]/).includes("..")) {
      throw usage(`--scope must be a relative path inside the workspace: ${scope}`);
    }
  }
  const stateAbs = resolve(opts.stateDir);
  if (isInside(resolve(opts.cwd), stateAbs)) throw usage("--state-dir must be outside the workspace");
  opts.stateReal = canonicalPath(stateAbs);
  if (isInside(opts.rootReal, opts.stateReal)) throw usage("--state-dir must be outside the workspace");
  const stateFile = join(stateAbs, `${opts.taskId}.json`);
  if (existsSync(stateFile) && isInside(opts.rootReal, realpathSync(stateFile))) {
    throw usage("--state-dir must be outside the workspace");
  }
  opts.timeoutMs = parseDuration(opts.timeout);
  opts.overallMs = parseDuration(opts.overall);
  if (opts.timeoutMs == null) throw usage("--timeout must be a positive h/m/s duration");
  if (opts.overallMs == null) throw usage("--overall must be a positive h/m/s duration");
  const attempts = Number(opts.maxAttempts);
  if (!Number.isInteger(attempts) || attempts < 1) throw usage("--max-attempts must be an integer >= 1");
  opts.attemptLimit = attempts;
  if (opts.effort !== undefined && !["low", "medium", "high"].includes(opts.effort)) {
    throw usage("--effort must be low, medium, or high");
  }
  if (opts.relay !== undefined && !existsSync(opts.relay)) throw usage(`relay not found: ${opts.relay}`);
}

function statePath(opts) {
  return join(opts.stateDir, `${opts.taskId}.json`);
}

function lockPath(opts) {
  return join(opts.stateDir, `${opts.taskId}.lock`);
}

function freshState(opts) {
  return {
    version: 1,
    taskId: opts.taskId,
    workspace: opts.rootReal,
    attemptLimit: opts.attemptLimit,
    timeoutMs: opts.timeoutMs,
    overallMs: opts.overallMs,
    spentMs: 0,
    needsInspection: false,
    running: null,
    attempts: [],
  };
}

function loadState(opts) {
  const path = statePath(opts);
  if (!existsSync(path)) return freshState(opts);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw usage("task state is unreadable; refusing to reset the budget");
  }
}

function assertBudget(state, opts) {
  const bad = (message) => {
    throw usage(`${message}; refusing to reset the budget`);
  };
  if (state.version !== 1 || state.taskId !== opts.taskId || !Array.isArray(state.attempts)) bad("task state is invalid");
  if (!Number.isSafeInteger(state.attemptLimit) || state.attemptLimit < 1) bad("task state attempt limit is invalid");
  if (!Number.isSafeInteger(state.timeoutMs) || state.timeoutMs < 1) bad("task state timeout is invalid");
  if (!Number.isSafeInteger(state.overallMs) || state.overallMs < 1) bad("task state overall budget is invalid");
  if (!Number.isSafeInteger(state.spentMs) || state.spentMs < 0) bad("task state spent time is invalid");
  if (typeof state.needsInspection !== "boolean") bad("task state is invalid");
  if (state.workspace !== opts.rootReal) bad("task state is bound to a different workspace");
  if (state.running == null) return;
  const run = state.running;
  if (typeof run !== "object" || !Number.isSafeInteger(run.reservedMs) || run.reservedMs < 0) bad("task state reservation is invalid");
  if (!Number.isSafeInteger(run.pid) || run.pid <= 0) bad("task state reservation is invalid");
  if (run.childPid != null && (!Number.isSafeInteger(run.childPid) || run.childPid <= 0)) bad("task state reservation is invalid");
}

function writeState(opts, state) {
  const path = statePath(opts);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

function readLoose(opts) {
  try {
    const parsed = JSON.parse(readFileSync(statePath(opts), "utf8"));
    if (parsed && Array.isArray(parsed.attempts)) return parsed;
  } catch {
    // the live writer may be mid-rename
  }
  return freshState(opts);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function readLockPid(path) {
  try {
    const pid = JSON.parse(readFileSync(path, "utf8"))?.pid;
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function lockDisposition(path) {
  const pid = readLockPid(path);
  if (pid == null) return "unknown";
  return pidAlive(pid) ? "live" : "dead";
}

function acquireLock(opts) {
  mkdirSync(opts.stateDir, { recursive: true });
  const path = lockPath(opts);
  // Atomic guard: only the invocation that creates it may touch the task lock,
  // so concurrent dead-lock recovery cannot unlink a lock another writer just
  // recreated. A leftover guard blocks acquisition; there is no guard recovery.
  const guard = `${path}.guard`;
  try {
    mkdirSync(guard);
  } catch (error) {
    if (error.code === "EEXIST") return { ok: false, path, guard };
    throw error;
  }
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const tmp = `${path}.${process.pid}.${attempt}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify({ pid: process.pid }), { flag: "wx" });
        try {
          linkSync(tmp, path);
          return { ok: true, path };
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          // Empty or malformed contents are an unknown owner, not a stale lock.
          if (lockDisposition(path) !== "dead") return { ok: false, path };
          try {
            unlinkSync(path);
          } catch {
            // another restart removed it
          }
        }
      } finally {
        try { unlinkSync(tmp); } catch { /* temp already gone */ }
      }
    }
    return { ok: false, path };
  } finally {
    try { rmdirSync(guard); } catch { /* guard already gone */ }
  }
}

function releaseLock(path) {
  try {
    if (readLockPid(path) === process.pid) unlinkSync(path);
  } catch {
    // already released
  }
}

function reconcile(state) {
  const run = state.running;
  if (!run) return "clear";
  const wrapperAlive = pidAlive(run.pid) && run.pid !== process.pid;
  const childKnown = Number.isInteger(run.childPid) && run.childPid > 0;
  const childAlive = childKnown && pidAlive(run.childPid);
  if (wrapperAlive || childAlive) return "busy";
  // A crash before the child pid is recorded cannot name the orphan. Do not clear it.
  if (!childKnown) return "unknown";
  // ponytail: a known-dead child is not still running; charge the reservation.
  const next = state.spentMs + run.reservedMs;
  if (!Number.isSafeInteger(next)) throw usage("task state spent time is invalid; refusing to reset the budget");
  state.spentMs = next;
  state.attempts.push({
    lane: run.lane ?? null,
    readOnly: Boolean(run.readOnly),
    durationMs: run.reservedMs,
    reservedMs: run.reservedMs,
    exitCode: null,
    signal: "SIGKILL",
    timedOut: false,
    crashed: true,
    uncertain: true,
    changes: [],
  });
  state.needsInspection = true;
  state.running = null;
  return "settled";
}

function probeBudget() {
  const raw = Number(process.env.ORCHESTRATE_PROBE_MS);
  if (Number.isFinite(raw) && raw >= 50 && raw <= 10000) return raw;
  return 4000;
}

function fleetPreflight(opts) {
  const args = [FLEET, "preflight", "--lane", opts.lane, "--cwd", opts.cwd];
  if (opts.readOnly) args.push("--read-only");
  if (opts.effort) args.push("--level", opts.effort);
  const result = spawnSync(process.execPath, args, { encoding: "utf8", env: process.env });
  if (result.error) throw usage(`preflight could not start (${result.error.message})`);
  let json = null;
  try {
    json = JSON.parse(result.stdout || "");
  } catch {
    json = null;
  }
  if (result.status === 2 || !json) throw usage((result.stderr || "preflight failed").trim());
  return json;
}

function laneRecord(opts) {
  const listed = spawnSync(process.execPath, [FLEET, "list", "--cwd", opts.cwd], { encoding: "utf8", env: process.env });
  let json = null;
  try {
    json = JSON.parse(listed.stdout || "");
  } catch {
    json = null;
  }
  if (!json?.lanes) throw usage((listed.stderr || "fleet list failed").trim() || "fleet list failed");
  const lane = json.lanes.find((item) => item.name === opts.lane);
  if (!lane) throw usage(`lane not found: ${opts.lane}`);
  return lane;
}

function relayFlags(relay) {
  const result = spawnSync(process.execPath, [relay, "--help"], {
    encoding: "utf8",
    timeout: probeBudget(),
    killSignal: "SIGKILL",
    cwd: tmpdir(),
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  if (result.error || result.status !== 0) return null;
  const found = `${result.stdout || ""}\n${result.stderr || ""}`.match(/--[a-z][a-z0-9-]*/g);
  return found?.length ? new Set(found) : null;
}

function effortValue(lane, preflight, flags) {
  const mapped = preflight.checks?.effort?.flag;
  if (typeof mapped === "string" && mapped.startsWith("--effort ")) return mapped.slice("--effort ".length);
  if (flags.has("--lane") || preflight.checks?.effort?.briefOnly || lane.effort?.dial !== "effort") return null;
  const configured = lane.dials?.effort;
  return typeof configured === "string" && configured ? configured : null;
}

function buildRelayArgs(opts, lane, preflight, flags, attemptDir) {
  if (!flags) return { blocked: "relay capabilities are unknown" };
  if (!flags.has("--brief") || !flags.has("--cd")) return { blocked: "relay does not accept --brief and --cd" };
  const args = ["--brief", opts.brief];
  if (flags.has("--lane")) args.push("--lane", opts.lane);
  else if (lane.model) {
    if (!flags.has("--model")) return { blocked: "relay does not accept --model" };
    args.push("--model", lane.model);
  }
  if (!flags.has("--lane") && typeof lane.dials?.variant === "string" && lane.dials.variant) {
    if (!flags.has("--variant")) return { blocked: "relay does not accept --variant" };
    args.push("--variant", lane.dials.variant);
  }
  args.push("--cd", opts.cwd);
  if (opts.readOnly) {
    if (!flags.has("--read-only")) return { blocked: "relay does not accept --read-only" };
    args.push("--read-only");
  }
  const effort = effortValue(lane, preflight, flags);
  if (effort) {
    if (!flags.has("--effort")) return { blocked: "relay does not accept --effort" };
    args.push("--effort", effort);
  }
  if (flags.has("--out-dir")) args.push("--out-dir", attemptDir);
  return { args };
}

function killTree(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already exited
    }
  }
}

function processTable() {
  const result = spawnSync("ps", ["-ax", "-o", "pid=,ppid=,pgid="], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return [];
  const rows = [];
  for (const line of result.stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const pgid = Number(parts[2]);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || !Number.isInteger(pgid)) continue;
    rows.push({ pid, ppid, pgid });
  }
  return rows;
}

function descendantGroups(rootPid) {
  const rows = processTable();
  const seen = new Set([rootPid]);
  const groups = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (!seen.has(row.ppid) || seen.has(row.pid)) continue;
      seen.add(row.pid);
      if (row.pgid !== rootPid) groups.add(row.pgid);
      grew = true;
    }
  }
  return { pids: [...seen].filter((pid) => pid !== rootPid), groups: [...groups] };
}

function killGroups(groups, signal) {
  for (const pgid of groups) {
    if (!Number.isInteger(pgid) || pgid <= 0) continue;
    try { process.kill(-pgid, signal); } catch { /* already gone */ }
  }
}

function beginStop(child) {
  if (!child?.pid || stopPending) return;
  const snap = descendantGroups(child.pid);
  killTree(child, "SIGTERM");
  const timer = setTimeout(() => {
    killTree(child, "SIGKILL");
    killGroups(snap.groups, "SIGKILL");
  }, RELAY_CLEANUP_MS);
  timer.unref();
  stopPending = { ...snap, timer };
}

function waitDead(pids) {
  const watch = new Set((pids || []).filter((pid) => pidAlive(pid)));
  return new Promise((resolve) => {
    const deadline = Date.now() + 1000;
    const tick = () => {
      for (const pid of watch) {
        if (!pidAlive(pid)) watch.delete(pid);
        else {
          try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
        }
      }
      if (watch.size === 0 || Date.now() >= deadline) resolve();
      else setTimeout(tick, 20);
    };
    tick();
  });
}

async function finishStop(child) {
  const pending = stopPending;
  stopPending = null;
  if (pending?.timer) clearTimeout(pending.timer);
  if (child?.pid) {
    killTree(child, "SIGKILL");
    killGroups(pending?.groups || [], "SIGKILL");
  }
  await waitDead(pending?.pids);
}

function requestStop(signal) {
  if (stopSignal) return;
  stopSignal = signal;
  if (!activeChild) return;
  beginStop(activeChild);
}

function runRelay(relay, args, timeoutMs, stdio) {
  const outFd = stdio.outFd;
  const errFd = stdio.errFd;
  const child = spawn(process.execPath, [relay, ...args], { detached: true, stdio: ["ignore", outFd, errFd] });
  closeSync(outFd);
  closeSync(errFd);
  activeChild = child;
  if (stopSignal) beginStop(child);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    beginStop(child);
  }, timeoutMs);
  return new Promise((resolvePromise) => {
    const finish = async (exitCode, signal) => {
      clearTimeout(timer);
      if (timedOut || stopSignal) await finishStop(child);
      activeChild = null;
      resolvePromise({ timedOut, exitCode, signal, signaled: stopSignal });
    };
    child.once("exit", (code, signal) => { finish(code, signal); });
    child.once("error", () => { finish(1, null); });
  }).then((run) => ({ childPid: child.pid, ...run }));
}

function readRelayResult(path) {
  if (!path) return { present: false, coherent: true, json: null };
  try {
    const json = JSON.parse(readFileSync(path, "utf8"));
    if (!json || typeof json !== "object" || Array.isArray(json) || typeof json.status !== "string") {
      return { present: true, coherent: false, json: json && typeof json === "object" && !Array.isArray(json) ? json : null };
    }
    const code = json.exitCode;
    const codeOk = code === undefined || Number.isInteger(code);
    const agree = codeOk && (code === undefined || (json.status === "completed") === (code === 0));
    return { present: true, coherent: Boolean(agree), json };
  } catch {
    return { present: true, coherent: false, json: null };
  }
}

function artifactRecord(opts, dir, stdoutPath, stderrPath) {
  const direct = join(dir, "result.json");
  let resultPath = existsSync(direct) ? direct : null;
  if (!resultPath) {
    let stdout = "";
    try {
      stdout = readFileSync(stdoutPath, "utf8");
    } catch {
      stdout = "";
    }
    const match = stdout.match(/result:\s*(\S*result\.json)/);
    if (match && existsSync(match[1])) {
      try {
        if (!isInside(opts.rootReal, realpathSync(match[1]))) {
          copyFileSync(match[1], direct);
          resultPath = direct;
        }
      } catch {
        // leave the report path unclaimed rather than copying from the workspace
      }
    }
  }
  const found = readRelayResult(resultPath);
  let report = null;
  const finalPath = found.json?.finalPath;
  if (typeof finalPath === "string" && existsSync(finalPath)) report = finalPath;
  else if (existsSync(join(dir, "final.txt"))) report = join(dir, "final.txt");
  else if (typeof found.json?.finalMessage === "string" && found.json.finalMessage.trim()) {
    report = join(dir, "report.txt");
    const text = found.json.finalMessage.endsWith("\n") ? found.json.finalMessage : `${found.json.finalMessage}\n`;
    writeFileSync(report, text);
  }
  if (report) {
    try {
      const reportReal = realpathSync(report);
      if (isInside(opts.rootReal, reportReal)) {
        const dest = join(dir, "report.txt");
        if (reportReal !== realpathSync(dest)) copyFileSync(report, dest);
        report = dest;
      }
    } catch {
      // the recorded path is still the best handle we have
    }
  }
  return {
    found,
    artifacts: {
      dir,
      stdout: stdoutPath,
      stderr: stderrPath,
      result: resultPath,
      report,
      sessionId: typeof found.json?.sessionId === "string" ? found.json.sessionId : null,
    },
  };
}

function resultOf(opts, state, extra) {
  return {
    taskId: opts.taskId,
    lane: opts.lane,
    dispatched: false,
    attemptsUsed: state.attempts.length,
    attemptsRemaining: Math.max(0, state.attemptLimit - state.attempts.length),
    overallMs: state.overallMs,
    spentMs: state.spentMs,
    timedOut: false,
    needsInspection: state.needsInspection,
    changes: [],
    outsideScope: [],
    readOnlyViolation: false,
    ok: false,
    verification: "not-run",
    artifacts: null,
    error: null,
    ...extra,
  };
}

function blocked(opts, state, extra) {
  return { code: 1, body: resultOf(opts, state, extra) };
}

async function dispatchLocked(opts) {
  const state = loadState(opts);
  assertBudget(state, opts);
  const prior = reconcile(state);
  if (prior === "busy") return blocked(opts, state, { error: "a writer for this task is still running" });
  if (prior === "unknown") {
    return blocked(opts, state, { error: "unknown process ownership; refusing to dispatch over a possible orphan" });
  }
  if (prior === "settled") writeState(opts, state);
  if (state.needsInspection && !opts.inspected) {
    return blocked(opts, state, { error: "partial edits need inspection before another attempt" });
  }
  if (opts.inspected) state.needsInspection = false;
  if (state.attempts.length >= state.attemptLimit || state.spentMs >= state.overallMs) {
    writeState(opts, state);
    return blocked(opts, state, { error: "task attempt or time budget is exhausted" });
  }
  const lane = laneRecord(opts);
  if (lane.readOnly === true) opts.readOnly = true;
  const preflight = fleetPreflight(opts);
  if (preflight.blocked) {
    writeState(opts, state);
    return blocked(opts, state, { preflight, error: "preflight blocked dispatch" });
  }
  if (stopSignal) return blocked(opts, state, { preflight, error: `dispatch interrupted by ${stopSignal}` });
  const relay = opts.relay || lane.relay;
  if (!relay) throw usage(`lane ${opts.lane} has no relay`);
  const flags = relayFlags(relay);
  const attemptDir = join(opts.stateReal, "attempts", opts.taskId, String(state.attempts.length + 1));
  mkdirSync(attemptDir, { recursive: true });
  const attemptReal = realpathSync(attemptDir);
  if (isInside(opts.rootReal, attemptReal)) throw usage("attempt artifacts must be outside the workspace");
  const built = buildRelayArgs(opts, lane, preflight, flags, attemptReal);
  if (built.blocked) {
    writeState(opts, state);
    return blocked(opts, state, { preflight, error: built.blocked });
  }
  const before = captureSnapshot(opts.cwd);
  const remaining = state.overallMs - state.spentMs;
  const reservedMs = Math.min(state.timeoutMs, remaining);
  state.running = {
    pid: process.pid,
    childPid: null,
    reservedMs,
    lane: opts.lane,
    readOnly: opts.readOnly,
    baseline: before,
    attemptDir: attemptReal,
  };
  writeState(opts, state);
  const stdoutPath = join(attemptReal, "stdout.txt");
  const stderrPath = join(attemptReal, "stderr.txt");
  const started = Date.now();
  const childPromise = runRelay(relay, built.args, reservedMs, {
    outFd: openSync(stdoutPath, "w"),
    errFd: openSync(stderrPath, "w"),
  });
  state.running.childPid = activeChild?.pid ?? null;
  writeState(opts, state);
  const run = await childPromise;
  const durationMs = Math.min(Date.now() - started, reservedMs);
  let delta = { ok: false, changes: [], outsideScope: [], readOnlyViolation: false };
  let snapshotError = null;
  try {
    // ponytail: this diff is not exclusive attribution while another writer shares the cwd.
    delta = diffSnapshots(before, captureSnapshot(opts.cwd), { readOnly: opts.readOnly, scopes: opts.scopes });
  } catch (error) {
    snapshotError = error.message;
  }
  const recorded = artifactRecord(opts, attemptReal, stdoutPath, stderrPath);
  const found = recorded.found;
  const resultOk = !found.present || (found.coherent && found.json.status === "completed" && run.exitCode === 0);
  const ok = !run.timedOut && !run.signaled && !snapshotError && delta.ok && run.exitCode === 0 && resultOk && found.coherent;
  const uncertain = (found.present && !found.coherent) || Boolean(snapshotError) || Boolean(run.signaled) || run.timedOut;
  state.spentMs += durationMs;
  state.running = null;
  state.attempts.push({
    lane: opts.lane,
    readOnly: opts.readOnly,
    durationMs,
    reservedMs,
    exitCode: run.exitCode,
    signal: run.signaled || run.signal,
    timedOut: run.timedOut,
    changes: delta.changes,
    artifacts: recorded.artifacts,
  });
  state.needsInspection = uncertain || (delta.changes.length > 0 && !ok);
  writeState(opts, state);
  return {
    code: ok ? 0 : 1,
    body: resultOf(opts, state, {
      dispatched: true,
      preflight,
      timedOut: run.timedOut,
      needsInspection: state.needsInspection,
      changes: delta.changes,
      outsideScope: delta.outsideScope,
      readOnlyViolation: delta.readOnlyViolation,
      ok,
      artifacts: recorded.artifacts,
      error: snapshotError || (found.present && !found.coherent ? "relay result status is incoherent" : null),
    }),
  };
}

async function dispatch(opts) {
  const lock = acquireLock(opts);
  if (!lock.ok) {
    if (lock.guard) {
      // The guard may belong to a writer inside its recovery section or be a
      // leftover from a crash; this diagnostic does not claim either for sure.
      return blocked(opts, readLoose(opts), {
        error: `recovery guard ${lock.guard} is present; acquisition may be active or left by a crash`,
      });
    }
    return blocked(opts, readLoose(opts), { error: "a writer for this task is still running" });
  }
  try {
    return await dispatchLocked(opts);
  } finally {
    releaseLock(lock.path);
  }
}

async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (argv.length === 0) {
    process.stderr.write(`run-task.mjs: ${HELP}`);
    process.exit(2);
  }
  process.on("SIGTERM", () => requestStop("SIGTERM"));
  process.on("SIGINT", () => requestStop("SIGINT"));
  try {
    const opts = parseArgs(argv);
    validate(opts);
    const outcome = await dispatch(opts);
    process.stdout.write(`${JSON.stringify(outcome.body, null, 2)}\n`);
    process.exit(outcome.code);
  } catch (error) {
    process.stderr.write(`run-task.mjs: ${error.message}\n`);
    process.exit(error.code === 2 ? 2 : 1);
  }
}

main(process.argv.slice(2));
