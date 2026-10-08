# Results (2026-09-03, sonnet subagents, dry-run relays)

| # | Baseline (no skill) | With skill |
| --- | --- | --- |
| A | lane ok; "I'd just edit it myself"; no review decision | quick, `small-edit` via fleet.mjs, low effort in brief, ponytail ultra + tdd, review skipped and stated ✔ |
| C | lane + UI skills ok; no effort; no review/test decision | `ui-ux` lane, ponytail + ui-ux-pro-max + frontend-design + tdd, effort medium stated, debate-review ✔ |
| D | not run | grounding found root causes; `fix-bugs` lane, systematic-debugging + tdd, debate-review ✔ |
| E | not run | contract fixed first; T1 backend, T2 UI ∥ T3 docs, distinct lanes per role, one review ✔ |
| F | lane + babysit-pr ok; high effort for XS fix; no receiving-code-review | fix lifecycle only (no re-brainstorm), `fix-bugs`, low effort, receiving-code-review, babysit-pr round ✔ |
| G | — | `tests/fleet.test.mjs` "Scenario G": swapped UI lane + new roles-tagged tests lane picked up with no skill edits ✔ |
| H | stayed quick, no escalation stated, single-model review | "Escalating to build" announced, debate-review, tdd ✔; effort medium ✗ → routing.md "any high trigger = high" rule added; re-run H2: effort high, escalation announced, debate-review ✔ |
| I | compliant | re-ran `npm test`, refused completion, re-dispatched with evidence ✔ |

Scenario B (medium feature) is covered by E's T1 path and C's build path; not run separately.

## Live audit (2026-09-26)

```bash
node scripts/specialists.mjs audit
```
Result: `{"roots":{"claude":"<claude agents dir>","codex":"<codex agents dir>"},"counts":{"claude":279,"codex":279,"paired":279},"claudeOnly":[],"codexOnly":[],"duplicates":[],"problems":[],"ok":true}`

Exit code: 0. All 279 profiles paired, no issues.

## Specialist routing scenarios — PENDING

| # | Scenario | Status |
| --- | --- | --- |
| J | Scenario A (USD typo) — Owner Minimal Change Engineer with fit line and path; no advisors; fleet cells unchanged | pending (script implemented, dry run not yet executed) |
| K | Scenario E (audit log) — Three owners via `find` with fit lines; T1 and T2 together only in distinct worktree roots, otherwise serial; docs after T1; one `<specialist>` per brief | pending (script implemented, dry run not yet executed) |
| L | "Add refund endpoint; must not weaken auth" — Read-only security advisor first, `touchedFiles` empty; one owner with attributed findings | pending (script implemented, dry run not yet executed) |
| M | Brief names missing profile; user names missing profile | pending (script implemented, dry run not yet executed) |
| N | Fake roster with no fitting profile — Two `find` queries shown, stop before dispatch, rejects listed with reasons | pending (script implemented, dry run not yet executed) |

Precedence and fleet separation checks in J–L: to be validated when dry runs execute.

## Plan contract (2026-10-05) — guidance samples, not CLI passes

Model and effort for both rounds: `gpt-6.1-sol`, medium. No relay was executed.

RED, before the plan contract. Five independent fresh-context samples.
`completePlanBeforeTools: 0/5`. Evidence: `baseline-plan.json` in the orchestrate-upgrade temp dir
(purchase copy, login failure, payment continuation, favorites feature, slow query). Each sample
called a tool before a complete task plan.

GREEN, after the plan contract. Five independent fresh-context samples, same model and effort.
`5/5` wrote a provisional plan containing the required fields before the intended discovery or
action, invented no model, lane, or specialist, and continued in the same turn without asking for
a new approval. These five samples support scenarios O, P, Q, and R.

Two of the style samples still announced the writing style. The four-line template in `SKILL.md`
is the clarification for that. This file does not claim those two samples were retested after the
template change. It also does not claim a caveman-style retest. The 2026-10-08 wording requires
the installed caveman skill; no new sample evidence is attached. The `5/5` field result above stays
the plan evidence.

Separate dry run, one fresh-context native agent, three scenarios, still no relay:

- Initial urgency: unknown route left as `pending lookup` (scenario O).
- Fallback delta: kept task id T1 and the time and attempt budget, and showed the changed Grok route (scenario S).
- Unsafe `npm run build`: chose `npx next build`. Live migration compatibility left unverified (scenario W).

## Runtime regressions T, U, V — `node --test`, not behavior runs

