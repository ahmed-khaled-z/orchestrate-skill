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

audit pairs twins by exact name, then compares description and normalized
instructions (Markdown body vs TOML developer_instructions). coverage says
what was actually compared. find --query ranks keyword overlap plus a small
synonym and Arabic alias table; it emits normalized tokens and match evidence.
find --name is exact. Duplicate, problem, and drift profiles are excluded.
Exit codes: 0 = ok / has candidates, 1 = not ok / none, 2 = usage error.
`;

const STOPWORDS = new Set("and the for with you your that this from into who are".split(" "));
const SHORT = new Set(["db", "ui", "qa", "acl"]);

// Explicit groups only. A query token scores its group once.
const GROUPS = [
  ["login", "signin", "auth", "authentication", "authenticate"],
  ["permission", "permissions", "authorization", "authorize", "acl", "rbac"],
  ["database", "db", "sql", "migration", "migrations", "migrate"],
  ["payment", "payments", "billing", "checkout", "invoice"],
  ["ui", "ux", "frontend", "interface"],
  ["test", "tests", "testing", "qa"],
];
const GROUP_BY = new Map(GROUPS.flatMap((group) => group.map((word) => [word, group])));

// Longest phrase first so اختبارات is consumed before اختبار.
const ARABIC_ALIASES = [
  ["تسجيل الدخول", "login"],
  ["قاعدة البيانات", "database"],
  ["صلاحيات", "permissions"],
  ["اختبارات", "testing"],
  ["مدفوعات", "payment"],
  ["مصادقة", "authentication"],
  ["ترحيل", "migration"],
  ["فاتورة", "payment"],
  ["اختبار", "testing"],
  ["واجهة", "ui"],
  ["دفع", "payment"],
];

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
    if (m && meta[m[1]] === undefined) {
      let value = m[2].trim();
      // YAML plain scalars fold: more-indented lines continue the value.
      if (!value.startsWith('"') && !value.startsWith("'")) {
        while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1]) && lines[i + 1].trim() !== "---") {
          i += 1;
          value = `${value} ${lines[i].trim()}`;
        }
      }
      meta[m[1]] = value;
    }
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
  const closeAt = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  out.instructions = normalizeInstructions(lines.slice(closeAt + 1).join("\n"));
  return out;
}

function normalizeInstructions(text) {
  if (text == null) return null;
  const normalized = text.replace(/\r\n/g, "\n").split("\n").map((line) => line.trimEnd()).join("\n").trim();
  return normalized === "" ? null : normalized;
}

// Formatting-only: standalone Markdown horizontal dividers carry no instruction.
const DIVIDER_LINE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

function stripDividers(text) {
  if (text == null) return null;
  const stripped = text.split("\n").filter((line) => !DIVIDER_LINE.test(line)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return stripped === "" ? null : stripped;
}

function parseBasicString(line, key) {
  const match = line.match(new RegExp(`^${key} = "(.*)"$`));
  if (!match) return undefined;
  return JSON.parse(`"${match[1]}"`);
}

function parseToml(text) {
  // ponytail: line regex, not a TOML parser; swap in a parser if profiles start using other string forms.
  const lines = text.split(/\r?\n/);
  const out = {};
  for (const key of ["name", "description"]) {
    let raw;
    try {
      for (const line of lines) {
        const value = parseBasicString(line, key);
        if (value !== undefined) {
          raw = value;
          break;
        }
      }
    } catch {
      return { problem: `${key} has an invalid escape` };
    }
    if (raw === undefined) return { problem: `${key} missing or not a basic string` };
    if (raw === "") return { problem: `${key} empty` };
    out[key] = raw;
  }
  let instructions;
  let sawInstructions = false;
  try {
    for (const line of lines) {
      if (/^developer_instructions\s*=/.test(line)) sawInstructions = true;
      const value = parseBasicString(line, "developer_instructions");
      if (value !== undefined) {
        instructions = value;
        break;
      }
    }
  } catch {
    return { problem: "developer_instructions has an invalid escape" };
  }
  if (sawInstructions && instructions === undefined) return { problem: "developer_instructions not a basic string" };
  out.instructions = normalizeInstructions(instructions ?? null);
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
      else profiles.push({
        name: parsed.name,
        description: parsed.description,
        instructions: parsed.instructions ?? null,
        path,
      });
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
      instructions: { claude: c?.instructions ?? null, codex: x?.instructions ?? null },
      profile: primary.path,
      claude: c ? c.path : null,
      codex: x ? x.path : null,
      claudeDescription: c?.description ?? null,
      codexDescription: x?.description ?? null,
    };
  });
  const drift = [];
  const formattingOnly = [];
  const unavailable = [];
  for (const profile of profiles) {
    if (!profile.claude || !profile.codex) continue;
    const descriptionDiffers = profile.claudeDescription !== profile.codexDescription;
    const claudeBody = profile.instructions.claude;
    const codexBody = profile.instructions.codex;
    const instructionsMissing = claudeBody == null || codexBody == null;
    const rawDiffer = !instructionsMissing && claudeBody !== codexBody;
    const instructionsDiffer = !instructionsMissing && stripDividers(claudeBody) !== stripDividers(codexBody);
    if (descriptionDiffers || instructionsDiffer) {
      drift.push({
        name: profile.name,
        description: descriptionDiffers,
        instructions: instructionsDiffer,
        claude: profile.claude,
        codex: profile.codex,
      });
    } else if (rawDiffer) {
      formattingOnly.push(profile.name);
    }
    if (instructionsMissing) {
      unavailable.push({
        name: profile.name,
        reason: claudeBody == null ? "claude instructions missing" : "codex developer_instructions missing",
      });
    }
  }
  const paired = profiles.filter((profile) => profile.claude && profile.codex);
  const coverage = {
    identity: "checked",
    description: paired.length > 0 ? "checked" : "not-checked",
    instructions: paired.length > 0 && paired.every((profile) => profile.instructions.claude != null && profile.instructions.codex != null)
      ? "checked"
      : "not-checked",
    dividers: "standalone Markdown divider lines (---, ***, ___) removed before instruction comparison",
  };
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
    drift,
    formattingOnly,
    unavailable,
    coverage,
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
    r.problems.length === 0 &&
    r.drift.length === 0 &&
    r.unavailable.length === 0;
  return {
    roots: r.roots,
    counts: r.counts,
    claudeOnly: r.claudeOnly,
    codexOnly: r.codexOnly,
    duplicates: r.duplicates,
    problems: r.problems,
    drift: r.drift,
    formattingOnly: r.formattingOnly,
    unavailable: r.unavailable,
    coverage: r.coverage,
    ok,
  };
}

function tokenize(s) {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((token) => !STOPWORDS.has(token) && (token.length >= 3 || SHORT.has(token)));
}

function conceptsFor(query) {
  let rest = query;
  const aliasTokens = [];
  for (const [phrase, token] of ARABIC_ALIASES) {
    if (!rest.includes(phrase)) continue;
    aliasTokens.push(token);
    rest = rest.split(phrase).join(" ");
  }
  const prepared = rest.toLowerCase().replace(/sign-in/g, "signin").replace(/sign in/g, "signin");
  const literal = [...new Set(tokenize(prepared))];
  const seen = new Set();
  const concepts = [];
  const add = (token, via) => {
    const words = GROUP_BY.get(token) ?? [token];
    const id = words[0];
    if (seen.has(id)) return;
    seen.add(id);
    concepts.push({ id, words, via });
  };
  for (const token of literal) add(token, "literal");
  for (const token of aliasTokens) add(token, "alias");
  return { concepts, literal: new Set(literal) };
}

function presentProfile(profile) {
  return {
    name: profile.name,
    description: profile.description,
    profile: profile.profile,
    claude: profile.claude,
    codex: profile.codex,
  };
}

function findQuery(profiles, query, limit) {
  const { concepts, literal } = conceptsFor(query);
  const normalized = [...new Set(concepts.flatMap((concept) => concept.words))].sort();
  const scored = [];
  for (const profile of profiles) {
    const nameTokens = new Set(tokenize(profile.name));
    const descriptionTokens = new Set(tokenize(profile.description));
    let score = 0;
    const evidence = [];
    for (const concept of concepts) {
      let nameHit = false;
      let descriptionHit = false;
      for (const word of concept.words) {
        const via = concept.via === "alias" ? "alias" : literal.has(word) ? "exact" : "synonym";
        if (nameTokens.has(word)) {
          nameHit = true;
          evidence.push({ token: word, field: "name", via });
        }
        if (descriptionTokens.has(word)) {
          descriptionHit = true;
          evidence.push({ token: word, field: "description", via });
        }
      }
      if (nameHit) score += 3;
      if (descriptionHit) score += 1;
    }
    if (score > 0) {
      evidence.sort((a, b) => a.token.localeCompare(b.token) || a.field.localeCompare(b.field) || a.via.localeCompare(b.via));
      scored.push({ ...presentProfile(profile), score, evidence });
    }
  }
  scored.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1));
  return { normalized, candidates: scored.slice(0, limit) };
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
      const excluded = new Set([...r.duplicates.map((item) => item.name), ...r.drift.map((item) => item.name)]);
      const visible = r.profiles.filter((profile) => !excluded.has(profile.name));
      let candidates;
      let note = null;
      if (o.query) {
        const matched = findQuery(r.profiles, o.query, Number.MAX_SAFE_INTEGER);
        const hidden = matched.candidates.filter((candidate) => excluded.has(candidate.name));
        candidates = matched.candidates.filter((candidate) => !excluded.has(candidate.name)).slice(0, o.limit ?? 10);
        if (candidates.length === 0 && hidden.length > 0) {
          note = hidden.some((candidate) => r.duplicates.some((item) => item.name === candidate.name))
            ? "matches excluded (duplicate or drift); stop and report"
            : "matches excluded (drift); stop and report";
        } else if (candidates.length === 0) note = "no profile matched; broaden the query, then stop and report";
        result = { query: o.query, normalized: matched.normalized, candidates, note };
      } else {
        if (excluded.has(o.name)) {
          candidates = [];
          note = `profile "${o.name}" excluded (duplicate or drift); stop and report`;
        } else {
          candidates = visible.filter((profile) => profile.name === o.name).map(presentProfile);
          if (candidates.length === 0) note = `no installed profile named "${o.name}"`;
        }
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
