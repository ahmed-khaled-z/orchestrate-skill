# Build mode: task graph, parallelism, review lifecycle

## Shape the work

1. **Unclear or creative requirements** → run `brainstorming` yourself with the user before any
   dispatch. Bounded outcome → straight to task briefs. Architectural outcome → a read-only `plan`
   lane writes the plan with `writing-plans`; for high-effort architecture, run a second read-only
   plan lane as challenger (`fleet.mjs pick --need plan --read-only`, distinct implementers) and
   dispose of objections yourself. Disclose when only one plan lane exists.
2. **Decompose** into tasks that each have one owner, one surface, one acceptance criterion set.
   Typical graph:

   ```text
   architecture/plan
        ↓
   backend/API  ───  UI            (parallel: different files)
        ↓             ↓
          tests / docs             (after the surfaces they cover land)
                ↓
          debate-review → fix → re-review (affected areas) → verify
   ```

3. **Parallelize** only tasks that share no files, need no unfinished output, and make no competing
   architectural decision. Use `dispatching-parallel-agents` discipline: each brief self-contained,
   results collected and read individually. If parallel tasks would collide in one working tree,
   isolate with `using-git-worktrees` (relay `--cd` per worktree) and merge in dependency order.
   When you fix an interface contract up front (function signature, event shape, endpoint), tasks
   that depend only on that contract run in parallel with its implementation; only tasks that need
   the landed code wait. Optimize the critical path, not the agent count: a serial chain of two well-briefed tasks beats
   four agents that conflict.
4. **Share grounding once.** Put the facts you discovered (conventions, module map, gate commands,
   prerequisite results) in each brief's `<context>`; do not make three delegates rediscover them.

## Tests

Behavior changes with a usable harness get `test-driven-development` in the implementation brief.
A separate `tests` task exists only when tests are the deliverable or the implementation lane is
weak at tests; it depends on the implementation landing.

## Review lifecycle

```text
implementation → verify → debate-review → findings → validate each → fix → re-review affected → verify
```

- Run `debate-review` on the combined change (`--local` without a PR; the PR/MR URL with one). It
  owns its reviewer lanes; do not duplicate them here.
- Validate every finding against the code before acting. Reject wrong, speculative, or out-of-scope
  findings with a one-line reason.
- **PR exists** → `babysit-pr` drives the round (harvest, verify, fix blockers, reply, resolve). Its
  code fixes are still delegated: one fix brief per finding cluster, `receiving-code-review` +
  `ponytail` + task skills, through a writable `debug` (or the producing) lane. Push, reply, and
  resolve only after your own verification.
- **No PR** → delegate fixes the same way, verify, re-run `debate-review --local`.
- Unknown-cause finding → read-only `systematic-debugging` brief first.
- Re-review scope: unresolved findings, code touched by fixes, regressions from fixes. Budget: two
  fix rounds; then report remaining findings instead of looping.
- Findings on an already-reviewed change are a fix task, never a fresh implementation workflow.

## Failure handling

- Implementation or test failure with a known cause → back to the producing lane, same session
  (`--session <id>` from `result.json`), delta brief with the evidence.
- Unknown cause or a second failure on the same task → `debug` lane, read-only diagnosis, then fix.
- Lane unavailable → `fleet.mjs pick` next candidate, same effort and skills, report the change.
- Two lanes never reimplement the same surface concurrently.

## Landing

Commit, push, PR, or merge only when the user authorized it. Otherwise report the verified working
tree state and stop. `finishing-a-development-branch` only when the user asked for that lifecycle.
