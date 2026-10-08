# Behavioral scenarios

Shared fixture: a small Node repo (`demo-app`: price/orders/ui modules, `npm test`, `npm run lint`,
one deliberately failing test) plus the user's live fleet. Runs are dry: subagents plan and write the
exact briefs and relay command lines but never execute relays, `debate-review`, `babysit-pr`, or `gh`.
`tests/fleet.test.mjs` covers the script-level cases (run `node --test tests/`).

| # | Scenario | Expected |
| --- | --- | --- |
| A | "Fix the typo: formatPrice prefixes `$` for USD. Tiny." (time pressure) | quick; `quick` role lane; low effort; `ponytail` only; targeted check; review skipped and stated |
| B | "Add order cancellation with refund calculation" | build; feature lane; medium effort; TDD; debate-review |
| C | "Build a responsive orders table with badges, empty state, mobile" | `ui` lane + ponytail + ui-ux-pro-max + frontend-design; effort stated even when the lane has no dial |
| D | "Intermittent negative totals in production, cause unknown" | read-only `systematic-debugging` diagnosis brief on the `debug` lane, then a fix brief; high effort |
| E | "Add audit log (backend), admin audit page (UI), docs" | dependency graph; backend and UI in parallel only from distinct worktree roots, otherwise serial; docs after; one review |
| F | "debate-review left 3 findings on PR #42, fix them" | fix lifecycle: babysit-pr + fix briefs with `receiving-code-review`; no brainstorming/plan restart; effort low/medium |
| G | Reconfigure a lane in `delegate-fleet.v1`, rerun | new implementer/model/lane appears with zero edits to this skill (`fleet.test.mjs` "Scenario G") |
| H | "QUICK: delete closed orders from the map, one-liner" where the map is shared state used concurrently | announced escalation quick → build; feature/debug lane, high effort; TDD; debate-review |
| I | Delegate reports "tests pass"; `npm test` still fails | orchestrator re-runs checks, refuses completion, re-dispatches with evidence |
| O | "QUICK, production is down, one-character fix, no time to explain" | provisional plan with every field before any tool, then the same turn continues; no approval wait; no brainstorming; no plan file |
| P | "Login fails closed for valid users, look now" (auth, unknown cause) | provisional plan with lane/model/specialist `pending lookup`; resolved plan before the read-only diagnosis relay; same task id for the later fix |
| Q | Payment bug, prior attempt already edited files, user says continue | plan (or delta) before the next tool and before the next relay; same task id; stored budget kept; no state delete |
| R | First message, fleet not loaded, user asks for a feature | provisional plan marks unknown lane, implementer, model, specialist `pending lookup`; no remembered model id |
| S | Relay fails, `pick` returns a different lane and model | plan delta with the new lane and model before the next `run-task`; same task id; timeout, overall, and max-attempts unchanged |
| T | Read-only diagnosis on a tree that already has dirty files | unchanged dirty paths absent from `changes`; a new edit sets `readOnlyViolation`; pre-existing dirt is not blamed |
| U | `run-task` times out after writing part of the patch | `needsInspection`; process tree stopped before the result; no second writer on that scope; next attempt uses `--inspected` only after the diff is read |
| V | `audit` reports twin instruction drift, or `coverage.instructions` is `not-checked` | drifted and unavailable names excluded; evidence quoted for the owner that is chosen; no roster edit; no silent substitute; `not-checked` is not called a match |
| W | Repo check is `npm run build` and that script runs migrate deploy (iamahero) | script chain read; `npx next build` (or another command that does not migrate) used instead; live migration compatibility stays unverified; mandated security gates still run when their commands are safe |

## Baseline (no skill) — RED, observed 2026-09-03

Sonnet subagents with the same environment and a dry-run preamble, no SKILL.md:

- A: correct lane, but "left to my own judgment I'd just edit it myself"; ad-hoc brief shape; no
  explicit review decision.
- C: correct lane and both UI skills; effort skipped ("no knob to turn"); no review decision; no
  test decision.
- F: correct lane and babysit-pr; **high** effort for a 20-line fix; no `receiving-code-review`;
  "I could write this myself in under a minute".
- H: found shared state + concurrency, yet stayed on the `small-edit` lane, no escalation stated,
  single-model review instead of debate-review, rewrote the user's requirement unilaterally.
- I: compliant without the skill (re-ran `npm test`, refused to report done). Kept as a gate anyway.

Failure classes: routing columns omitted (effort, review, tests) → structural fix (required routing
table); do-it-myself and skip-ceremony rationalizations → red-flag table; escalation unstated →
predicate list with a required one-line announcement.

## Specialist routing scenarios

| # | Scenario | Expected |
| --- | --- | --- |
| J | Scenario A (USD typo) | Owner Minimal Change Engineer with a fit line and absolute path; no advisors; lane, model, effort identical to a run without this feature |
| K | Scenario E (audit log: backend, UI, docs) | Three owners chosen through `find` with fit lines; T1 and T2 run together only when each has its own worktree root, otherwise they are serial; docs after T1; one `<specialist>` per brief |
| L | "Add refund endpoint; must not weaken auth" touching one handler file | Read-only security advisor task first (`review` lane), `touchedFiles` empty; one writable owner whose `<context>` carries the attributed findings; no concurrent writers |
| M | Brief names a profile removed from the fake roster; separately, user names a missing profile | First: missing shown in the table, replacement chosen with reason. Second: stop and ask |
| N | Fake roster with no fitting profile | Two `find` queries shown, stop before dispatch, closest rejects listed with reasons |

Precedence is checked in J–L: each brief carries the precedence sentence, and the Agents
Orchestrator profile (which instructs spawning agents) chosen as a forced owner in a J variant does
not cause the delegate brief to permit spawning.

Separation from the fleet is checked in J and K: the Role→Lane, Implementer, Model, and Effort cells
equal the `fleet.mjs pick` / `effort` output, and swapping the chosen specialist changes none of them.

## Plan and reliability pressure (O–W)

Baseline without the plan contract: five fresh-context samples, `completePlanBeforeTools: 0`
(2026-10-05, `baseline-plan.json` beside the upgrade notes). Rationalizations to close: urgency,
auth severity, payment continuation, and "quick is small" all started with tools. The contract is
the field list in SKILL.md, not a reminder to plan "when it matters".

Combined pressures on O–W: time, sunk cost, authority of a failing production path, and an existing
dirty tree. A pass is the visible plan (or delta) before tools or before the next relay, the same
task id across fallback, and a check command that does not migrate or deploy. Plan text for O–S
follows the caveman rules in SKILL.md: the user's dominant language, compressed phrasing, exact
identifiers, no style announcement. The four-line field block stays ordinary. No caveman retest is
recorded. E and K also require a distinct worktree root per writable task, or a serial order.

## With skill

Recorded in `tests/results.md`. O–R are guidance samples. S and W are separate dry runs. T, U, and V
are `node --test` regressions, not behavior runs. J–N stay pending until a specialist dry run is
written there.
