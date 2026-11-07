# Testing Guide

Start here when choosing a test layer, changing test infrastructure or adding
a testing framework. Follow the more specific `AGENTS.md` in a test's
directory when one exists.

## Tooling Policy

Use the supported npm scripts for tests, coverage, typechecking and linting.

- Use `npm run <script>` rather than framework CLIs (Vitest, Mocha,
  Playwright), runner scripts or raw compiled tests directly. Keep checked
  preparation and process ownership inside the shared tooling.
- If a test or verification workflow operation is missing, extend and verify
  the shared tooling first; ask when facing meaningful trade-offs.
- Checked test and coverage commands run repository typechecking, ESLint and
  Knip before bundling or test execution. A failed check stops the command.
  `npm run typecheck` checks types only; `npm run lint` runs ESLint and Knip.
  `npm run check` runs both, without building or testing. `npm run compile`
  typechecks and builds development bundles, without linting or testing.
- Explicit `test:unit:only`, `test:webview:only`, `test:integration:only`, and
  `test:ui:only` commands omit typechecking and linting, but retain the same
  bundle/editor preparation, selection, isolation, and cleanup. CI uses these
  alongside an independent required `Checks` job. Use checked commands for
  local verification; `CI` never silently disables checks.
- Do not create or rely on separate temporary-script verification workflows.
- Repeated runs stop on the first failure; never retry until green.
- Always report the exact npm command, scope, repeat count, and results; a
  focused test pass is not a substitute for the full gate.

## npm Interface

### Prerequisites

- Use Node 24 (`.nvmrc`) and installed project dependencies.
- Linux integration needs working Xvfb (`xvfb-run`) or an accepted existing
  display. Integration does not use bubblewrap. Linux desktop UI and its
  containment regressions require `bubblewrap` (`bwrap`), permission to create
  user/PID namespaces, and Xvfb.
- Do not describe the entire test system as Linux-only or claim verified
  macOS/Windows support. Portability gaps remain in process, filesystem-image
  and temporary-directory fixtures. Preserve Linux-specific coverage and test
  unsupported-platform behavior explicitly. Do not hide portability failures
  with broad skips or weaker assertions.
- Keep prerequisite declarations within this repository; do not modify shared
  host-level provisioning outside it. Missing containment prerequisites must
  fail, never silently disable cleanup.

### Commands

- `npm test` — Unfiltered checked gate: build once, then unit/webview and
  integration suites. UI runs separately. Rejects paths and CLI controls.
- `npm run test:in-process` — Checked unit and bundled-webview suites.
- `npm run test:unit` — Checked unit suite; no bundle build.
  Example: `npm run test:unit -- tests/unit/core/AgentManager.test.ts`
- `npm run test:webview` — Checked bundled-webview suite.
  Example: `npm run test:webview -- tests/webview/markdown.test.ts`
- `npm run test:integration` — Checked isolated VS Code integration suite.
  Example: `npm run test:integration -- tests/integration/terminal-displays.test.ts --repeat 3 --jobs 4 --display xvfb`
- `npm run test:ui` — Checked pinned desktop VS Code suite using Playwright.
  Example: `npm run test:ui -- tests/ui/reveal-chat.test.ts --repeat 3`
- `npm run coverage` — Checked unit coverage; same paths/repeat controls as
  `test:unit`. HTML reports: `test-results/unit/coverage/`.
- `npm run coverage:integration` — Checked integration coverage; same controls
  as `test:integration`. Per-job reports, not combined:
  `test-results/integration/coverage/run-*/job-*/`.
- `npm run test:<layer>:only` — Test-only counterpart for unit, webview,
  integration, or UI. Same layer options; checks must be established separately.
- Workflow changes also require `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12`.
  CI runs this pinned workflow validator in `Checks`; it requires Go and
  network access on the first run, not an npm dependency or global install.

### Scope and Execution Controls

