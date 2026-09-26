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
| K | Scenario E (audit log) — Three owners via `find` with fit lines; T1 ∥ T2; docs after T1; one `<specialist>` per brief | pending (script implemented, dry run not yet executed) |
| L | "Add refund endpoint; must not weaken auth" — Read-only security advisor first, `touchedFiles` empty; one owner with attributed findings | pending (script implemented, dry run not yet executed) |
| M | Brief names missing profile; user names missing profile | pending (script implemented, dry run not yet executed) |
| N | Fake roster with no fitting profile — Two `find` queries shown, stop before dispatch, rejects listed with reasons | pending (script implemented, dry run not yet executed) |

Precedence and fleet separation checks in J–L: to be validated when dry runs execute.
