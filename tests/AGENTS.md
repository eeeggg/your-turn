# Testing Guide

Start here when choosing a test layer, changing test infrastructure or adding
a testing framework. Follow the more specific `AGENTS.md` in a test's
directory when one exists.

## Vitest

Vitest provides the fast in-process test system. Run all of its projects with
`npx vitest run`.

- `tests/unit/` exercises source modules and React views directly. Prefer this
  project whenever behavior does not require a shipped bundle or real VS Code
  host. Read `tests/unit/AGENTS.md` before changing it.
- `tests/webview/` loads the compiled production webview bundle into a fresh
  jsdom page. Use it for behavior at the bundled webview boundary. Compile
  first, then run it with `make test-webview`.

## VS Code integration

`tests/integration/` exercises behavior that requires the real VS Code API or
extension host without driving the rendered workbench. Run it with
`make test-integration`. Read
`tests/integration/AGENTS.md` before changing its tests, fixtures or runner.

## Desktop UI

`tests/ui/` drives a real pinned desktop VS Code window with Playwright. Use
it only for rendered workbench behavior, focus, layout and interaction that
lower layers cannot observe. Run it with `make test-ui`. Read
`tests/ui/AGENTS.md` before changing its tests, fixtures or runner.

## Adding a test framework

- Give a new framework its own directory, runner or project configuration and
  scoped `AGENTS.md`.
- Define the boundary it covers so agents can choose it without duplicating
  lower-level tests.
- Add it to this index with its purpose and verification command. The
  repository-level instructions should continue pointing here rather than
  accumulating framework-specific rules.