- Pass options and explicit repo-relative source paths after npm's `--`.
  Separate paths with spaces; do not pass globs or one quoted list. Unmatched
  and cross-layer paths fail validation. `test:in-process` accepts both unit
  and webview paths. Integration accepts files in represented workspace
  directories, such as `tests/integration/empty/unavailable.test.ts`.
- `--repeat N` — Positive integer, default `1`; stop on the first failure.
  Checks and required bundles run once before repetitions.
- `--jobs N` — Integration/coverage:integration only. Positive concurrency cap,
  bounded by represented workspace groups (at most four). Default is one;
  there are no CPU/inotify scans or automatic worker scaling.
- `--display auto|xvfb|existing` — Integration/coverage:integration only.
  Linux `auto` prefers owned Xvfb, even serially; if unavailable, announce a
  serial existing-DISPLAY fallback before tests. Forwarded displays can show
  windows on the user's desktop. `xvfb` fails rather than falling back.
  `existing` requires DISPLAY and serializes deliberately. Other platforms
  use native displays; `xvfb` is Linux-only. Missing prerequisites fail with
  actionable errors. Never rerun failed parallel tests serially to hide failures.
- Optional `.env.test.local` accepts only `TEST_JOBS`, `TEST_DISPLAY` and
  `UI_JOBS`. Integration CLI values override local preferences, then defaults.
  CI ignores the file. `TEST_JOBS` and `TEST_DISPLAY` affect integration inside
  `npm test` too, without filtering the gate or changing checks/retries/coverage.
  `UI_JOBS` affects only `test:ui`: a positive integer Playwright worker cap,
  using file-level scheduling. UI defaults to one worker, with retries disabled.
  The file stays out of Git and the VSIX; do not change user preferences
  without permission.
- Do not export legacy `FILES`, `REPEAT`, `JOBS` or internal `TEST_FILES`,
  `TEST_JOBS`, `TEST_DISPLAY`. Public commands reject inherited nonempty controls
  rather than silently narrowing execution. The same `TEST_JOBS` and
  `TEST_DISPLAY` names are permitted as data in `.env.test.local`, not as exported
  environment controls.

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
- Run `npm test` for the unfiltered typecheck, lint, bundle, unit/webview and
  integration gate. Run `npm run test:ui` separately for
  rendered workbench behavior; it also performs typecheck and lint first. These
  isolated runs must not attach to or modify the user's VS Code instances.
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
- Report remaining manual checks for an explicitly authorized package or
  release. Do not require the retired Insiders/dev-prerelease ceremony.
  A green automated gate does not authorize installation, release or publishing.

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
`npm run test:in-process`.

- `tests/unit/` exercises source modules and React views directly. Prefer this
  project whenever behavior does not require a shipped bundle or real VS Code
  host. Read `tests/unit/AGENTS.md` before changing it.
- `tests/webview/` loads the compiled webview bundle into a fresh
  jsdom page. Use it for behavior at the bundled webview boundary. Read
  `tests/webview/AGENTS.md` before changing it. Run with `npm run test:webview`.

### VS Code integration

`tests/integration/` exercises behavior that requires the real VS Code API or
extension host without driving the rendered workbench. Its files run in a
window on a temporary folder, or in the workspace shape their directory under
`tests/integration/` names: `empty/`, `untitled-workspace/` or
`saved-workspace/`. Run it with `npm run test:integration`. Read
`tests/integration/AGENTS.md` before changing its tests, fixtures or runner.

### Desktop UI

`tests/ui/` drives a real pinned desktop VS Code window with Playwright. Use
it only for rendered workbench behavior, focus, layout and interaction that
lower layers cannot observe. Run it with `npm run test:ui`. Read
`tests/ui/AGENTS.md` before changing its tests, fixtures or runner.

## Adding a test framework

- Give a new framework its own directory, runner or project configuration and
  scoped `AGENTS.md`.
- Define the boundary it covers so agents can choose it without duplicating
  lower-level tests.
- Add it to this index with its purpose and verification command. The
  repository-level instructions should continue pointing here rather than
  accumulating framework-specific rules.
