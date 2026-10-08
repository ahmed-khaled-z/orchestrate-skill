# orchestrate

A Codex and Claude Code skill that runs software tasks through your **delegate fleet** at the highest
practical quality in the shortest practical time. It classifies the task, reads the live lane map
from `delegate-setup`, picks the lane, effort, and skills each sub-task needs, dispatches
implementers in parallel where safe, verifies with fresh evidence, reviews with `debate-review`,
and fixes findings with `babysit-pr`. It never edits the repo itself.

Two entry points:

| Command | Use for | Behaviour |
| --- | --- | --- |
| `/quick <request>` (`$orchestrate quick …`) | small, reversible, low-risk changes | one lane, low/medium effort, minimal skills, targeted verification; auto-escalates to build when grounding finds risk |
| `/build <request>` (`$orchestrate build …`) | features, important bugs, refactors, multi-module work | planning if needed, task graph, parallel dispatch, TDD, `debate-review`, review-fix lifecycle, verification |

## Requirements

Installed as skills next to this one (`~/.agents/skills/`):

- [`delegate-setup`](https://github.com/amElnagdy/delegate-skills) plus at least one `*-delegate` relay
  (codex, opencode, claude, agy, grok, kimi …), with lanes configured via `$delegate-setup`.
- [`debate-review` and `babysit-pr`](https://github.com/amElnagdy/review-skills).
- `ponytail` (plugin), `caveman`, `ui-ux-pro-max`, `frontend-design`.
- The Superpowers plugin (`brainstorming`, `writing-plans`, `systematic-debugging`,
  `test-driven-development`, `verification-before-completion`, `receiving-code-review`, …).
- **Agency Agents** installed in both `~/.claude/agents/` and `~/.codex/agents/` — `scripts/specialists.mjs` scans both rosters, pairs profiles by exact name, and fails loud on mismatches. See [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents).
- Node 18+.

## Install

Option A — with the skills CLI, then run the installer for the commands and the small
delegate-setup patch:

```bash
npx skills add ahmed-khaled-z/orchestrate-skill
git clone https://github.com/ahmed-khaled-z/orchestrate-skill && orchestrate-skill/scripts/install.sh
```

Option B — clone only:

```bash
git clone https://github.com/ahmed-khaled-z/orchestrate-skill
cd orchestrate-skill && scripts/install.sh
```

`install.sh` copies the skill to `~/.agents/skills/orchestrate`, symlinks it into
`~/.claude/skills`, installs `/quick` and `/build` into `~/.claude/commands`, and applies
`scripts/patch-delegate-setup.mjs`: a backward-compatible change that lets a lane carry an optional
`"roles": ["ui"]` array (validated by `config.mjs`, stripped by `lane.mjs` before relays see it).
It also adds an agy-only boolean dial `skipPermissions`: headless `agy --print` cannot prompt and
auto-denies writes, so an agy lane with `"skipPermissions": true` makes the relay auto-approve tool
requests (treat those runs as full access). Set it with `$delegate-setup` or by editing
`~/.config/delegate-skills/config.json`. The patch is idempotent and fails loudly if your
delegate-setup version differs.

Verify:

```bash
node ~/.agents/skills/orchestrate/scripts/fleet.mjs list --cwd .
node --test ~/.agents/skills/orchestrate/tests/fleet.test.mjs
```

## Use

```text
/quick Rename the CSV export button to "Download CSV"
/build Add order cancellation with refund calculation, tests, and docs
```

Version **0.3.0** shows a compact plan in the user's language before any tools. Each task names
its lane, implementer, model, effort, specialist, skills, dependencies, checks, review, and execution
limits. Unknown routes stay `pending lookup`; the resolved plan appears before any delegate runs.
Plans use `caveman`, and work continues under the user's existing authorization.

Execution now uses fleet preflight, content snapshots, and a persistent task runner. Retry and
fallback attempts keep the same task id, elapsed budget, and attempt count. Task locks prevent
concurrent dispatch of the same task; other writers require isolated worktrees. Configured
read-only lanes stay read-only. Specialist discovery
supports domain synonyms, and the roster audit compares Claude and Codex profile instructions.
Verification checks script side effects before running them.

The final report covers result, changes, lanes/models, effort, skills, checks, review, and open risks.
See [dispatch guidance](skills/orchestrate/references/dispatch.md) for commands and recovery limits.

## How routing works

`scripts/fleet.mjs` imports delegate-setup's own loader at run time, so the fleet is the single
source of truth. Reconfigure lanes with `$delegate-setup` and the next run uses them; nothing here
changes.

```bash
node skills/orchestrate/scripts/fleet.mjs list --cwd <repo>                         # live lanes with roles and dials
node skills/orchestrate/scripts/fleet.mjs pick --need ui --write --cwd <repo>       # ranked candidates for a role
node skills/orchestrate/scripts/fleet.mjs effort --lane review-main --level medium  # relay flag, if the lane has a dial
```

Roles: `quick feature ui debug tests docs plan review`. A lane's declared `roles` wins; otherwise
the role is inferred from the lane name (`fix-bugs` → debug, `ui-ux` → ui, `small-edit` → quick).
Effort is chosen per delegated task (low / medium / high) and translated to `--effort` only where
the implementer exposes that dial. Every brief requires `ponytail`; UI work adds `ui-ux-pro-max`
and `frontend-design`; one exact Superpowers skill per observable trigger.

Details: `skills/orchestrate/references/routing.md`, `build.md`, `brief.md`, `examples.md`.

## Specialist routing

Every dispatched task gets exactly one **owner** specialist whose expertise covers the most
acceptance criteria. The orchestrator runs `scripts/specialists.mjs audit` once per run, then
`find --query "<domain terms>"` per task to rank candidates, picks the owner, and resolves the
absolute profile path with `find --name`. The brief's `<specialist>` element carries a one-line
`fit` tying the specialist to a named criterion.

**Optional read-only advisors** are added only when a distinct verifiable acceptance criterion
falls outside the owner's expertise (e.g., a security advisor for "no new auth bypass" alongside
a backend owner for "refund totals correct"). Advisors run first on a `review` or `plan`
read-only lane as appropriate, produce findings with empty `touchedFiles`, and the owner's brief
receives the attributed findings in its context.

**Missing profiles:**
- Orchestrator-chosen missing profile: reselected and reported.
- User-named missing profile: stops for input.
- No justified fit after broadening: stops.

No silent substitution in any case.

```bash
node skills/orchestrate/scripts/specialists.mjs audit                      # scan both rosters, exit 1 on any mismatch
node skills/orchestrate/scripts/specialists.mjs find --query "postgres schema"  # rank candidates by keyword overlap
node skills/orchestrate/scripts/specialists.mjs find --name "Backend Architect" # exact match → absolute profile path
```

Details: `skills/orchestrate/references/routing.md` §5.

## Tests

- `tests/fleet.test.mjs`: script tests, including "reconfigure the fleet, rerun, new lane is used".
- `tests/specialists.test.mjs`: specialist discovery tests — audit (twins, mismatches, duplicates,
  bad files), find (deterministic scoring, `--limit`, exact `--name`, no cache, CLAUDE_CONFIG_DIR/
  CODEX_HOME override).
- `tests/scenarios.md` and `tests/results.md`: behavioral scenarios (tiny fix, UI feature, hard bug,
  parallel work, review findings, quick→build escalation, false success claim) with baseline vs
  with-skill results, following the Superpowers `writing-skills` RED→GREEN→REFACTOR method.
- Specialist routing scenarios J–N in `scenarios.md`: owner fit lines, advisor separation,
  collision handling, missing-profile behavior, no-fit stop.

Run all runtime suites (fleet/preflight, snapshots, task runner, and specialist discovery/audit):

```bash
node --test ~/.agents/skills/orchestrate/tests/*.test.mjs
```

The 0.3.0 release passed 97 runtime tests and two final plan behavior samples. Historical test
results and limitations are recorded in `skills/orchestrate/tests/results.md`.

## Uninstall

```bash
rm -rf ~/.agents/skills/orchestrate ~/.claude/skills/orchestrate ~/.claude/commands/quick.md ~/.claude/commands/build.md
```

The delegate-setup patch is harmless to keep; lanes without `roles` behave exactly as before.

## License

MIT
