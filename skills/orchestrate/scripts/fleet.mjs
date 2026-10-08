#!/usr/bin/env node
/**
 * fleet.mjs — read-only introspection of the live delegate-fleet.v1 map for the
 * orchestrate skill. delegate-setup stays the single source of truth: this script
 * imports its loader and registry at run time and never stores lane data itself.
 *
 * Usage:
 *   node fleet.mjs list   [--cwd <repo>]
 *   node fleet.mjs pick   --need <role> [--write | --read-only] [--exclude <lane>]... [--cwd <repo>]
 *   node fleet.mjs effort --lane <name> --level low|medium|high [--cwd <repo>]
 *   node fleet.mjs preflight --lane <name> [--level low|medium|high] [--read-only] [--cwd <repo>]
 *   node fleet.mjs --help
 *
 * Roles (routing vocabulary, not lane config):
 *   quick feature ui debug tests docs plan review
 * A lane's `roles` field (declared in the fleet) wins; otherwise roles are inferred
 * from the lane name. Node built-ins only. No network, no writes.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HELP = `fleet.mjs — introspect the live delegate fleet (read-only)

Usage:
  node fleet.mjs list   [--cwd <repo>]
  node fleet.mjs pick   --need <role> [--write | --read-only] [--exclude <lane>]... [--cwd <repo>]
  node fleet.mjs effort --lane <name> --level low|medium|high [--cwd <repo>]
  node fleet.mjs preflight --lane <name> [--level low|medium|high] [--read-only] [--cwd <repo>]

Roles: quick feature ui debug tests docs plan review
preflight checks the lane binary, version, auth, and model through the registry.
It does not install, mutate config, print probe output, or start a task.
Status: ready, unavailable, unknown, unsupported. unavailable and unsupported block.
`;

/** Name tokens → role. Only used when a lane declares no \`roles\`. */
const NAME_HINTS = {
  quick: ["quick", "fast", "small", "tiny", "edit", "minor", "cheap"],
  feature: ["feature", "implement", "implementer", "build", "general", "dev", "code", "default", "main-impl"],
  ui: ["ui", "ux", "design", "frontend", "front", "visual", "web", "mobile"],
  debug: ["fix", "fixes", "bug", "bugs", "debug", "diagnose", "diagnosis"],
  tests: ["test", "tests", "testing", "qa", "spec"],
  docs: ["doc", "docs", "documentation"],
  plan: ["plan", "plans", "planning", "arch", "architecture"],
  review: ["review", "reviewer", "audit"],
};
const ROLES = Object.keys(NAME_HINTS);

/** Relay dial values known per implementer for the orchestrator's low/medium/high scale. */
function effortInfo(impl, registry) {
  if (impl.supports.includes("effort")) {
    const values = impl.key === "claude" ? [...registry.CLAUDE_EFFORT] : ["low", "medium", "high"];
    return { dial: "effort", values, note: impl.key === "claude" ? null : "bare token; the CLI and model own accepted levels" };
  }
  if (impl.supports.includes("variant")) {
    return { dial: "variant", values: null, note: "model-specific names; keep the lane's configured variant unless you know the model's values" };
  }
  return { dial: null, values: null, note: "no reasoning dial; effort lives in the brief only" };
}

function locateDelegateSetup() {
  const here = dirname(realpathSync(fileURLToPath(import.meta.url)));
  const candidates = [
    process.env.DELEGATE_SETUP_DIR,
    join(here, "..", "..", "delegate-setup"),
    join(homedir(), ".agents", "skills", "delegate-setup"),
    join(homedir(), ".claude", "skills", "delegate-setup"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(join(c, "scripts", "config.mjs"))) return realpathSync(c);
  }
  throw new Error("delegate-setup skill not found (set DELEGATE_SETUP_DIR or install it beside this skill)");
}

function inferRoles(name) {
  const tokens = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const found = [];
  for (const role of ROLES) {
    if (tokens.some((t) => NAME_HINTS[role].includes(t))) found.push(role);
  }
  return found;
}

async function loadFleet(cwd) {
  const setupDir = locateDelegateSetup();
  const config = await import(pathToFileURL(join(setupDir, "scripts", "config.mjs")).href);
  const registry = await import(pathToFileURL(join(setupDir, "scripts", "implementers.mjs")).href);
  const effective = config.loadEffective(cwd);
  const skillsRoot = dirname(setupDir);
  const lanes = Object.entries(effective.lanes).map(([name, lane]) => {
    const { implementer, source, roles, model, readOnly, ...dials } = lane;
    const impl = registry.IMPLEMENTER_BY_KEY[implementer];
    const relay = join(skillsRoot, impl.skill, "scripts", "relay.mjs");
    const declared = Array.isArray(roles) && roles.length > 0;
    return {
      name,
      implementer,
      skill: impl.skill,
      relay: existsSync(relay) ? relay : null,
      model: model ?? null,
      dials,
      readOnly: readOnly === true,
      readOnlyCapable: impl.supports.includes("readOnly"),
      source,
      roles: declared ? [...roles] : inferRoles(name),
      rolesSource: declared ? "declared" : "inferred",
      effort: effortInfo(impl, registry),
    };
  });
  return {
    registry,
    report: {
      globalPath: effective.globalPath,
      projectPath: effective.projectPath,
      projectPresent: effective.projectPresent,
      projectTrusted: effective.projectTrusted,
      lanes,
    },
  };
}

