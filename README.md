# orchestrate

A Claude Code skill that runs software tasks through your **delegate fleet** at the highest
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
- `ponytail` (plugin), `ui-ux-pro-max`, `frontend-design`.
- The Superpowers plugin (`brainstorming`, `writing-plans`, `systematic-debugging`,
  `test-driven-development`, `verification-before-completion`, `receiving-code-review`, …).
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

What you get back: a per-task routing table (lane, implementer, model, effort, skills,
dependencies, verification) before the first dispatch, then a short report: result, changes,
lanes/models, effort per task, skills, verification commands with counts, review status, open risks.

## How routing works

`scripts/fleet.mjs` imports delegate-setup's own loader at run time, so the fleet is the single
source of truth. Reconfigure lanes with `$delegate-setup` and the next run uses them; nothing here
changes.

```bash
node scripts/fleet.mjs list --cwd <repo>                         # live lanes with roles and dials
node scripts/fleet.mjs pick --need ui --write --cwd <repo>       # ranked candidates for a role
node scripts/fleet.mjs effort --lane review-main --level medium  # relay flag, if the lane has a dial
```

Roles: `quick feature ui debug tests docs plan review`. A lane's declared `roles` wins; otherwise
the role is inferred from the lane name (`fix-bugs` → debug, `ui-ux` → ui, `small-edit` → quick).
Effort is chosen per delegated task (low / medium / high) and translated to `--effort` only where
the implementer exposes that dial. Every brief requires `ponytail`; UI work adds `ui-ux-pro-max`
and `frontend-design`; one exact Superpowers skill per observable trigger.

Details: `skills/orchestrate/references/routing.md`, `build.md`, `brief.md`, `examples.md`.

## Tests

- `tests/fleet.test.mjs`: script tests, including "reconfigure the fleet, rerun, new lane is used".
- `tests/scenarios.md` and `tests/results.md`: behavioral scenarios (tiny fix, UI feature, hard bug,
  parallel work, review findings, quick→build escalation, false success claim) with baseline vs
  with-skill results, following the Superpowers `writing-skills` RED→GREEN→REFACTOR method.

## Uninstall

```bash
rm -rf ~/.agents/skills/orchestrate ~/.claude/skills/orchestrate ~/.claude/commands/quick.md ~/.claude/commands/build.md
```

The delegate-setup patch is harmless to keep; lanes without `roles` behave exactly as before.

## License

MIT
