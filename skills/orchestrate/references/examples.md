# Examples

Lane, implementer, and model values below are whatever `fleet.mjs` printed at the time; they change
whenever the fleet is reconfigured and are never authoritative.

## `/quick Fix the typo: formatPrice should prefix "$" for USD`

```text
Mode: quick (one function, one test, no other callers, no escalation trigger)
Task | Role→Lane   | Implementer | Model                          | Effort            | Skills                 | Depends | Verify
T1   | quick→small-edit | opencode | zai-coding-plan/glm-5.3-flash | low (brief-only)  | ponytail(ultra), tdd   | —       | npm test, npm run lint, diff = 2 files
Review: skipped (mechanical quick edit, no §4 trigger)
```

```bash
node "$HOME/.agents/skills/orchestrate/scripts/fleet.mjs" pick --need quick --write --cwd "$REPO"
node "$HOME/.agents/skills/opencode-delegate/scripts/relay.mjs" --brief brief.xml --lane small-edit --cd "$REPO"
npm test && npm run lint && git diff --stat
```

Report: result, 2 files changed, lane small-edit (opencode/glm-5.3-flash), effort low, ponytail,
`npm test` 3/3 pass, lint clean, review skipped (mechanical), no open risks.

## `/build Add an audit log: backend recorder, admin page renderer, docs`

```text
Mode: build
Contract fixed up front: recordEvent(type, orderId, detail); listAuditEvents() → [{id,type,orderId,detail,timestamp}]
Task | Role→Lane        | Implementer | Model                 | Effort | Skills                                     | Depends | Verify
T1   | feature→implementer | opencode | glm-5.3-flash         | medium | ponytail, tdd                              | —       | npm test
T2   | ui→ui-ux         | agy         | gemini-3.1-pro-high   | medium (brief-only) | ponytail, ui-ux-pro-max, frontend-design, tdd | contract | npm test, render check
T3   | docs→docs        | opencode    | mimo-v2.5-free        | low    | ponytail                                   | T1      | docs match listAuditEvents shape
R    | debate-review --local (review-main + review-debate)                                                | T1,T2,T3 | findings validated
Parallel: T1 ∥ T2 (disjoint files, contract-only dependency); T3 after T1 lands.
```

Findings → fix briefs with `receiving-code-review` through the producing lane → re-review affected
files → fresh `npm test` → report.

## Reconfigured fleet, same command

After `$delegate-setup` swaps the UI lane to another implementer or adds `"roles": ["tests"]` to a
lane, the next `/build` run resolves the new binding automatically; nothing in this skill changes.