function probeBudget() {
  const raw = Number(process.env.ORCHESTRATE_PROBE_MS);
  if (Number.isFinite(raw) && raw >= 50 && raw <= 10000) return raw;
  return 4000;
}

// Relay flags come from a successful --help parse, never from a guessed shape.
// A failed, nonzero, or unparseable help probe is unknown: no command is invented.
const relayHelpCache = new Map();

function relayFlags(relay) {
  if (!relay) return null;
  if (relayHelpCache.has(relay)) return relayHelpCache.get(relay);
  const result = runBounded(process.execPath, [relay, "--help"]);
  let flags = null;
  if (!result.error && result.status === 0) {
    const found = `${result.stdout || ""}\n${result.stderr || ""}`.match(/--[a-z][a-z0-9-]*/g);
    if (found?.length) flags = new Set(found);
  }
  relayHelpCache.set(relay, flags);
  return flags;
}

function command(lane, readOnly) {
  const flags = relayFlags(lane.relay);
  if (!flags?.has("--brief") || !flags.has("--cd")) return null;
  const parts = [`node "${lane.relay ?? `<${lane.skill}>/scripts/relay.mjs`}"`, "--brief <brief>"];
  const laneLess = !flags.has("--lane");
  if (!laneLess) parts.push(`--lane ${lane.name}`);
  else if (lane.model) {
    if (!flags.has("--model")) return null;
    parts.push(`--model ${lane.model}`);
  }
  if (laneLess && typeof lane.dials?.variant === "string" && lane.dials.variant) {
    if (!flags.has("--variant")) return null;
    parts.push(`--variant ${lane.dials.variant}`);
  }
  parts.push("--cd <repo>");
  if (lane.effort.dial === "effort" && flags.has("--effort")) parts.push("[--effort <level>]");
  else if (laneLess && lane.effort.dial === "effort" && typeof lane.dials?.effort === "string" && lane.dials.effort) return null;
  if (readOnly) {
    if (!flags.has("--read-only")) return null;
    parts.push("--read-only");
  }
  return parts.join(" ");
}

function pick(fleet, need, { write, readOnly, exclude }) {
  if (!ROLES.includes(need)) throw new Error(`unknown role ${JSON.stringify(need)}; roles: ${ROLES.join(" ")}`);
  const usable = fleet.lanes.filter((l) => l.relay && !exclude.includes(l.name));
  const untrusted = fleet.projectPresent && !fleet.projectTrusted;
  let pool = usable;
  if (write) pool = pool.filter((l) => !l.readOnly);
  if (readOnly) pool = pool.filter((l) => l.readOnly || l.readOnlyCapable);
  const score = (l) => {
    let s = 0;
    if (l.roles.includes(need)) s += l.rolesSource === "declared" ? 100 : 50;
    if (readOnly && l.readOnly) s += 10;
    if (write && !l.readOnly) s += 1;
    return s;
  };
  const matched = pool.filter((l) => l.roles.includes(need)).sort((a, b) => score(b) - score(a));
  const fallback = need === "feature" ? [] : pool.filter((l) => !l.roles.includes(need) && l.roles.includes("feature"));
  const candidates = [...matched.map((l) => ({ ...l, fallback: false })), ...fallback.map((l) => ({ ...l, fallback: true }))]
    .map((l) => ({ ...l, command: command(l, readOnly) }));
  const note = candidates.length === 0
    ? `no lane can serve role "${need}"${write ? " with write access" : ""}${readOnly ? " read-only" : ""}; reconfigure with delegate-setup`
    : matched.length === 0 ? `no lane declares or implies "${need}"; feature lanes offered as fallback` : null;
  return { need, untrustedProjectConfig: untrusted, candidates, note };
}