F1's first result was a partial timeout. `F1-continue-root-check.log` supersedes it: 72 pass, 0 fail.
`F2-root-check.log` is the later full suite, run by root: 87 pass, 0 fail
(`/var/folders/q6/g6r8fv_54kv94c2fgdxqfbgh0000gn/T/orchestrate-upgrade-38e1namg/F2-root-check.log`).

| # | What the suite shows | Tests |
| --- | --- | --- |
| T | An unchanged dirty file is not a change. A new edit on a read-only run sets `readOnlyViolation`. | `an unchanged dirty file is allowed for a read-only comparison`; `a dirty file edited again is a modify while git status stays the same`; `read-only allows an unchanged dirty file and rejects a new edit` |
| U | Timeout keeps the partial edit and blocks the next attempt until `--inspected`. Detached grandchildren are killed when `ps` can list them. A null `childPid` reservation stays blocked with `--inspected`. | `timeout kills relay descendants, keeps partial edits, and blocks retry until inspected`; `timeout kills a detached relay grandchild before the result`; `cancellation kills a detached relay grandchild before the result`; `a null childPid reservation stays blocked when inspected` |
| V | Drift is excluded from `find`. Missing instructions are `unavailable` and are not claimed as an instruction match (`coverage.instructions: not-checked`). Standalone dividers are `formattingOnly`, not drift. `find` still does not drop `unavailable`; the orchestrator does. | `instruction drift is reported and excluded from find`; `description drift is excluded`; `missing instructions are unavailable and are not claimed to match`; `standalone Markdown dividers are formatting-only, not drift`; `real instruction drift is still reported when dividers are present` |

## Live wrapper, task `F2-boundary-regressions` (not a behavior run)

Same state file. `attemptLimit` 2, `timeoutMs` 1200000, `overallMs` 2400000 on both attempts.

- Attempt 1, `F2-wrapper-output.json`: lane `fix-bugs`, implementer Kimi. Relay result status `failed`, exit 1, stderr `provider.auth_error: 403` usage-limit quota. `changes` empty. `attemptsUsed` 1. `verification` `"not-run"`. `sessionId` null.
- Attempt 2, `F2-fallback-output.json`: same task id, lane `implementer`, implementer Grok, `attemptsUsed` 2, same `overallMs`. `ok` true. Owned script and test edits only. `verification` `"not-run"`. Relay `result.json` status `completed`.

## CLI help and frontmatter (2026-10-05)

`--help` on `fleet.mjs`, `snapshot.mjs`, `specialists.mjs`, and `run-task.mjs` matches
[references/dispatch.md](../references/dispatch.md) and the commands in
[references/examples.md](../references/examples.md). Grok relay `--help` lists no `--lane`. This
check does not execute a relay and is not a behavior GREEN.

Official Python `quick_validate` was not run: PyYAML is absent, including in the bundled runtime.
Ruby `YAML.safe_load` parsed `SKILL.md` frontmatter (`name`, `description`, `license`,
`compatibility`, `metadata`). `name` and `description` are present. `compatibility` stays; it is
real metadata. Local Markdown links in this skill were checked the same day. No packages were installed.

## Limits still current

- D1 stale task-lock recovery now has an atomic `mkdirSync` guard (delegate suite GREEN, below). A stale or unknown guard is a hard stop with no auto-recovery. Root reran the suite at 97/97 and R3 confirmed guard correctness (both recorded below); the one agreed nonblocking R3 finding was the guard-block diagnostic wording, repaired in the same attempt as this edit.
- If `ps` cannot run, descendant cleanup can miss a detached grandchild. Confirm that tree is gone before retry.
- A running reservation with a null `childPid` is a hard stop, including with `--inspected`.
- `verification` stays `"not-run"`. `find` does not filter `unavailable`. A shared working tree is not exclusive attribution.

The old current-limit claim that `workspace/..metadata/snapshot.json` was accepted (`F1-extra-findings.txt` item 8) is superseded by the 2026-10-08 suite. It stays historical only.

## Root suite (2026-10-08)

Root ran `node --test` after the F3 wrapper stopped. Log: `/var/folders/q6/g6r8fv_54kv94c2fgdxqfbgh0000gn/T/orchestrate-upgrade-38e1namg/F3-root-check.log`.

`tests` 97, `pass` 96, `fail` 1, `cancelled` 0, `skipped` 0, `todo` 0, `duration_ms` 35225.732666.

