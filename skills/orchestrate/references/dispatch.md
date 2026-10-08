# Dispatch and verification

Read this before the first `run-task.mjs` invocation and before any check command. Flags below match `--help` on 2026-10-05. A flag that is not in that help text does not exist. Do not invent one.

`<skill-dir>` is the folder that holds `SKILL.md`.

## What the wrapper does

`run-task.mjs` runs preflight, captures a content snapshot, spawns the lane relay **once**, diffs the snapshot, and writes `<state-dir>/<task-id>.json`. It does not retry. It does not run tests, builds, or migrations. Result field `verification` is always `"not-run"`.

Exit codes: `0` success, `1` blocked or failed, `2` usage. `--help` exits `0`.

## Commands

Fleet and specialist lookup stay in [routing.md](routing.md). Then:

```bash
node "<skill-dir>/scripts/fleet.mjs" preflight --lane <name> [--level low|medium|high] [--read-only] --cwd <repo>
node "<skill-dir>/scripts/run-task.mjs" \
  --task-id <id> --state-dir <dir> --brief <file> --lane <name> \
  --cwd <repo> --scope <rel> [--scope <rel>] \
  --timeout <dur> --overall <dur> --max-attempts <n> \
  [--read-only] [--effort low|medium|high] [--inspected]
```

Durations are `h`/`m`/`s` compounds such as `20m` or `1h30m`. `--state-dir` is an existing parent outside the workspace. `--scope` is a relative path inside the workspace, repeated per owned path. `--task-id` is one safe token (`A-Za-z0-9`, `.`, `_`, `-`, max 81 characters).

Omit `--relay`. That flag is for tests. Production uses the relay path from `fleet.mjs list`.

Pass `--level` to preflight and `--effort` to `run-task` only when `fleet.mjs effort --lane <name> --level <level>` printed a non-null `flag` (the string `--effort low|medium|high`). Dial-less and variant lanes return `flag: null`. Put the level in the brief. Preflight of that case sets `checks.effort` to `ready`, `flag: null`, `briefOnly: true`. That does not block. Omit `--effort` on `run-task`.

`--read-only` on a lane whose implementer lacks that capability makes preflight `unsupported` and blocks. Pick a read-only-capable lane for diagnosis and review.

Effective read-only is `lane.readOnly === true` or the wrapper `--read-only` flag. `run-task.mjs` copies the lane flag onto `opts.readOnly` before preflight. `buildRelayArgs` then sends `--read-only` when relay help lists it, and blocks with "relay does not accept --read-only" when it does not. A configured read-only lane still restricts the relay when the wrapper flag is omitted, including a lane-less relay. Omitting the flag on a writable lane does not restrict the relay.

`unavailable` and `unsupported` block. `unknown` does not block. `unknown` is not a verified model. A changed or unparsed live model listing is `unknown`, including when the reason is `model listing unavailable`. A recognized listing can still mark a configured model `unavailable`, and that blocks. `untrustedProjectConfig: true` blocks before probes, including when the selected lane is global. Stop and report. Do not dispatch.

## Same task, same budget

Fallback, read-only diagnosis, and a later fix of the same outcome use the **same** `--task-id` and the same state file. The first successful state write stores `timeoutMs`, `overallMs`, and `attemptLimit`. Later invocations keep those numbers. A new lane or a new `--effort` does not reset them. Deleting the state file to start the budget over is forbidden.

One invocation spawns at most one relay. The orchestrator decides whether another attempt is justified, shows a plan delta, then invokes `run-task` again.

## Snapshots

`run-task` calls `snapshot.mjs` for you. Use the snapshot CLI yourself only to inspect a tree:

```bash
node "<skill-dir>/scripts/snapshot.mjs" capture --root <dir> --out <file>
node "<skill-dir>/scripts/snapshot.mjs" diff --before <file> --after <file> [--read-only] [--scope <rel>]
```

`--out` and any hand-written snapshot file sit outside the workspace. Exit `0` ok, `1` incomplete snapshot or scope/read-only violation, `2` usage.

Coverage that this comparison actually implements:

- Tracked and untracked non-ignored files, git or non-git roots.
- Content hash, so a dirty file that does not change is not a change. A content edit to an already-dirty file is a change.
- Add, delete, modify, mode, symlink text, and a unique-hash rename (`changes[].from` is the old path). A rename is outside scope unless **both** `path` and `from` match `--scope`.
- Read-only: any change sets `readOnlyViolation` and `ok: false`. An unchanged dirty file does not.
- `--scope` marks a changed path outside those prefixes as `outsideScope`.
- `index` is a hash of `git ls-files --stage` (mode, blob id, stage, path). A stat-only `git status` refresh is not an index change.
- A tracked path whose ancestor inside the root is a symlink fails the capture. Direct symlink entries compare link text and do not open the target.
- A symlinked `.gitignore` is not opened and does not hide workspace files.
- Metadata written through a symlink into the workspace is rejected before any workspace directory is created.

Limits that are still current:

- Non-git ignore is exact directory names only.
- Two writers in one workspace cannot be separated by a whole-tree snapshot. Parallel writable tasks use `using-git-worktrees` and a distinct `--cwd` per worktree, or they run one after another in one tree. Disjoint files in one tree are still one snapshot. Do not treat `changes` as exclusive attribution while another writer is alive.
- A relative path is outside the workspace only when it is `..`, starts with `..` plus a separator, or is absolute (`escapesRoot` in `snapshot.mjs` and `run-task.mjs`). A workspace child named `..metadata` or `..state` does not escape. `assertMetadataOutside` and the `--state-dir` check reject it before the directory is created. A sibling directory with either name stays outside and is a valid location. Metadata written through a symlink is rejected before any workspace directory is created. Acceptance of `workspace/..metadata/snapshot.json` (`F1-extra-findings.txt` item 8) is historical, not current. `--scope` still rejects a `..` path segment on its own.

