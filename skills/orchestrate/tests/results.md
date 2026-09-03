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
