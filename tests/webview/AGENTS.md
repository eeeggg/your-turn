# Bundled-webview Test Instructions

## Scope and ownership

- Exercise the compiled webview bundle in a fresh jsdom page. Prefer the unit
  layer when source-module behavior is sufficient.
- Each test owns its page, listeners, and pending operations. Close the page
  even when setup, the test body, or an assertion fails. Assertions must not
  prevent cleanup.
- Await observable state. Do not use sleeps, polling delays, or arbitrary
  microtask yields as readiness signals.
- Do not skip tests, suppress errors, or weaken assertions to obtain a pass.

## Verification

- Follow the shared tooling policy in `tests/AGENTS.md`.
- Run `make test-webview`. For focused repeated runs, use
  `make test-webview FILES='tests/webview/markdown.test.ts' REPEAT=3`.
- Make prepares the bundle once per batch. Do not invoke Vitest or load a stale
  bundle through a separate script.
- Before handoff, run `make test-webview` or `make test`, plus `make typecheck`
  and `make lint` after substantive changes. Report scope and repeat count.
