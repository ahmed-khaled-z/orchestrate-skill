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
 *   node fleet.mjs --help
 *
 * Roles (routing vocabulary, not lane config):
 *   quick feature ui debug tests docs plan review
 * A lane's `roles` field (declared in the fleet) wins; otherwise roles are inferred
 * from the lane name. Node built-ins only. No network, no writes.
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HELP = `fleet.mjs — introspect the live delegate fleet (read-only)

Usage:
  node fleet.mjs list   [--cwd <repo>]
  node fleet.mjs pick   --need <role> [--write | --read-only] [--exclude <lane>]... [--cwd <repo>]
  node fleet.mjs effort --lane <name> --level low|medium|high [--cwd <repo>]

Roles: quick feature ui debug tests docs plan review
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
    globalPath: effective.globalPath,
    projectPath: effective.projectPath,
    projectPresent: effective.projectPresent,
    projectTrusted: effective.projectTrusted,
    lanes,
  };
}

function command(lane, readOnly) {
  const parts = [`node "${lane.relay ?? `<${lane.skill}>/scripts/relay.mjs`}"`, "--brief <brief>", `--lane ${lane.name}`, "--cd <repo>"];
  if (lane.effort.dial === "effort") parts.push("[--effort <level>]");
  if (readOnly) parts.push("--read-only");
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
    const fleet = await loadFleet(o.cwd);
    let result;
    if (o.cmd === "list") result = fleet;
    else if (o.cmd === "pick") {
      if (!o.need) throw new Error("pick requires --need <role>");
      if (o.write && o.readOnly) throw new Error("--write and --read-only are mutually exclusive");
      result = pick(fleet, o.need, o);
    } else if (o.cmd === "effort") {
      if (!o.lane || !o.level) throw new Error("effort requires --lane and --level");
      result = effort(fleet, o.lane, o.level);
    } else throw new Error(`unknown command ${JSON.stringify(o.cmd)}`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`fleet.mjs: ${error.message}\n`);
    process.exit(2);
  }
}

main(process.argv.slice(2));
