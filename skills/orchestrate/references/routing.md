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
| 2+ independent tasks with no shared files | `dispatching-parallel-agents` (orchestrator-side) |
| parallel tasks that would collide in one working tree | `using-git-worktrees` (orchestrator-side) |
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
