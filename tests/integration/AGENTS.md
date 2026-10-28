# Integration-test Instructions

## Integration-test architecture

- Every integration test file is an independently schedulable lifecycle. It
  must pass alone, in any file order and concurrently with every other file.
- Use concise hyphenated file names. Split slow files at real lifecycle or
  protocol boundaries so the runner can schedule the pieces independently.
  Never partition tests with Mocha grep expressions or runner-known suite
  names.
- Keep the runner generic. It may discover, group and execute files, but must
  not know about named suites, "light" or "dedicated" jobs, protocol versions
  or a hardcoded expected test count.
- Do not use Mocha's `--parallel`. Parallelism comes from isolated VS Code
  processes because Mocha workers do not receive VS Code's injected API.

## Ownership and isolation

- Each file owns every agent session, temporary file, configuration change,
  editor, terminal, watcher and event subscription that it creates.
- Use a unique session ID for every fake-agent suite. Never use a shared
  literal such as `fake-session` when the session's review or transcript can
  outlive the agent connection.
- Restore configuration and close or dispose all owned resources in teardown.
  Cleanup must also run after a setup or assertion failure.
- Never depend on another file's setup, teardown, open editor, active session,
  review state, configuration or filesystem artifacts.
- Protocol versions may share fixture source code, but never runtime session,
  configuration or review state.
- Generic filesystem tests use a unique directory under the system temporary
  directory, outside a Git worktree. Tests specifically covering Git
  interoperability create and remove their own temporary Git repository.
- Do not mutate repository files or use the user's VS Code profile.

## Waiting and failure behavior

- Wait for observable state: an event, editor state, file contents, view state
  or another condition the behavior promises. Do not use sleeps or short
  readiness timeouts as synchronization.
- Register the listener before causing its event. When a platform API exposes
  no readiness signal, do not infer readiness from elapsed time, polling or
  repeated side effects. Inject that boundary for a deterministic contract
  test and retain a separate end-to-end test that exercises the real API.
- Test observability hooks may expose settlement or inject an external
  dependency. They must not add test-only behavior branches or replace
  end-to-end coverage of the production path.
- Do not inflate Mocha timeouts to hide a race. Mocha has no per-test timeout;
  the runner's child-process watchdog is the sole protection against a
  permanently hung job.
- A wait that hangs usually means setup failed or the awaited event can no
  longer occur. Diagnose that cause instead of weakening the assertion.

## Parallel-runner resources

- Every job gets an isolated VS Code user-data directory and, on Linux, an
  isolated X display. Do not share either resource between jobs.
- Default job count is bounded by both half the available CPUs and remaining
  Linux inotify instances, budgeted at 32 instances per VS Code job.
- Dispose filesystem watchers. New global resources require explicit ownership
  and teardown, and must leave enough headroom for hundreds of future tests.
- Legacy `ACP_TEST_*` environment variables (`ACP_TEST_FILES`, `ACP_TEST_JOBS`)
  are internal diagnostic controls superseded by Make controls (`FILES`, `JOBS`).
  Never execute raw compiled bundle runs or invoke runner scripts directly.

## Verification

- Make is the supported developer entry point. Do not invoke runner script files,
  framework CLIs (Mocha), or `npm` directly.
- Every test and coverage Make target runs typecheck and lint before preparation
  or test execution; a failed check stops the target.
- During development, run targeted integration test files with:
  `make test-integration FILES='tests/integration/terminal-displays.test.ts' REPEAT=3 JOBS=4`
- `FILES` accepts explicit whitespace-separated repo-relative source test paths
  (no globs or unmatched paths).
- `REPEAT` runs fresh sequential executions (positive integer, default `1`) and
  stops immediately on the first failure. Bundles and extension are prepared
  once per batch.
- `JOBS` sets a positive integer parallel worker count (supported for
  `test-integration` and `coverage-integration` only).
- Run integration coverage with:
  `make coverage-integration`
  (accepts `FILES`, `REPEAT`, and `JOBS`).
- Legacy `ACP_TEST_*` environment variables are internal diagnostic controls;
  use Make entry points and controls instead.
- `make test` is the unfiltered gate running typecheck, lint, bundle, Vitest
  (unit and bundled webview), and integration suites in that order. It rejects
  `FILES`, `REPEAT`, `JOBS`, or inherited legacy selection overrides.
- Always report the exact Make command, scope, repeat count, and results; a
  focused test pass is not a substitute for the full gate.
- Before handoff, run `make test-integration` (or full gate `make test`); both
  typecheck and lint before running their test suites.
