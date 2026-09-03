# Delegation brief (the contract every dispatch uses)

Read this immediately before writing a brief. The delegate sees only this text plus the working
tree. Fill every slot; a missing slot is a missing requirement, not brevity. Keep it under ~600
words; split anything bigger into separate tasks. Do not paste repository files the delegate can
read itself — name them.

```xml
<task id="T2-orders-ui">
  <route lane="ui-ux" implementer="agy" model="<from fleet>" effort="medium" mode="quick|build" />

  <required_skills>
    Load each skill below BEFORE acting and state in your report which you applied.
    <skill name="ponytail" argument="full" />            <!-- always; "ultra" only for mechanical quick edits -->
    <skill name="ui-ux-pro-max" />                        <!-- UI/UX/visual work only -->
    <skill name="frontend-design" />                      <!-- UI/UX/visual work only -->
    <skill name="test-driven-development" />              <!-- behavior change with a test harness -->
    <!-- one exact Superpowers skill per trigger; never "use superpowers" -->
    If a skill is not registered in your environment, read it from: <absolute SKILL.md path>
  </required_skills>

  <goal>One observable outcome in one or two sentences.</goal>

  <context>
    Repository facts the orchestrator already established: conventions (CLAUDE.md/AGENTS.md rules
    that bind this task), the modules involved, the existing pattern to follow, results of
    prerequisite tasks this one depends on. Facts only, no repository dumps.
  </context>

  <scope>Files or surfaces you may change.</scope>
  <leave_untouched>Files, behaviors, and decisions you must not change.</leave_untouched>

  <requirements>Deterministic behavior, edge cases, constraints, approved design decisions.</requirements>

  <acceptance_criteria>
    - Observable pass conditions, one per line.
    - What must remain unchanged.
  </acceptance_criteria>

  <verification_loop>
    Run these before finishing and fix what they surface within scope:
      <repo's real test command>   <repo's real lint/typecheck/build command>
    Confirm the working tree shows only intended changes.
  </verification_loop>

  <action_safety>
    No unrelated refactors. No new dependencies unless listed above. Do NOT git add/commit/push,
    deploy, or spawn other agents. Stop and report if a requirement contradicts the code or a
    prerequisite is missing; do not guess or widen scope.
  </action_safety>

  <report_contract>
    End with at most eight bullets: files changed, behavior, skills applied, exact commands run with
    pass/fail counts, deviations, open questions.
  </report_contract>
</task>
```

## Rules of the contract

- **Effort is per task.** Pick it with the table in `routing.md`; a large feature has low, medium,
  and high tasks. Put the chosen level in `route effort=` even when the relay has no dial: the brief
  then carries the depth expectation in words ("straightforward mechanical change" vs "reason
  carefully about concurrency; write the failing test first").
- **Ponytail is never optional.** Ponytail minimizes code, not understanding, validation, security,
  error handling, or accessibility. Say so in the brief when the task touches those.
- **Skills are named, minimal, and exact.** A backend bug gets `ponytail` and, if the cause is
  unknown, `systematic-debugging`; it does not get UI skills or planning skills.
- **Read-only tasks** (diagnosis, planning, review) use the relay's read-only mode and say
  "produce findings, touch no files"; verify `touchedFiles` is empty afterwards.
- **Unknown root cause = two briefs**: a read-only `systematic-debugging` diagnosis first, then a
  writable fix brief citing the evidence. Never one speculative "find and fix" brief.
- **Dependencies are inputs, not instructions.** Paste the concrete result of a prerequisite task
  (the API shape, the function signature, the file it landed in), not "see task 1".
