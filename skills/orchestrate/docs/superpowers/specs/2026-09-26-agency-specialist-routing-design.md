# Agency Agent specialist routing — design

Status: approved architecture, written 2026-09-26. Owner: Multi-Agent Systems Architect.
Inputs: user-approved architecture, Architecture specialist findings, Prompt Engineer findings.

## 1. Goal

Every task orchestrate dispatches carries one domain **specialist**: an installed Agency Agent
profile whose expertise best fits that task's acceptance criteria. The specialist shapes *how* the
delegate reasons about the domain. It never decides *where* the task runs: lane, implementer, model,
and effort still come only from `scripts/fleet.mjs`.

### Non-goals

- Mapping specialists to fleet lanes. The fleet keeps its current lanes; there are never 279 lanes.
- Installing, syncing, or editing profiles. Installation is done and verified (§2).
- Semantic ranking in code. The helper script discovers candidates; the orchestrator chooses.
- Injecting specialists into `debate-review` or `babysit-pr` internals. Those skills own their
  reviewers. Fix briefs that orchestrate dispatches from review findings do get an owner.
- Project-level agent directories (`<repo>/.claude/agents`). Only the user-level roster is read.
- Native subagent spawning. Delegates read the profile file; they still never spawn agents.

## 2. Verified installation state (2026-09-26)

| Runtime | Root | Format | Profiles |
| --- | --- | --- | --- |
| Claude | `~/.claude/agents/*.md` | YAML frontmatter, single-line `name:` and `description:` | 279 |
| Codex | `~/.codex/agents/*.toml` | top-level `name = "…"`, `description = "…"`, `developer_instructions` | 279 |

- Joined by exact `name`: 279 paired, 0 Claude-only, 0 Codex-only, 0 duplicate names.
- Filenames differ between runtimes, so the join key is the profile `name`, never the filename.
  Example: `~/.claude/agents/engineering-minimal-change-engineer.md` and
  `~/.codex/agents/minimal-change-engineer.toml` are both `Minimal Change Engineer`.

The count 279 is a fact about today's machine. No code, test, or doc hardcodes it.

## 3. Architecture

```text
request
  → Ground → Classify
  → Resolve the fleet    fleet.mjs pick        lane, implementer, model, effort   (unchanged)
  → Plan tasks
  → Pick specialists     specialists.mjs find  candidates → orchestrator chooses owner (+ advisors)
  → Brief                one <specialist> element per brief
  → Dispatch             advisors (read-only) first, then the owner (writable)
  → Verify → Review → Report
```

Topology stays hierarchical: the orchestrator decomposes, selects, and synthesizes; delegates
execute. Specialists never talk to each other. Advisor output reaches the owner only as facts the
orchestrator pastes into the owner's brief.

Specialist selection runs after the fleet is resolved and only reads the task. It has no input into
`--need`, lane choice, model, or effort. A security-heavy task with a Security Engineer owner still
gets its `--need` role from routing.md §1 and its effort from routing.md §2.

## 4. Files and interfaces

| File | Change |
| --- | --- |
| `scripts/specialists.mjs` | new; Node built-ins only; read-only |
| `tests/specialists.test.mjs` | new; `node:test`, fake roots |
| `SKILL.md` | loop step 3b, Specialist column, one Fallback sentence, one red-flag row, description adds "specialist" |
| `references/routing.md` | new §5 Specialists: selection, one-vs-multiple, collisions, missing profiles |
| `references/brief.md` | `<specialist>` element, precedence line, two contract rules |
| `references/examples.md` | Specialist column in both routing tables |
| `tests/scenarios.md` | scenarios J–N |
| `tests/results.md` | live audit result and GREEN runs for J–N |

`fleet.mjs`, `fleet.test.mjs`, `build.md`, relays, fleet config, and installed profiles stay
unchanged. `build.md` already requires disjoint files for parallel work; routing.md §5 is the single
source of truth for the specialist-specific collision rule.

### 4.1 `scripts/specialists.mjs`

```text
node specialists.mjs audit
node specialists.mjs find --query "<task domain terms>" [--limit <n>]
node specialists.mjs find --name "<exact profile name>"
node specialists.mjs --help
```

**Roots**, resolved on every invocation (no cache, no index file):

- Claude: `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/agents`, top-level `*.md`
- Codex: `${CODEX_HOME:-$HOME/.codex}/agents`, top-level `*.toml`

Both env vars are the runtimes' own home overrides, so the script adds no new configuration. Tests
point `HOME` at a temp dir and unset both vars.

**Parsing** (no YAML or TOML dependency):

- `.md`: file starts with `---`; read `name:` and `description:` lines inside the frontmatter; strip
  one pair of surrounding quotes. A missing or empty value, or a block scalar (`>` / `|`), is a problem
  entry for that file.
