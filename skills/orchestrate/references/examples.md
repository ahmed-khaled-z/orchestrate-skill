# Examples

Lane, implementer, model, and specialist values are whatever `fleet.mjs` and `specialists.mjs`
printed on this run. Copy those fields into the plan. The samples use `<from pick>` and
`<from find>` so a later run does not reuse an old model id.

Plans are four lines per task, the shape in [SKILL.md](../SKILL.md). Quick is one task.

## `/quick Fix the typo: formatPrice should prefix "$" for USD`

Provisional plan before any tool. Lane, implementer, model, and specialist are `pending lookup`.
Then lookup, then the resolved plan, then dispatch in the same turn.

```text
Mode: quick
- id: T1; outcome: formatPrice prefixes $ for USD; role: quick; lane: pending lookup; implementer: pending lookup; model: pending lookup
  effort: low; flag: pending lookup; specialist: pending lookup; stance: owner; fit: owns the mechanical one-function edit; feeds: none
  skills: ponytail ultra, test-driven-development; depends: none; verify: npm test and npm run lint, after the script chain is read; review: none: mechanical quick edit
  budget: timeout 15m, overall 30m, max-attempts 2
```

Resolved, after the commands, with the printed values substituted:

```text
Mode: quick
- id: T1; outcome: formatPrice prefixes $ for USD; role: quick; lane: <from pick>; implementer: <from pick>; model: <from pick>
  effort: low; flag: <from effort>; specialist: <from find>; stance: owner; fit: owns the mechanical one-function edit; feeds: none
  skills: ponytail ultra, test-driven-development; depends: none; verify: npm test and npm run lint, after the script chain is read; review: none: mechanical quick edit
  budget: timeout 15m, overall 30m, max-attempts 2
```

```bash
node "$HOME/.agents/skills/orchestrate/scripts/fleet.mjs" pick --need quick --write --cwd "$REPO"
node "$HOME/.agents/skills/orchestrate/scripts/fleet.mjs" effort --lane "$LANE" --level low --cwd "$REPO"
node "$HOME/.agents/skills/orchestrate/scripts/fleet.mjs" preflight --lane "$LANE" --level low --cwd "$REPO"
node "$HOME/.agents/skills/orchestrate/scripts/specialists.mjs" audit
node "$HOME/.agents/skills/orchestrate/scripts/specialists.mjs" find --query "copy format currency"
node "$HOME/.agents/skills/orchestrate/scripts/specialists.mjs" find --name "$SPECIALIST"
node "$HOME/.agents/skills/orchestrate/scripts/run-task.mjs" \
  --task-id T1 --state-dir "$STATE" --brief "$REPO/../T1-brief.xml" --lane "$LANE" \
  --cwd "$REPO" --scope src/formatPrice.js --scope test/formatPrice.test.js \
  --timeout 15m --overall 30m --max-attempts 2 --effort low
npm test && npm run lint
```

`$STATE` is a directory outside `$REPO`. `$LANE`, the implementer, and the model come from `pick`.
`--effort low` is present only when `effort` printed a non-null `flag`. When `flag` is null, omit
preflight `--level` and `run-task --effort`, and keep the level in the brief.

`--lane` on `run-task` selects the wrapper lane. The wrapper reads that relay's `--help` and builds
the relay argv. The Grok relay help (2026-10-05) lists `--brief`, `--cd`, `--model`, `--effort`,
`--max-turns`, `--read-only`, `--full-access`, `--resume-last`, `--session`, `--out-dir`. It does
not list `--lane`. For that relay the wrapper passes `--model` from the lane and omits `--lane`.
Do not assemble a `grok` command.

When the relay fails and `pick` returns another lane, show a delta before the next `run-task`.
Same task id. Same timeout, overall, and max-attempts. Substitute only the new lane, implementer,
model, and flag.

```text
Mode: quick
- id: T1; outcome: formatPrice prefixes $ for USD; role: quick; lane: <new pick>; implementer: <new pick>; model: <new pick>
  effort: low; flag: <from effort on the new lane>; specialist: <from find>; stance: owner; fit: owns the mechanical one-function edit; feeds: none
  skills: ponytail ultra, test-driven-development; depends: none; verify: npm test and npm run lint, after the script chain is read; review: none: mechanical quick edit
  budget: timeout 15m, overall 30m, max-attempts 2
```

Report: result, files changed, lane and model copied from `pick`, effort, specialist and fit,
skills, the check counts, review skipped (mechanical), open risks.

## `/build Add an audit log: backend recorder, admin page, docs`

T1 and T2 share no files. Each writable task still has its own worktree `--cwd`, or they run one
after another. T3 waits for T1. One review after they land.

```text
Mode: build
- id: T1; outcome: recordEvent and listAuditEvents match the fixed contract; role: feature; lane: <from pick>; implementer: <from pick>; model: <from pick>
  effort: medium; flag: <from effort>; specialist: <from find>; stance: owner; fit: owns the API contract criterion; feeds: none
  skills: ponytail, test-driven-development; depends: none; verify: npm test; review: debate-review after T1 T2 T3
  budget: timeout 30m, overall 90m, max-attempts 3
- id: T2; outcome: responsive audit table, empty state, mobile a11y; role: ui; lane: <from pick>; implementer: <from pick>; model: <from pick>
  effort: medium; flag: <from effort>; specialist: <from find>; stance: owner; fit: owns responsive table and a11y criterion; feeds: none
  skills: ponytail, ui-ux-pro-max, frontend-design, test-driven-development; depends: contract only; verify: npm test and a render check that does not deploy; review: debate-review after T1 T2 T3
  budget: timeout 30m, overall 90m, max-attempts 3
- id: T3; outcome: docs match listAuditEvents; role: docs; lane: <from pick>; implementer: <from pick>; model: <from pick>
  effort: low; flag: <from effort>; specialist: <from find>; stance: owner; fit: owns docs-match-code criterion; feeds: none
  skills: ponytail; depends: T1; verify: docs name the landed shape; review: debate-review after T1 T2 T3
  budget: timeout 20m, overall 40m, max-attempts 2
```

```bash
node "$HOME/.agents/skills/orchestrate/scripts/fleet.mjs" preflight --lane "$UI_LANE" --cwd "$REPO"
node "$HOME/.agents/skills/orchestrate/scripts/run-task.mjs" \
  --task-id T2 --state-dir "$STATE" --brief "$BRIEFS/T2.xml" --lane "$UI_LANE" \
  --cwd "$WT_UI" --scope src/audit-page.js \
  --timeout 30m --overall 90m --max-attempts 3
```

No `--effort` and no preflight `--level` when that lane's `flag` was null. `$WT_UI` is a worktree
root distinct from T1's `--cwd`. The specialist is usable only when `audit` does not list that name
under `drift` or `unavailable`. A name in `formattingOnly` (standalone dividers only) stays usable.
Real instruction drift still excludes it. Do not rewrite the roster.

Findings go to fix briefs with `receiving-code-review` on the same task id, then re-review the
affected files, then a fresh check, then the report.

## Reconfigured fleet, same command

After `$delegate-setup` swaps a lane or adds `"roles": ["tests"]` to a lane, the next run resolves
the new binding from `fleet.mjs`. Nothing in this skill changes. The plan shows the printed model
before dispatch.
