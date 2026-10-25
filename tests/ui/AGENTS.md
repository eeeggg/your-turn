# UI-test Instructions

## Scope

- UI tests drive a real pinned desktop VS Code window through Playwright and
  Electron. Use them only for behavior that unit, webview and integration
  tests cannot observe: rendered workbench UI, focus, layout and interaction
  across VS Code and the extension's webview.
- Each test names one user-visible risk. It does not replace a live check
  unless the user explicitly changes that gate.
- Add one test at a time. Deliberately break its behavior, confirm the intended
  assertion fails, restore it and establish a repeated-run baseline before
  adding another.

## Isolation and ownership

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

- Run UI tests with `make test-ui`.
- Inspect the named passing screenshot when a test establishes visual
  behavior. Failure artifacts belong under `test-results/ui/`.
- Before handoff, run type checking and linting, the affected lower test
  layers, and the repeated UI baseline required by the plan.
