# Integration-test Instructions

## Integration-test architecture

- Every integration test file is an independently schedulable lifecycle. It
  must pass alone, in any file order and concurrently with every other file.
- Use concise hyphenated file names. Split files at real lifecycle or
  protocol boundaries, not to invent extra parallel shards.
  Never partition tests with Mocha grep expressions or runner-known suite
  names.
- Keep the runner generic. It may discover, group and execute files and open
  each job's window as its window kind requires, but must not know about named
  suites, "light" or "dedicated" jobs, protocol versions or a hardcoded
  expected test count.
- A file's directory sets its window kind, listed in
  `tools/integration-windows.mjs`. Files directly in `tests/integration/` run
  in a window on a fresh temporary folder the runner creates for the job and
  removes afterwards. Files in `tests/integration/empty/` run in a window with
  no folder, and those in `tests/integration/untitled-workspace/` in an
  unsaved workspace of two fresh folders; the extension is unavailable in
  both. Files in `tests/integration/saved-workspace/` run in a workspace of
  two fresh folders saved in a `.code-workspace` file the runner writes. Add
  a kind only for a workspace shape the extension behaves differently in,
  never to isolate or schedule particular files. The folders belong to the
  job: files must not depend on their contents, and remove whatever they
  create in them.
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

## Runner resources and concurrency

- Every job gets an isolated VS Code user-data directory and, on Linux, an
  owned X display in Xvfb mode. Existing-display mode is serial.
- Keep one fixed group per represented workspace shape, independent of worker
  count. Each group owns fresh profiles, extensions and workspaces.
- Default concurrency is one. `--jobs N` declares a positive concurrency cap,
  bounded only by represented groups (at most four). Do not add CPU/inotify
  scans, allocation probes or automatic worker scaling.
- Integration and UI share the pinned editor in `tools/vscode-test.mjs`.
  Prepare/download the editor once before integration workers start.
- Serial and parallel modes retain the same isolation, watchdogs, interruption
  handling, cleanup, reporting and failed-run coverage. Do not rerun failed
  parallel tests serially to conceal failures.
- Dispose filesystem watchers. New global resources require explicit ownership
  and teardown, and must leave enough headroom for hundreds of future tests.
- Do not set legacy or internal execution environment controls. Use public npm
  arguments and the narrow local preferences described in `tests/AGENTS.md`.
  Never execute raw compiled bundles or invoke runner scripts directly.

## Verification

- Follow the npm tooling policy in `tests/AGENTS.md`. Do not invoke runner
  scripts or framework CLIs directly.
- Every test and coverage command runs typecheck, ESLint and Knip before
  preparation or execution; a failed check stops the command.
- During development, run targeted integration test files with:
  `npm run test:integration -- tests/integration/terminal-displays.test.ts --repeat 3 --jobs 4 --display xvfb`
- Positional arguments accept explicit space-separated repo-relative source paths
  (no globs or unmatched paths), including those in a window kind's directory,
  such as `tests/integration/empty/unavailable.test.ts`.
- `--repeat N` runs fresh sequential executions (positive integer, default `1`) and
  stops immediately on the first failure. Bundles and extension are prepared
  once per batch.
- `--jobs N` sets the concurrency cap on integration commands only. A focused
  run representing one workspace shape still runs one group.
- `--display auto|xvfb|existing` overrides local preferences. Linux `auto`
  prefers owned Xvfb even serially; unavailable Xvfb permits an announced serial
  fallback only with DISPLAY. `xvfb` fails instead of falling back. `existing`
  requires DISPLAY and serializes deliberately. SSH-forwarded displays can show
  test windows on the user's desktop. UI display ownership is separate.
- Optional `.env.test.local` accepts only `TEST_JOBS` and
  `TEST_DISPLAY`. CLI arguments win, then local settings, then defaults
  (one worker, `auto`). CI ignores the file. Preferences also affect integration
  inside `npm test`, without filtering it. Never change user preferences without
  permission. See `tests/AGENTS.md` for platform limits and prerequisites.
- Run integration coverage with:
  `npm run coverage:integration`
  (accepts paths, `--repeat`, `--jobs` and `--display` after npm's `--`). Reports
  are per job, not combined, under `test-results/integration/coverage/`.
- `npm test` is the unfiltered checked unit/webview and integration gate.
  It rejects paths, CLI controls and inherited legacy execution overrides.
- Always report the exact npm command, scope, repeat count, and results; a
  focused test pass is not a substitute for the full gate.
- Before handoff, run `npm run test:integration` (or full gate `npm test`); both
  typecheck and lint before running their test suites.
