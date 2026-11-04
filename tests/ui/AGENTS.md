# UI-test Instructions

## Scope

- UI tests drive a real pinned desktop VS Code window through Playwright and
  Electron. Use them only for behavior that unit, webview and integration
  tests cannot observe: rendered workbench UI, focus, layout and interaction
  across VS Code and the extension's webview.
- Each test names one user-visible risk.
- Add one test at a time. Deliberately break its behavior, confirm the intended
  assertion fails, restore it and establish a repeated-run baseline before
  adding another.

## Isolation and ownership

- Linux desktop tests require `bubblewrap` (`bwrap`) and permission to create
  user namespaces. `electron.sh` contains Electron and its descendants in a PID
  namespace. Its owner lifeline uses descriptor 3 from the pinned Playwright
  launch; an unavailable socket fails launch rather than disabling containment.
- Keep Playwright's awaited application close. Forced fixture cleanup targets
  namespace PID 1. Playwright launch failures use its own launch-group kill;
  namespace cleanup on that path is not independently awaited by the fixture.

- Each test owns a unique workspace, user-data directory, extensions
  directory, agent process, VS Code window, X display and output artifacts.
- Cleanup must run when fixture setup, the test body or diagnostics fail.
  Terminate complete process groups and remove temporary directories.
- Do not use the user's profile, extensions, workspace or VS Code instance.
- Keep retries disabled while measuring reliability. Never share mutable
  fixture state between tests.

## Waiting and selectors

- Never use sleeps, `waitForTimeout`, polling loops or reordered actions to
  avoid a race. Start observation before the action and await visible,
  accessible or otherwise observable UI state.
- Assertion and job timeouts protect wall-clock execution; they are not
  synchronization.
- Keep selectors for VS Code's workbench and webview frames in
  `workbench.ts`. Prefer roles, labels and extension-owned IDs. Explain every
  selector that relies on VS Code's private DOM.
- When a failure is not understood, gather a screenshot, trace, DOM state,
  focus state or logs before changing the test or product.

## Verification

- npm scripts are the supported developer entry point. Do not invoke Playwright, Electron,
  framework CLIs, or runner scripts directly.
- Every test and coverage command runs typecheck, ESLint and Knip before
  preparation or execution; a failed check stops the command.
- During development, run targeted UI test files with:
  `npm run test:ui -- tests/ui/reveal-chat.test.ts --repeat 3`
- Positional arguments accept explicit space-separated repo-relative source paths
  (no globs or unmatched paths).
- `--repeat N` runs fresh sequential executions (positive integer, default `1`) and
  stops immediately on the first failure. Bundles are prepared once per batch.
- `--jobs`, `--display` and integration `.env.test.local` preferences do not
  apply to UI execution. Local `.env.test.local` setting `UI_JOBS` sets a positive
  integer Playwright worker cap using file-level scheduling. Default is one
  worker; CI ignores the local file. UI owns its displays separately and keeps
  retries disabled. Do not wrap the command in another Xvfb launcher.
- UI and integration use the shared pinned editor in `tools/vscode-test.mjs`.
  See `tests/AGENTS.md` for prerequisites and unverified platform support.
- Inspect the named passing screenshot when a test establishes visual behavior.
  Failure artifacts (screenshots, traces, DOM state, focus logs) belong under
  `test-results/ui/`.
- Keep retries disabled while measuring reliability. Ensure full cleanup runs
  when fixture setup, the test body, or diagnostics fail.
- `npm test` is the unfiltered checked unit/webview and integration gate.
  It rejects paths, CLI controls and inherited legacy execution overrides.
- Always report the exact npm command, scope, repeat count, and results; a
  focused test pass is not a substitute for the full gate.
- Before handoff, run `npm run test:ui`; the full gate `npm test` does not run UI
  tests. Both commands typecheck and lint before running their test suites.