function resolveBinary(binary) {
  const pathValue = process.env.PATH || "";
  if (!pathValue) return null;
  const entries = pathValue.split(delimiter).filter(Boolean);
  if (process.platform === "win32") {
    const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
    for (const entry of entries) {
      for (const ext of ["", ...exts]) {
        const candidate = join(entry, ext ? `${binary}${ext}` : binary);
        try {
          if (statSync(candidate).isFile()) return candidate;
        } catch {
          // keep looking
        }
      }
    }
    return null;
  }
  for (const entry of entries) {
    const candidate = join(entry, binary);
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

function runBounded(binary, args) {
  return spawnSync(binary, args, {
    encoding: "utf8",
    timeout: probeBudget(),
    killSignal: "SIGKILL",
    cwd: tmpdir(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function versionText(impl, result) {
  if (result.error || result.status !== 0) return null;
  const line = (result.stdout || "").replace(/\x1b\[[0-9;]*m/g, "").trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!line) return null;
  if (impl.versionFormat !== "colon-prefix") return line.slice(0, 200);
  return (/^([^:\s]+):/.exec(line)?.[1] ?? line).slice(0, 200);
}

function authStatus(impl, binary) {
  const probe = impl.authProbe;
  if (!probe) return "unknown";
  const result = runBounded(binary, probe.args);
  const output = `${result.stdout || ""}${result.stderr || ""}`.replace(/\x1b\[[0-9;]*m/g, "");
  if (probe.jsonField) {
    const read = (raw) => {
      try {
        const value = JSON.parse(raw)[probe.jsonField];
        return typeof value === "boolean" ? value : null;
      } catch {
        return null;
      }
    };
    const parsed = read(result.stdout || "") ?? read(output);
    if (parsed === true) return "ready";
    if (parsed === false) return "unavailable";
    return "unknown";
  }
  if (result.error) return "unknown";
  if (probe.failPattern?.test(output)) return "unavailable";
  if (probe.successPattern) {
    if (probe.successPattern.test(output)) return "ready";
    return result.status === 0 && probe.missMeansFalse ? "unavailable" : "unknown";
  }
  return result.status === 0 ? "ready" : "unknown";
}

function modelIdentifiers(impl, binary) {
  const probe = impl.modelProbe;
  if (!probe) return { status: "unsupported" };
  if (probe.static) return { status: "listed", values: probe.static };
  if (probe.file) {
    const base = (probe.envDir && process.env[probe.envDir]) || join(homedir(), probe.homeSubdir);
    try {
      const parsed = JSON.parse(readFileSync(join(base, probe.file), "utf8"));
      if (!Array.isArray(parsed?.models)) return { status: "unknown" };
      return {
        status: "listed",
        values: parsed.models.map((entry) => (typeof entry?.slug === "string" ? entry.slug : "")).filter(Boolean),
      };
    } catch {
      return { status: "unknown" };
    }
  }
  if (!probe.args) return { status: "unsupported" };
  const result = runBounded(binary, probe.args);
  if (result.error || result.status !== 0) return { status: "unknown" };
  const lines = (result.stdout || "").replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let values = null;
  if (probe.format === "cursor") {
    if (lines.includes("Available models")) {
      values = lines.filter((line) => line !== "Available models" && !line.startsWith("Tip:")).map((line) => line.split(/\s+-\s+/, 1)[0]);
    }
  } else if (probe.format === "grok") {
    const starred = lines.filter((line) => line.startsWith("* ")).map((line) => line.slice(2).replace(/\s*\(default\)$/, "").trim()).filter(Boolean);
    if (starred.length > 0) values = starred;
  } else if (probe.format === "table") {
    const rows = lines.slice(1).map((line) => line.split(/\s+/)).filter((cols) => cols.length >= 2).map((cols) => `${cols[0]}/${cols[1]}`);
    if (rows.length > 0) values = rows;
  } else if (lines.length > 0) values = lines;
  if (!values) return { status: "unknown" };
  return { status: "listed", values };
}

function modelStatus(impl, binary, model) {
  if (typeof model !== "string" || model.length === 0) {
    return { status: "unknown", reason: "no model configured; the CLI default is not verified" };
  }
  const probe = impl.modelProbe;
  if (!probe) return { status: "unknown", reason: "no credential-free model listing" };
  const listed = modelIdentifiers(impl, binary);
  if (listed.status !== "listed") return { status: "unknown", reason: "model listing unavailable" };
  if (listed.values.includes(model)) return { status: "ready" };
  // A static alias list or a cached catalog is not exhaustive: a miss means unknown,
  // never a definitive "unavailable". Only a live listing can call a model unavailable.
  if (probe.static) return { status: "unknown", reason: "not a known alias; full model names are not enumerable" };
  if (probe.file) return { status: "unknown", reason: "cached model listing is not definitive" };
  return { status: "unavailable" };
}

function overallStatus(checks, untrusted) {
  const statuses = Object.values(checks).map((check) => check.status);
  let status = "ready";
  if (statuses.includes("unknown")) status = "unknown";
  if (statuses.includes("unavailable") || untrusted) status = "unavailable";
  if (statuses.includes("unsupported")) status = "unsupported";
  return { status, blocked: untrusted || status === "unavailable" || status === "unsupported" };
}

function preflight(fleet, registry, opts) {
  const lane = fleet.lanes.find((item) => item.name === opts.lane);
  if (!lane) throw new Error(`lane not found: ${opts.lane}`);
  const impl = registry.IMPLEMENTER_BY_KEY[lane.implementer];
  const untrusted = Boolean(fleet.projectPresent && !fleet.projectTrusted);
  if (untrusted) {
    return {
      lane: lane.name,
      implementer: lane.implementer,
      readOnly: opts.readOnly,
      untrustedProjectConfig: true,
      status: "unavailable",
      blocked: true,
      checks: { config: { status: "unavailable", reason: "project fleet config is not trusted" } },
    };
  }
  const checks = {};
  const binary = resolveBinary(impl.binary);
  if (!binary) checks.binary = { status: "unavailable" };
  else {
    let version = versionText(impl, runBounded(binary, impl.versionArgs));
    if (version === null && impl.versionFallbackArgs) version = versionText(impl, runBounded(binary, impl.versionFallbackArgs));
    checks.binary = version ? { status: "ready", version } : { status: "unavailable" };
  }
  checks.auth = { status: binary && checks.binary.status === "ready" ? authStatus(impl, binary) : "unknown" };
  checks.model = binary || !impl.modelProbe?.args ? modelStatus(impl, binary, lane.model) : { status: "unknown" };
  if (!opts.readOnly) checks.readOnly = { status: "ready" };
  else if (impl.supports.includes("readOnly")) checks.readOnly = { status: "ready" };
  else checks.readOnly = { status: "unsupported" };
  if (!opts.level) checks.effort = { status: "ready", flag: null };
  else {
    const mapped = effort(fleet, lane.name, opts.level);
    // A dial-less or variant lane cannot take a physical effort flag; the level is
    // expressed in the brief instead. That is supported, not a blocker.
    checks.effort = mapped.flag
      ? { status: "ready", flag: mapped.flag }
      : { status: "ready", flag: null, briefOnly: true, dial: mapped.dial };
  }
  return {
    lane: lane.name,
    implementer: lane.implementer,
    readOnly: opts.readOnly,
    untrustedProjectConfig: false,
    ...overallStatus(checks, false),
    checks,
  };
}

function effort(fleet, laneName, level) {
  if (!["low", "medium", "high"].includes(level)) throw new Error("--level must be low, medium, or high");
  const lane = fleet.lanes.find((l) => l.name === laneName);
  if (!lane) throw new Error(`lane not found: ${laneName}`);
  const { dial, values } = lane.effort;
  if (dial === "effort" && values.includes(level)) return { lane: laneName, dial, value: level, flag: `--effort ${level}` };
  return { lane: laneName, dial, value: null, flag: null };
}

function parse(argv) {
  const out = { cmd: argv[0], cwd: process.cwd(), exclude: [], write: false, readOnly: false };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} requires a value`); return v; };
    if (a === "--cwd") out.cwd = resolve(next());
    else if (a === "--need") out.need = next();
    else if (a === "--lane") out.lane = next();
    else if (a === "--level") out.level = next();
    else if (a === "--exclude") out.exclude.push(next());
    else if (a === "--write") out.write = true;
    else if (a === "--read-only") out.readOnly = true;
    else if (a === "--json") { /* default */ }
    else throw new Error(`unknown option ${a}`);
  }
  return out;
}

async function main(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    process.exit(argv.length === 0 ? 2 : 0);
  }
  try {
    const o = parse(argv);
    const loaded = await loadFleet(o.cwd);
    const fleet = loaded.report;
    let result;
    let code = 0;
    if (o.cmd === "list") result = fleet;
    else if (o.cmd === "pick") {
      if (!o.need) throw new Error("pick requires --need <role>");
      if (o.write && o.readOnly) throw new Error("--write and --read-only are mutually exclusive");
      result = pick(fleet, o.need, o);
    } else if (o.cmd === "effort") {
      if (!o.lane || !o.level) throw new Error("effort requires --lane and --level");
      result = effort(fleet, o.lane, o.level);
    } else if (o.cmd === "preflight") {
      if (!o.lane) throw new Error("preflight requires --lane <name>");
      result = preflight(fleet, loaded.registry, o);
      code = result.blocked ? 1 : 0;
    } else throw new Error(`unknown command ${JSON.stringify(o.cmd)}`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (code !== 0) process.exit(code);
  } catch (error) {
    process.stderr.write(`fleet.mjs: ${error.message}\n`);
    process.exit(2);
  }
}

main(process.argv.slice(2));