- `.toml`: first `^name = "(.*)"$` and `^description = "(.*)"$` lines; decode the captured value with
  `JSON.parse('"' + v + '"')`. Literal (`'…'`) or multi-line strings are problem entries.
  `// ponytail: line regex, not a TOML parser; swap in a parser if profiles start using other string forms.`
- An unreadable file is a problem entry `{ path, error }`. Nothing is dropped silently.

**Join**: by exact `name` string (case-sensitive). A name appearing twice in one runtime is a
duplicate. Each joined profile is:

```json
{ "name": "Minimal Change Engineer", "description": "…",
  "profile": "/Users/…/.claude/agents/engineering-minimal-change-engineer.md",
  "claude": "/Users/…/.claude/agents/engineering-minimal-change-engineer.md",
  "codex": "/Users/…/.codex/agents/minimal-change-engineer.toml" }
```

`profile` is the path briefs use: the Claude `.md` when present (plain Markdown any implementer can
read), else the Codex `.toml`. Descriptions come from the `.md` when present, else the `.toml`.

**`audit`** prints

```json
{ "roots": { "claude": "…", "codex": "…" },
  "counts": { "claude": 279, "codex": 279, "paired": 279 },
  "claudeOnly": [], "codexOnly": [], "duplicates": [], "problems": [], "ok": true }
```

`ok` is true only when both roots exist and every list is empty. A missing root is a problem entry.

**`find --query`**: tokenize query, name, and description with lowercase `[a-z0-9]+`; drop tokens
shorter than 3 characters and the stopwords `and the for with you your that this from into who are`.
Score each profile over the unique query tokens: +3 when the token is in the name, +1 when it is in
the description. Keep score > 0; sort by score descending, then name by code-point order; return the
first `--limit` (default 10, integer ≥ 1). Profiles with problems are excluded from results and still
listed by `audit`.
`// ponytail: keyword overlap, no stemming or synonyms; the orchestrator broadens the query instead.`

**`find --name`**: exact name match; `candidates` holds zero or one profile. No nearest-name
suggestion is ever returned.

`find` output: `{ "query" | "name": …, "candidates": [ <joined profile + "score" for --query> ], "note" }`.
`note` is null when candidates exist, else `no installed profile named "<name>"` or
`no profile matched; broaden the query, then stop and report`.

**Exit codes**: 0 = audit ok / at least one candidate; 1 = audit not ok / zero candidates;
2 = usage or unexpected error (message on stderr, as in `fleet.mjs`). The script writes nothing.

## 5. Selection algorithm (routing.md §5)

Once per orchestrate run, before the first `find`: run `audit` and carry any non-empty list into
the plan (§10), so profiles excluded from `find` are never excluded silently.

Per dispatched task, after its lane and effort are fixed:

1. **List the acceptance criteria** for the task (the lines that will go in the brief).
2. **Discover.** `find --query` with the task's domain terms (for example
   `"postgres migration schema"`). The score only orders candidates; it never selects.
3. **Choose the owner.** Read the candidates' descriptions (open a profile when descriptions tie on
   fit). Pick the one whose expertise covers the most acceptance criteria. Write the fit as one line
   naming the criterion it covers. For a mechanical edit (the `quick` role, `ponytail ultra`), start
   from Minimal Change Engineer and keep it unless a domain profile fits the criteria better.
4. **Broaden once.** When no candidate fits, rerun `find --query` with broader domain or discipline
   terms and `--limit 25`.
5. **Stop.** Still no justified fit → stop before dispatch and report the task, both queries, and the
   closest rejected candidates with one-line reasons. Never invent a specialist, never dispatch
   without an owner, never pick a poor fit to keep moving.
6. **Resolve.** `find --name "<chosen>"` exits 0 and yields the `profile` path for the brief; exit 1
   follows §10.
7. **Advisors** (§7): add one only when it owns a distinct verifiable acceptance criterion outside the
   owner's expertise. Resolve each the same way.

A specialist the user named explicitly skips steps 2–5 and goes straight to step 6.

## 6. Routing-table and brief contract

**Routing table** (SKILL.md), with one new column:

```text
Task | Role→Lane | Implementer | Model | Effort (dial or brief-only) | Specialist | Skills | Depends on | Verify
```

The Specialist cell holds the exact installed name. Advisor tasks are their own rows (read-only lane,
Specialist = advisor name, Depends on = nothing or prerequisites) and the owner row lists them in
Depends on. Quick mode decides the column in the orchestrator's head, like every other column.

**Brief** (brief.md): every brief has exactly one `<specialist>` element, placed right after `<route>`:

```xml
<specialist name="Minimal Change Engineer"
            profile="/Users/…/.claude/agents/engineering-minimal-change-engineer.md"
            role="owner"
            fit="Owns 'diff touches only formatPrice and its test' criterion." />
```

- `name`: exact installed name. `profile`: absolute path from `find --name`. `fit`: one line tying the
  specialist to a named acceptance criterion.
- `role="owner"` for every writable task and for standalone read-only tasks (diagnosis, planning).
  `role="advisor" feeds="<owner task id>"` for advice tasks.
- The `<required_skills>` block gains one line: read the specialist profile before acting; if it
  cannot be read, stop and report (no guessed persona).
- Advisor findings reach the owner as facts in `<context>`, attributed by specialist name, with the
  orchestrator's disposition of any conflict. "See the advisor's report" is never enough (brief.md
  already requires concrete dependency results).

## 7. One owner, minimal advisors

- **One owner per dispatched task, always.** The owner is the only specialist whose persona the
  writable delegate adopts.
- **Second specialist only for a distinct verifiable outcome.** It must own at least one acceptance
  criterion the owner's expertise does not cover (for example, "no new auth bypass" alongside "refund
  totals correct"). An advisor that cannot name its criterion is dropped. Wanting a second opinion is
  what `debate-review` is for.
- **Genuinely separate surfaces become separate tasks,** each with its own owner (backend owner, UI
  owner, docs owner), following build.md decomposition.

## 8. Collision handling

- Parallel writable tasks only when their `<scope>` file sets are disjoint (unchanged build.md rule).
  Each has its own owner.
- Overlapping scope is serial. When two specialists' criteria land in the same files, the
  collaboration is always: advisors run first as read-only tasks (lane from
  `fleet.mjs pick --need review --read-only`, or `plan` for design advice), `touchedFiles` verified
  empty; then exactly one writable owner task applies the synthesized findings.
- Advisors on the same owner may run in parallel with each other; they write nothing.
- Conflicting advice is resolved by the orchestrator before the owner dispatch and the decision is
  written into the owner's `<context>`. Unresolvable conflict → ask the user.
- An advisor that fails follows SKILL.md Fallback (retry once, next read-only candidate). Still no
  findings → stop and report; the owner is not dispatched with that criterion unexamined.

## 9. Precedence

Inside a delegate, highest first:

1. The user's explicit instructions and repository `CLAUDE.md` / `AGENTS.md`.
2. `<action_safety>` (no commits, no pushes, no spawned agents, no scope growth).
3. The brief: `<scope>`, `<leave_untouched>`, `<requirements>`, `<acceptance_criteria>`, `<report_contract>`.
4. `<required_skills>`, including `ponytail`.
5. The specialist profile: domain judgment only.

The brief states this in one sentence. Profile instructions that conflict (spawn agents, run pipelines,
produce extra deliverables, require eval suites, change the report format) yield to items 1–4.

## 10. Missing or unreadable profiles

| Situation | Behavior |
| --- | --- |
| `audit` not ok at run start (§5) | Report the lists in the plan; profiles on the problem lists are unavailable. Continue with the rest. |
| Orchestrator-chosen profile missing at resolve (`find --name` exit 1) | Say so in the routing table, rerun §5 steps 2–6, and record the replacement with its reason. |
| User-named profile missing | Stop and ask. No substitute. |
| Delegate cannot read `profile` | Delegate stops and reports; orchestrator treats it as the missing-profile row above. |
| No justified fit after broadening | Stop and report (§5 step 5). |
| One runtime root missing | `audit` not ok; `find` still returns profiles from the other root with a `null` twin path. |

Every row is visible in the routing table or the report. No silent substitution.

## 11. Verification

### Script tests (`tests/specialists.test.mjs`, `node --test tests/`)

Each test builds fake roots under a temp `HOME` with `CLAUDE_CONFIG_DIR` and `CODEX_HOME` unset,
except test 2.

1. **Join by name, not filename**: `engineering-foo.md` and `foo-engineer.toml` both named
   `Foo Engineer`, plus one more pair → `audit` ok, `paired` 2, exit 0; `profile` is the `.md` path.