Fail: `a held recovery guard blocks acquisition and keeps the dead lock in place` (`tests/run-task.test.mjs:942`). `AssertionError`, `0 !== 1`. The dumped result has `dispatched: true` and `ok: true`. D1 is not repaired. Passing neighbors in the same log (`a well-formed dead lock owner can be recovered`, `concurrent recovery of a dead lock admits exactly one writer`) do not close it.

`F3-fallback-output.json` for task `F3-review-corrections`: `attemptsUsed` 2, `attemptsRemaining` 0, `timedOut` true, `needsInspection` true, `ok` false, `spentMs` 1200000, `overallMs` 1200000, `verification` `"not-run"`. Recorded `changes`: `orchestrate/tests/run-task.test.mjs` only. This is not a clean debate-review re-review.

Accepted findings the suite shows as repaired:

- Containment. A workspace child named `..metadata` is refused before it is created. A state dir named `..state` inside the workspace is refused before any write. Metadata through a symlink is rejected before any workspace directory is created. A sibling `..metadata` and a sibling `..state` stay outside.
- Effective read-only. A configured read-only lane restricts the relay when `--read-only` is omitted, and that flag is forwarded on a lane-less relay. A read-only lane blocks when the relay cannot accept `--read-only`. Omitting the flag on a writable lane does not restrict the relay.

Unresolved after that run: missing `ps` can leave a detached grandchild; a null `childPid` reservation stays a hard stop. Do not treat this log as a finished review.

## Delegate lock repair (2026-10-08, task `F3-review-corrections`)

Root granted one bounded internal estimate extension on the same F3 state; spent time and the two prior attempts were retained (no budget reset).

The delegate wrapped the whole `acquireLock` acquisition/recovery loop in `scripts/run-task.mjs` in one exclusive `mkdirSync(`${path}.guard`)` guard. `EEXIST` returns not-acquired before the task lock is touched; the guard is released only by the invocation that created it (`finally` + `rmdirSync`); there is no guard auto-recovery. Task-lock semantics, dead-pid recovery, temp cleanup, reservation, and budgets are unchanged.

Delegate run from `/Users/ahmedkhaled/.agents/skills/orchestrate`: `node --test tests/*.test.mjs` → `tests` 97, `pass` 97, `fail` 0 (`duration_ms` 33069.637958), and `node --check scripts/run-task.mjs` clean. At that delegate handoff, root had not yet re-run the suite and no clean final re-review had been done, so D1 was repaired in source but not root-confirmed at that snapshot; the 96/97 RED above was superseded for the guard regression only by that delegate run. Root confirmation arrived later the same day (below).

## Root rerun, plan samples, and R3 review (2026-10-08)

Root reran the suite independently after the delegate guard repair: `tests` 97, `pass` 97, `fail` 0, `duration_ms` 36327.063542. Log: `/var/folders/q6/g6r8fv_54kv94c2fgdxqfbgh0000gn/T/orchestrate-upgrade-38e1namg/F3-guard-root-check.log`. This root run supersedes the 96/97 RED above; that RED stays as historical evidence.

Two independent fresh-context plan samples (`gpt-6.1-sol`, medium) passed. Evidence: `/var/folders/q6/g6r8fv_54kv94c2fgdxqfbgh0000gn/T/orchestrate-upgrade-38e1namg/final-behavior-check.json`.

R3 (`/var/folders/q6/g6r8fv_54kv94c2fgdxqfbgh0000gn/T/orchestrate-upgrade-38e1namg/review-guard/run.json`): both reviewers confirmed guard correctness, no blocking findings, and one agreed nonblocking finding — the guard-block diagnostic read "a writer for this task is still running" without evidence that a writer is actually alive.

That diagnostic finding was repaired in this attempt: `acquireLock` now also returns the guard path on `EEXIST`; for the guard case `dispatch` reports `recovery guard <path> is present; acquisition may be active or left by a crash` instead of claiming a live writer; the live/unknown task-lock error is unchanged. The existing held-recovery-guard test was strengthened to assert the guard-specific diagnostic, the guard path, the crash wording, and the retained dead lock (it failed RED against the old message before the fix). `references/dispatch.md` gained one sentence documenting that diagnostic; the hard stop and manual-confirmation rule is unchanged.

Delegate verification of this repair (a delegate run, not a root run): `node --test tests/*.test.mjs` → `tests` 97, `pass` 97, `fail` 0 (`duration_ms` 35906.769458); `node --check scripts/run-task.mjs` clean. The final root re-review of this small delta had not run at this snapshot; the final root report carries the latest review status.