## Partial edits and retries

The wrapper writes `running` (wrapper pid, `childPid: null`, reserved time) before spawn, then updates `childPid`. This attempt's wait is `min(timeout, overall remaining)`. On timeout or an orchestrator `SIGTERM`/`SIGINT`, it signals the relay process group with `SIGTERM`, waits 2500ms so the relay can signal a detached grandchild, then sends `SIGKILL` and sweeps descendant groups from `ps -ax -o pid=,ppid=,pgid=`. Partial files stay on disk.

`ps` is required for that sweep. When `ps` is missing, fails, or returns no rows, descendant groups are unknown. If the relay exits before its own grandchild cleanup, that grandchild can remain. A finished wrapper is not proof the tree is gone. Before any retry, confirm the previous process tree is gone. Do not start the next attempt until you have that confirmation.

`needsInspection: true` means the attempt timed out, was signaled, produced an incoherent relay result, failed the snapshot, or changed files while `ok` is false. Exit is `1`. Read `changes`, `outsideScope`, and `readOnlyViolation`. The next invocation of the same task id then passes `--inspected`. Without it the wrapper refuses and does not spawn.

A running reservation whose `childPid` is null or not a positive integer reconciles as unknown **before** `--inspected` is applied. The wrapper returns "unknown process ownership; refusing to dispatch over a possible orphan" and does not spawn. That is a hard stop, including when the crash was before the child pid was recorded. Do not delete the state file to get past it.

Also before any retry:

- Do not start a second `run-task` for the same task id, or a second writer on the same tree, while one may still be running. A live wrapper pid or a live recorded child pid blocks.
- An empty or malformed task lock blocks (`lockDisposition` returns `unknown`). A well-formed dead pid is recoverable: `acquireLock` unlinks that lock and retries. The whole acquisition/recovery loop runs inside an atomic `mkdirSync` guard at `<task>.lock.guard`: only the invocation that creates the guard may touch the task lock, so concurrent dead-lock recovery cannot unlink a lock another writer just recreated. A leftover guard (`EEXIST`) blocks acquisition before the task lock is touched, and the blocked error names that guard path and states only that acquisition may be active or left by a crash — it does not confirm a live writer. A stale or unknown guard is a hard stop — there is no guard recovery; remove it only after you have confirmed no writer for that task is alive.
- If the state file is missing or unreadable, stop. Do not delete it and do not invent a fresh budget. An invalid state file already refuses with "refusing to reset the budget".

Relay stdout, stderr, `result.json`, the report, and `sessionId` (when the relay result includes one) are under `artifacts`, in `<state-dir>/attempts/<task-id>/<n>/`. `verification` stays `"not-run"`. You still run the checks. `run-task` has no `--session` flag and does not pass resume arguments. Lane and model still belong in the plan and in `<route>`, copied from `fleet.mjs`.

## Relay arguments

`run-task` probes the lane relay with `--help`. A missing, nonzero, or flagless probe blocks with "relay capabilities are unknown". It does not invent `--lane` or any other flag.

When the probe succeeds, the relay argv is:

- `--brief` and `--cd` (required; otherwise the dispatch blocks).
- `--lane <name>` only when that help text lists `--lane`. Otherwise `--model <lane.model>` when the lane has a model, and the dispatch blocks when the relay has no `--model`.
- `--variant <configured>` only for a lane-less relay that has a variant dial, and only when help lists `--variant`. Otherwise that dispatch blocks.
- `--read-only` when effective read-only is set (configured lane or wrapper flag) and help lists `--read-only`. Help that lacks it blocks that dispatch. `--effort <level>` only when you requested it and help lists it.
- `--out-dir <attempt dir>` when help lists `--out-dir`.

`fleet.mjs pick` prints a `command` with the same rule. `--lane` on **your** `run-task` command is the wrapper's lane selector. It is not automatically forwarded.

The Grok relay `--help` (`grok-delegate` `scripts/relay.mjs`, read 2026-10-05) lists `--brief`, `--cd`, `--model`, `--effort`, `--max-turns`, `--read-only`, `--full-access`, `--resume-last`, `--session`, `--out-dir`. It does not list `--lane`. For that relay the wrapper passes `--model` from the lane and omits `--lane`. Do not hand-build a `grok` command. Read the relay `--help` again when a dispatch fails on arguments. Do not add flags that help text does not list.

## Verification commands

`run-task` will not run them. You run them after the attempt, per `verification-before-completion`.

1. Read the repo's `CLAUDE.md` / `AGENTS.md` and the package or task scripts those files name.
2. Open each script you might run and the scripts it calls. Look for migrate, deploy, billing, production writes, or customer data.
3. If the chain does any of those, do not use it as a check. Run a side-effect-free command that still answers the question.
4. An integration test the user already approved stays allowed after that inspection. The ban is the unread dangerous chain, not every test that touches a service.
5. Repo-mandated security gates still run when their own commands are safe, or you report the gate as not run and why.

Worked chain (iamahero, read 2026-10-05 from `/Users/ahmedkhaled/projects/iamahero/package.json` and `scripts/migrate.js`; re-read both before using them): `npm run build` is `prisma generate && node scripts/migrate.js && next build`. `scripts/migrate.js` runs `npx prisma migrate deploy` against the database the environment points at (production fails the build when that deploy fails). `npx next build` checks the Next build and does not run that migration. Use `npx next build` unless the user authorized the migration. Live migration compatibility stays unverified until that authorized deploy runs.

A delegate's "tests pass" remains a claim. `touchedFiles` from a relay is the whole git status, not the task delta. Use `run-task`'s `changes` plus your own diff.
