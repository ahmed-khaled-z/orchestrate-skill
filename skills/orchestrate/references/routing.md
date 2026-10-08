# Routing: lane, effort, skills

`scripts/fleet.mjs` reads the live `delegate-fleet.v1` map through delegate-setup's own loader. It
never stores lanes. Everything below maps *task properties* to *roles*; the fleet maps roles to
implementers and models today.

## 1. Lane by role

```bash
node "<skill-dir>/scripts/fleet.mjs" list --cwd <repo>                       # every live lane, roles, dials
node "<skill-dir>/scripts/fleet.mjs" pick --need <role> --write --cwd <repo>  # ranked writable candidates
node "<skill-dir>/scripts/fleet.mjs" pick --need review --read-only --cwd <repo>
```

| Task property | `--need` |
| --- | --- |
| mechanical or isolated edit, copy, config, one-file change | `quick` |
| feature, integration, refactor, state change, general implementation | `feature` |
| UI, UX, layout, responsive, components, design system, interaction, visual a11y | `ui` |
| bug with unknown or non-obvious cause, failing test/build, regression | `debug` |
| writing or extending tests as the main deliverable | `tests` |
| documentation as the main deliverable | `docs` |
| architecture, design spec, implementation plan (read-only) | `plan` |
| independent review or diagnosis (read-only) | `review` |

A lane's `roles` field (declared in the fleet via delegate-setup) wins; otherwise roles are inferred
from the lane name. `fallback: true` means no lane serves the role and a feature lane is offered;
say so in the plan. An empty candidate list is a stop: report it and suggest `$delegate-setup`.
Never route by a model name you remember; the `pick` output is the only source.

`untrustedProjectConfig: true` means the repo's `.delegate/config.json` is not approved; stop and
ask the user to review it with `$delegate-setup`.

## 2. Effort per task

Decide per delegated task, from: complexity, architectural impact, modules touched, uncertainty,
debugging difficulty, security, data/migration impact, concurrency, regression risk, reasoning depth.

| Level | Use for |
| --- | --- |
| **low** | obvious small change, isolated UI tweak, copy/text, one-file mechanical change, simple mapping, low-risk config, bug fix with known root cause |
| **medium** | normal feature, multi-file change, moderate refactor, API integration, state-management change, non-trivial tests, debugging that needs investigation, medium UI flow |
| **high** | architecture, security-sensitive change, difficult bug, race condition, migration, complicated state, cross-module change, major refactor, unfamiliar system, high regression risk, ambiguous requirements, deep reasoning |

Rule: if any **high** trigger holds for a task, the task is high, even when the expected diff is
five lines. Small diff size never lowers effort below what its riskiest trigger demands; a known root
cause with no high trigger is what makes a fix low.

Then translate: `node fleet.mjs effort --lane <lane> --level <level>` returns the relay flag when the
lane's implementer exposes a matching dial (`--effort low|medium|high`) and `flag: null` when it does
not (variant-based or dial-less implementers keep their configured lane dial). Either way the level
goes into the brief's `route effort=` and its wording.

Pass that same `--level` to `fleet.mjs preflight` only when `flag` is non-null. When `flag` is
null, a preflight that still receives `--level` sets `checks.effort` to `ready`, `flag: null`,
`briefOnly: true`. That does not block. Omit `--effort` on `run-task.mjs`. The level still goes in
the brief. See [dispatch.md](dispatch.md).

## 3. Skills per task

Always: `ponytail` (`full`; `ultra` only for a mechanical quick edit).

| Trigger (observable) | Add exactly |
| --- | --- |
| UI/UX/visual/interaction/responsive/design-system work | `ui-ux-pro-max` **and** `frontend-design` |
| new or ambiguous feature; solution not yet shaped | `brainstorming` (orchestrator runs it with the user, before any dispatch) |
| approved design with several implementation steps | `writing-plans` (plan lane, read-only) |
| bug, failing test/build, unknown root cause | `systematic-debugging` (read-only diagnosis brief first) |
| behavior change and a usable test harness exists | `test-driven-development` |
| applying accepted review findings | `receiving-code-review` |
| 2+ writable tasks with disjoint scopes, each in its own worktree | `dispatching-parallel-agents` (orchestrator-side) |
| writable tasks that would share one working tree | `using-git-worktrees`, or run them one after another |
| about to claim done/fixed/passing | `verification-before-completion` (orchestrator-side, every run) |
| work complete, deciding merge/PR/branch | `finishing-a-development-branch` only if the user asked for that lifecycle |

Not used inside delegates: `dispatching-parallel-agents`, `subagent-driven-development`,
`executing-plans` (this skill owns orchestration), `requesting-code-review` (review is
`debate-review`). Delegates never spawn agents.

Copy-only text edits and non-visual behavior changes that happen to live in UI files do **not**
trigger the UI pair. Pure backend, domain, infra, and data work never gets UI skills.

## 4. Review by trigger

Run `debate-review` (local mode when no PR exists) when any holds: build mode; medium or high
effort on any task; shared contract or public API; security, auth, payments, sensitive data;
state, concurrency, data, or schema change; performance risk; unfamiliar integration; non-trivial UI
interaction; scope grew during work. A mechanical quick edit with passing targeted checks skips
review and the report says so.

## 5. Specialists

### Selection

Once per run, before the first `find`: `node specialists.mjs audit`. Carry any non-empty list into
the plan; profiles on problem lists are unavailable.

Per dispatched task, after lane and effort are fixed:

1. List the task's acceptance criteria.
2. `find --query "<domain terms>"` (English or Arabic, e.g. "postgres migration schema" or "مصادقة").
   The script normalizes a fixed synonym and Arabic alias table and returns `normalized` plus
   `candidates[].evidence` (`token`, `field` of `name` or `description`, `via` of `exact`,
   `synonym`, or `alias`). Score orders. It never selects. Quote the chosen candidate's evidence
   in the plan. Do not add synonyms of your own.
3. **Choose the owner.** Read descriptions; pick the profile covering the most criteria, and only
   a profile that is not on `duplicates`, `drift`, `unavailable`, or `problems`. Write the fit as
   one line naming the criterion. For mechanical edits (quick role, ponytail ultra), start from
   Minimal Change Engineer and keep it unless a domain profile fits better.
4. **Broaden once.** No fit → rerun `find --query` with broader terms, `--limit 25`.
5. **Stop.** Still no justified fit → stop before dispatch. Report the task, both queries, closest
   rejected candidates with one-line reasons. Never invent a specialist, never dispatch without an
   owner, never pick a poor fit, never silently fall through to the next name.
6. **Resolve.** `find --name "<chosen>"` → exits 0 with the `profile` path for the brief. Exit 1
   follows Missing profiles (§5 Missing or unreadable profiles). `--name` is exact. A duplicate or
   drift hit exits 1 with a stop note. Do not substitute.
7. **Advisors.** Add one only when it owns a distinct verifiable acceptance criterion outside the
   owner's expertise. Resolve each the same way.

`audit` pairs twins by exact name. `coverage` is `checked` or `not-checked` for `identity`,
`description`, and `instructions`. If `instructions` is `not-checked`, say that. Do not claim the
instruction bodies match. `drift[]` is `{name, description, instructions, claude, codex}` when the
description differs or both instruction bodies exist and differ after newline and trim
normalization. `unavailable[]` is `{name, reason}` when one twin's instructions are missing.
`find` itself drops duplicates and drift. It does **not** drop `unavailable`. You drop those names.

Standalone Markdown horizontal rules (`---`, `***`, `___`) are removed before instruction
comparison. When that is the only difference, the name is listed in `formattingOnly` and stays
selectable. A remaining instruction or description difference is `drift`, and `find` excludes it.
`find` drops duplicates and drift. It does not drop `unavailable`. You drop those names.
`coverage.instructions: not-checked` means both instruction bodies were not present. Do not call
that a match. Do not edit or rewrite the roster.

A specialist the user named explicitly skips steps 2–5 and goes straight to step 6.

### One owner, minimal advisors

- **One owner per dispatched task, always.** The owner is the only specialist whose persona the
  writable delegate adopts.
- **Second specialist only for a distinct verifiable outcome.** It must own at least one acceptance
  criterion the owner's expertise does not cover (e.g. "no new auth bypass" alongside "refund
  totals correct"). An advisor that cannot name its criterion is dropped. Wanting a second opinion
  is what `debate-review` is for.
- **Genuinely separate surfaces become separate tasks,** each with its own owner (backend owner, UI
  owner, docs owner), following build.md decomposition.

### Collision handling

- Writable tasks that share one working tree run one after another, even when their `<scope>` sets
  are disjoint. Parallel writable work uses `using-git-worktrees` and a distinct `run-task --cwd`
  per task. See [dispatch.md](dispatch.md). Each writable task has its own owner.
- Overlapping scope is serial. When two specialists' criteria land in the same files, the
  collaboration is always: advisors run first as read-only tasks (lane from `fleet.mjs pick --need
  review --read-only`, or `plan` for design advice), `changes` empty and `readOnlyViolation` false; then exactly
  one writable owner task applies the synthesized findings.
- Advisors on the same owner may run in parallel with each other; they write nothing.
- Conflicting advice is resolved by the orchestrator before the owner dispatch and the decision is
  written into the owner's `<context>`. Unresolvable conflict → ask the user.
- An advisor that fails follows SKILL.md Fallback (retry once, next read-only candidate). Still no
  findings → stop and report; the owner is not dispatched with that criterion unexamined.

### Precedence

Inside a delegate, highest first:

1. The user's explicit instructions and repository `CLAUDE.md` / `AGENTS.md`.
2. `<action_safety>` (no commits, no pushes, no spawned agents, no scope growth).
3. The brief: `<scope>`, `<leave_untouched>`, `<requirements>`, `<acceptance_criteria>`, `<report_contract>`.
4. `<required_skills>`, including `ponytail`.
5. The specialist profile: domain judgment only.

The brief states this in one sentence. Profile instructions that conflict (spawn agents, run pipelines,
produce extra deliverables, require eval suites, change the report format) yield to items 1–4.

### Missing or unreadable profiles

| Situation | Behavior |
| --- | --- |
| `audit` not ok at run start | Report `problems`, `drift`, `unavailable`, and `coverage` in the plan. Those names are not selectable. Continue only with a justified fit outside those lists. |
| Orchestrator-chosen profile missing, drifted, or duplicate at resolve (`find --name` exit 1) | Say so in the plan. A different owner is a new selection plus a plan delta before dispatch, with the reason. No silent swap. |
| User-named profile missing or excluded | Stop and ask. No substitute. |
| Delegate cannot read `profile` | Delegate stops and reports; orchestrator treats it as the missing-profile row above. |
| No justified fit after broadening | Stop and report (step 5). |
| One runtime root missing | `audit` not ok; `find` still returns profiles from the other root with a `null` twin path. Do not claim the missing twin matched. |

Every row is visible in the plan or the report. No silent substitution. No roster rewrite.
