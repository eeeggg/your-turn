# Testing Guide

Start here when choosing a test layer, changing test infrastructure or adding
a testing framework. Follow the more specific `AGENTS.md` in a test's
directory when one exists.

## Tooling Policy

Use the supported Make targets for tests, coverage, type checking and linting.

- Do not directly invoke `npm`, `npx`, framework CLIs (Vitest, Mocha,
  Playwright) or runner script files for an operation provided by a Make
  target; those commands belong inside shared tooling. `npm`/`npx` may be used
  directly for operations without a Make target when appropriate.
- If a test or verification workflow operation is missing, extend and verify
  the shared tooling first; ask when facing meaningful trade-offs.
- Every test and coverage Make target runs repository typechecking, then linting,
  before bundling, test preparation, or test execution. A failed check stops
  the target. Standalone `make typecheck` and `make lint` remain available.
- Do not create or rely on separate temporary-script verification workflows.
- Repeated runs stop on the first failure; never retry until green.
- Always report the exact Make command, scope, repeat count, and results; a
  focused test pass is not a substitute for the full gate.

## Make Interface

### Prerequisites

- The test environment requires Linux, Node 24, `bubblewrap` (`bwrap`) with
  permission to create user/PID namespaces, and Xvfb. Linux and bubblewrap are
  unconditional requirements, including for the process regressions in the
  default unit suite; cross-platform test portability is not a gate.
- Keep prerequisite declarations within this repository; do not modify shared
  host-level provisioning outside it. Missing containment prerequisites must
  fail, never silently disable cleanup.

### Commands

- `make typecheck` — Type-check the repository.
- `make lint` — Run ESLint and Knip over the repository.
- `make test` — Unfiltered gate running typecheck, lint, bundle, Vitest (unit
  and bundled webview), and integration suites in that order. Rejects `FILES`,
  `REPEAT`, `JOBS`, or inherited legacy selection overrides.
- `make test-vitest` — Typecheck and lint, bundle, then run all Vitest suites
  (unit and bundled webview).
- `make test-unit` — Typecheck and lint, then run the in-process Vitest unit
  suite.
  Example: `make test-unit FILES='tests/unit/core/AgentManager.test.ts'`
- `make test-webview` — Typecheck and lint, bundle, then run the bundled-webview
  Vitest suite. Prepares the webview bundle once per batch where needed.
  Example: `make test-webview FILES='tests/webview/markdown.test.ts'`
- `make test-integration` — Typecheck and lint, bundle, then run the isolated
  VS Code integration suite under Xvfb. Prepares bundles once per batch where needed.
  Example: `make test-integration FILES='tests/integration/terminal-displays.test.ts' REPEAT=3 JOBS=4`
- `make test-ui` — Typecheck and lint, bundle, then drive pinned desktop VS Code
  with Playwright under Xvfb. Prepares bundles once per batch where needed.
  Example: `make test-ui FILES='tests/ui/reveal-chat.test.ts' REPEAT=3`
- `make coverage` — Typecheck and lint, then unit test coverage entry point, controlling the same
  unit layer and scope controls as `test-unit`.
- `make coverage-integration` — Typecheck and lint, bundle, then integration test coverage entry point,
  controlling the same integration layer and scope controls (`FILES`, `REPEAT`,
  `JOBS`) as `test-integration`.

All test and coverage targets perform typecheck and lint before any test-layer
preparation or execution, including focused and repeated runs.

### Scope and Execution Controls

- `FILES` — Whitespace-separated explicit repo-relative test file paths. Every
  path is validated against the chosen test layer; an unmatched or cross-layer
  selection produces an error. Integration paths may name a window kind's
  directory, such as `tests/integration/empty/unavailable.test.ts`.
- `REPEAT` — Positive integer repeat count, default `1`. Repeated runs stop on
  the first failure.
- `JOBS` — Positive integer cap on VS Code windows running at once, supported
  for `test-integration` and `coverage-integration` only; other targets
  preserve their default.
- Bundle preparation — Executed once per batch where needed by the Make targets
  (`test-vitest`, `test-webview`, `test-integration`, `test-ui`, `coverage-integration`).
- Legacy environment variables — `ACP_TEST_FILES` and `ACP_TEST_JOBS` are
  internal integration diagnostic controls superseded by Make `FILES` and
  `JOBS`. Never execute raw compiled bundle runs or invoke runner scripts
  directly.

## Verification and the Release Gate

- For a bug, establish a failing regression before fixing it. Write a
  feature's tests first and watch each fail for the intended reason.
- Break deliberately, one at a time, only where a wrong implementation could
  still pass: a test that passed when first run, an assertion loose enough to
  pass for the wrong reason (prefixes, filters, membership), or a check that
  only a fake's behavior makes meaningful (a fake that ignores or rejects a
  request, for instance). A test that failed first because the behavior did
  not exist yet needs no breaks; say which breaks were skipped and why when
  reporting. If only the build catches a break, use a compiling variant; an
  undetected break needs a test or exposes dead code.
- Run `make test` for the unfiltered typecheck, lint, bundle, unit/webview and
  integration gate. Run `make test-ui` separately for
  rendered workbench behavior; it also performs typecheck and lint first. These
  isolated runs must not touch the user's Stable or Insiders windows.
- Await observable completion. Do not add sleeps, polling delays or arbitrary
  synchronization yields. Timeouts protect wall-clock execution, not readiness.
  Preserve failures and cleanup ownership; do not skip, delete, suppress or
  weaken tests to obtain a pass.
- Automated verification carries repeatable scenarios at the appropriate layer;
  individual implementation increments do not each need a manual gate.
- Before handing over an authorized release candidate, report what automation
  actually covered and give a short list of remaining manual checks: real-agent
  behavior, the installed package over Remote-SSH, and qualitative experience.
  A test layer's existence does not prove a scenario is covered. Do not ask the
  user to repeat established automated scenarios; automate repeated manual
  checks where feasible.
- The user installs candidates in Insiders and explicitly accepts the focused
  manual release gate. A green automated gate alone does not authorize release.

## ACP Test Exchanges

- Do not use the ACP SDK protocol router in tests, fixtures, or test tooling.
  Use explicit agent exchanges with the stable versioned SDK entry points.
  Do not build a replacement protocol router. Negotiation tests must expose the
  actual initialize requests and responses rather than let a router select or
  translate the protocol version on either side.
- Use `tests/unit/core/InProcessAgents.ts` for in-process ACP conversations
  where applicable. Keep fake-agent responses explicit so tests can detect
  incorrect capability delivery and request ordering.

## Test Layers

### Vitest

Vitest provides the fast in-process test system. Run all Vitest projects with
`make test-vitest`.

- `tests/unit/` exercises source modules and React views directly. Prefer this
  project whenever behavior does not require a shipped bundle or real VS Code
  host. Read `tests/unit/AGENTS.md` before changing it.
- `tests/webview/` loads the compiled production webview bundle into a fresh
  jsdom page. Use it for behavior at the bundled webview boundary. Read
  `tests/webview/AGENTS.md` before changing it. Run with `make test-webview`.

### VS Code integration

`tests/integration/` exercises behavior that requires the real VS Code API or
extension host without driving the rendered workbench. Its files run in a
window on a temporary folder, or in the workspace shape their directory under
`tests/integration/` names: `empty/`, `untitled-workspace/` or
`saved-workspace/`. Run it with `make test-integration`. Read
`tests/integration/AGENTS.md` before changing its tests, fixtures or runner.

### Desktop UI

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
