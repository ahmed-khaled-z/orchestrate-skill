#!/usr/bin/env node
/**
 * specialists.mjs — read-only discovery of installed Agency Agent specialist
 * profiles for the orchestrate skill. Scans the Claude and Codex agent rosters
 * on every invocation (no cache, no index) and joins twins by exact name.
 *
 * Usage:
 *   node specialists.mjs audit
 *   node specialists.mjs find --query "<task domain terms>" [--limit <n>]
 *   node specialists.mjs find --name "<exact profile name>"
 *   node specialists.mjs --help
 *
 * Exit codes: 0 = audit ok / at least one candidate, 1 = audit not ok / zero
 * candidates, 2 = usage or unexpected error (message on stderr).
 * Node built-ins only. Writes nothing.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HELP = `specialists.mjs — discover installed specialist profiles (read-only)

Usage:
  node specialists.mjs audit
  node specialists.mjs find --query "<task domain terms>" [--limit <n>]
  node specialists.mjs find --name "<exact profile name>"

audit scans both runtime rosters and pairs twins by exact profile name.
find --query ranks candidates by keyword overlap; find --name exact-matches one.
Exit codes: 0 = ok / has candidates, 1 = not ok / none, 2 = usage error.
`;

const STOPWORDS = new Set("and the for with you your that this from into who are".split(" "));

function roots() {
  return {
    claude: join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "agents"),
    codex: join(process.env.CODEX_HOME || join(homedir(), ".codex"), "agents"),
  };
}

function stripQuotes(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseMd(text) {
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") return { problem: "no frontmatter" };
  const meta = {};
  let closed = false;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      closed = true;
      break;
    }
    const m = lines[i].match(/^(name|description):(.*)$/);
    if (m && meta[m[1]] === undefined) meta[m[1]] = m[2].trim();
  }
  if (!closed) return { problem: "unterminated frontmatter" };
  const out = {};
  for (const key of ["name", "description"]) {
    const raw = meta[key];
    if (raw === undefined || raw === "") return { problem: `${key} missing or empty` };
    if (raw.startsWith(">") || raw.startsWith("|")) return { problem: `${key} is a block scalar` };
    const value = stripQuotes(raw);
    if (value === "") return { problem: `${key} empty` };
    out[key] = value;
  }
  return out;
}

function parseToml(text) {
  // ponytail: line regex, not a TOML parser; swap in a parser if profiles start using other string forms.
  const out = {};
  for (const key of ["name", "description"]) {
    let raw;
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(new RegExp(`^${key} = "(.*)"$`));
      if (m) {
        raw = m[1];
        break;
      }
    }
    if (raw === undefined) return { problem: `${key} missing or not a basic string` };
    let value;
    try {
      value = JSON.parse(`"${raw}"`);
    } catch {
      return { problem: `${key} has an invalid escape` };
    }
    if (value === "") return { problem: `${key} empty` };
    out[key] = value;
  }
  return out;
}

function scanRuntime(dir, ext) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { missing: true, profiles: [], problems: [{ path: dir, error: "root directory not found" }] };
  }
  const profiles = [];
  const problems = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(ext)) continue;
    const path = join(dir, file);
    try {
      if (!statSync(path).isFile()) continue;
      const parsed =
        ext === ".md" ? parseMd(readFileSync(path, "utf8")) : parseToml(readFileSync(path, "utf8"));
      if (parsed.problem) problems.push({ path, error: parsed.problem });
      else profiles.push({ name: parsed.name, description: parsed.description, path });
    } catch (error) {
      problems.push({ path, error: error.message });
    }
  }
  return { missing: false, profiles, problems };
}

function indexByName(profiles) {
  const byName = new Map();
  const duplicates = [];
  for (const p of profiles) {
    const seen = byName.get(p.name);
    if (!seen) {
      byName.set(p.name, p);
      continue;
    }
    let dup = duplicates.find((d) => d.name === p.name);
    if (!dup) {
      dup = { name: p.name, paths: [seen.path] };
      duplicates.push(dup);
    }
    dup.paths.push(p.path);
  }
  return { byName, duplicates };
}

function roster() {
  const r = roots();
  const claude = scanRuntime(r.claude, ".md");
  const codex = scanRuntime(r.codex, ".toml");
  const claudeIdx = indexByName(claude.profiles);
  const codexIdx = indexByName(codex.profiles);
  const names = [...new Set([...claudeIdx.byName.keys(), ...codexIdx.byName.keys()])].sort();
  const profiles = names.map((name) => {
    const c = claudeIdx.byName.get(name) ?? null;
    const x = codexIdx.byName.get(name) ?? null;
    const primary = c ?? x;
    return {
      name,
      description: primary.description,
      profile: primary.path,
      claude: c ? c.path : null,
      codex: x ? x.path : null,
    };
  });
  return {
    roots: r,
    profiles,
    counts: {
      claude: claudeIdx.byName.size,
      codex: codexIdx.byName.size,
      paired: profiles.filter((p) => p.claude && p.codex).length,
    },
    claudeOnly: profiles.filter((p) => !p.codex).map((p) => ({ name: p.name, path: p.claude })),
    codexOnly: profiles.filter((p) => !p.claude).map((p) => ({ name: p.name, path: p.codex })),
    duplicates: [...claudeIdx.duplicates, ...codexIdx.duplicates].sort((a, b) => (a.name < b.name ? -1 : 1)),
    problems: [...claude.problems, ...codex.problems],
    missingRoot: claude.missing || codex.missing,
  };
}

function audit() {
  const r = roster();
  const ok =
    !r.missingRoot &&
    r.claudeOnly.length === 0 &&
    r.codexOnly.length === 0 &&
    r.duplicates.length === 0 &&
    r.problems.length === 0;
  return {
    roots: r.roots,
    counts: r.counts,
    claudeOnly: r.claudeOnly,
    codexOnly: r.codexOnly,
    duplicates: r.duplicates,
    problems: r.problems,
    ok,
  };
}

function tokenize(s) {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function findQuery(profiles, query, limit) {
  // ponytail: keyword overlap, no stemming or synonyms; the orchestrator broadens the query instead.
  const tokens = [...new Set(tokenize(query))];
  const scored = [];
  for (const p of profiles) {
    const nameTokens = new Set(tokenize(p.name));
    const descriptionTokens = new Set(tokenize(p.description));
    let score = 0;
    for (const t of tokens) {
      if (nameTokens.has(t)) score += 3;
      if (descriptionTokens.has(t)) score += 1;
    }
    if (score > 0) scored.push({ ...p, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1));
  return scored.slice(0, limit);
}

function parseArgs(argv) {
  const out = { cmd: argv[0] };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      return v;
    };
    if (a === "--query") out.query = next();
    else if (a === "--name") out.name = next();
    else if (a === "--limit") {
      const n = Number(next());
      if (!Number.isInteger(n) || n < 1) throw new Error("--limit must be an integer >= 1");
      out.limit = n;
    } else throw new Error(`unknown option ${a}`);
  }
  return out;
}

function main(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    process.exit(argv.length === 0 ? 2 : 0);
  }
  try {
    let result;
    let code;
    const o = parseArgs(argv);
    if (o.cmd === "audit") {
      result = audit();
      code = result.ok ? 0 : 1;
    } else if (o.cmd === "find") {
      if (o.query && o.name) throw new Error("--query and --name are mutually exclusive");
      if (!o.query && !o.name) throw new Error("find requires --query <terms> or --name <exact profile name>");
      const r = roster();
      let candidates;
      let note = null;
      if (o.query) {
        candidates = findQuery(r.profiles, o.query, o.limit ?? 10);
        if (candidates.length === 0) note = "no profile matched; broaden the query, then stop and report";
        result = { query: o.query, candidates, note };
      } else {
        candidates = r.profiles.filter((p) => p.name === o.name);
        if (candidates.length === 0) note = `no installed profile named "${o.name}"`;
        result = { name: o.name, candidates, note };
      }
      code = candidates.length > 0 ? 0 : 1;
    } else {
      throw new Error(`unknown command ${JSON.stringify(o.cmd)}; try --help`);
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(code);
  } catch (error) {
    process.stderr.write(`specialists.mjs: ${error.message}\n`);
    process.exit(2);
  }
}

main(process.argv.slice(2));