2. **Runtime home overrides**: roots under `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are read instead of
   `HOME`.
3. **Mismatch is loud**: a Claude-only and a Codex-only profile → listed in `claudeOnly` / `codexOnly`,
   `ok` false, exit 1.
4. **Duplicates and bad files**: two `.md` files with one name, one `.md` with no frontmatter, one
   `.toml` with a literal-string name → `duplicates` and `problems` populated, exit 1; the bad files
   never appear in `find` results.
5. **Deterministic find**: fixed roster and query → exact expected order (name hit outranks
   description hit; equal scores ordered by name); two runs produce byte-identical stdout; `--limit`
   truncates.
6. **Exact name**: `find --name "Foo Engineer"` → one candidate; `find --name "foo engineer"` and a
   missing name → zero candidates, the missing-name note, exit 1, and no other profile in the output.
7. **No cache**: `find --name "Bar Engineer"` exits 1; add that twin pair; the same command exits 0.
8. **No match**: a query sharing no tokens with the roster → empty candidates, broaden note, exit 1.

### Live audit (recorded in `tests/results.md`, not asserted in the suite)

`node scripts/specialists.mjs audit` on the real machine → `counts` 279/279/279, every list empty,
`ok` true, exit 0. The suite never asserts 279; the roster may change.

### Behavioral scenarios (`tests/scenarios.md`, dry runs like A–I)

| # | Scenario | Expected |
| --- | --- | --- |
| J | Scenario A (USD typo) | Owner Minimal Change Engineer with a fit line and absolute path; no advisors; lane, model, effort identical to a run without this feature |
| K | Scenario E (audit log: backend, UI, docs) | Three owners chosen through `find` with fit lines; T1 ∥ T2 (disjoint files); docs after T1; one `<specialist>` per brief |
| L | "Add refund endpoint; must not weaken auth" touching one handler file | Read-only security advisor task first (`review` lane), `touchedFiles` empty; one writable owner whose `<context>` carries the attributed findings; no concurrent writers |
| M | Brief names a profile removed from the fake roster; separately, user names a missing profile | First: missing shown in the table, replacement chosen with reason. Second: stop and ask |
| N | Fake roster with no fitting profile | Two `find` queries shown, stop before dispatch, closest rejects listed with reasons |

Precedence is checked in J–L: each brief carries the precedence sentence, and the Agents
Orchestrator profile (which instructs spawning agents) chosen as a forced owner in a J variant does
not cause the delegate brief to permit spawning.

Separation from the fleet is checked in J and K: the Role→Lane, Implementer, Model, and Effort cells
equal the `fleet.mjs pick` / `effort` output, and swapping the chosen specialist changes none of them.

## 12. Rejected complexity

- One fleet lane per specialist or a specialist→lane map: 279 lanes, duplicated routing, and fleet
  churn on every roster change.
- A hardcoded or cached roster (JSON index, generated table): goes stale; the directories are the
  source of truth and a scan is cheap.
- Embeddings, LLM ranking, or synonym tables in the script: the orchestrator already does semantic
  choice; the script stays deterministic and testable.
- YAML/TOML parser dependencies: two line regexes cover the installed format; failures surface in
  `audit`.
- Multiple writable specialists on one file, merge steps, or peer negotiation between specialists:
  mesh complexity with collision risk; advice-then-owner covers the need.
- Specialists influencing lane, model, or effort: couples two independent decisions and breaks
  fleet-only routing.
- Inlining profile text into briefs: bloats past the ~600-word brief budget; the absolute path suffices.
- A fixed cap on advisors: the distinct-criterion test already bounds them.

## 13. Self-review

- **Placeholders**: none. Example paths use `…` only to elide the user's home in illustrative JSON;
  every interface is fully specified.
- **Consistency**: fleet-only routing (§3, §6, §11 J/K), one `<specialist>` per brief (§6, §7),
  serial shared-file work (§8, build.md), and stop-not-invent (§5, §10) agree across sections.
- **Scope**: this spec is the only file created; implementation touches the eight files in §4 and
  leaves fleet config, relays, and profiles alone.
- **Ambiguity resolved**: join key = exact case-sensitive name; brief path = `.md` first; exit codes
  fixed; user-named vs orchestrator-chosen missing profiles behave differently on purpose.
- **Requirement coverage**: every approved behavior maps to a mechanism and a test:

  | Behavior | Mechanism | Test |
  | --- | --- | --- |
  | Roster in both runtimes, twins joined | `audit` join by name | 1, 3, live audit |
  | Installed metadata, no hardcoded roster, no cache | scan per invocation | 1, 7 |
  | Deterministic candidate discovery only | `find --query` scoring | 5, 8 |
  | Orchestrator makes and explains choice | §5 steps 3, fit line | J, K |
  | One owner every task; Minimal Change Engineer for mechanical | §5 step 3, §7 | J |
  | Extra specialist only for distinct criterion | §7 | L |
  | Parallel writes only on disjoint files | §8 | K |
  | Shared file = read-only advice then one owner | §8 | L |
  | Fleet routing untouched, never 279 lanes | §3, §12 | J, K |
  | Brief/safety/ponytail override profile | §9 | J–L precedence check |
  | Missing/unreadable profile visible | §10, `find --name` exit 1 | 4, 6, M |
  | No justified match → stop | §5 step 5 | 8, N |
