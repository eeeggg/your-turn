# Unit-test Instructions

## Scope

- Prefer a unit test whenever behavior can be exercised through an in-process
  interface. Use integration tests only for behavior that requires the real VS
  Code API, workbench UI or extension-host boundary.
- Test observable behavior and contracts, not private implementation details.
  A refactor that preserves behavior should not require rewriting tests.
- Keep unit tests fast enough to run routinely as the suite grows into the
  thousands. Do not move expensive integration setup into this project.

## Isolation

- Every test must pass alone, in any order and concurrently with other files.
  Never depend on state, mocks or cleanup from another test.
- Restore environment variables, fake timers, spies, module mocks and mutated
  globals in teardown. React view tests call Testing Library cleanup.
- Create filesystem fixtures in a unique directory under the system temporary
  directory and remove them in teardown, including after failures. Never read
  or write the user's files or profile.
- Do not make external network requests. Use in-memory protocol agents,
  deterministic fakes and temporary executable stand-ins.
- Spawn a real child process only when process behavior is what the test
  covers. Own its complete lifecycle and ensure failure paths terminate it.

## Time and asynchronous behavior

- Do not use sleeps, polling delays or short timeouts as synchronization.
  Register listeners before the action and await the event or observable state
  promised by the behavior.
- Inject time or use fake timers when time itself is under test. Do not make
  correctness depend on machine speed.
- Use `InProcessAgents` for ACP conversations unless the process boundary is
  specifically under test. Unused dependency methods should throw so an
  unexpected interaction fails immediately.

## Vitest and view tests

- The unit project uses the Node environment by default. Add
  `// @vitest-environment jsdom` only to a file that exercises DOM behavior.
- View tests use Testing Library and assert what a user can observe or do.
  Keep DOM setup local to the file unless several files share one coherent
  testing interface.
- Give tests behavioral names. Keep helpers small and close to the tests they
  serve; share a helper only when it represents a stable testing abstraction.
- Do not commit `.only`, skipped tests or weakened assertions to make a run
  pass.

## Verification

- Follow the npm tooling policy in `tests/AGENTS.md`. Do not invoke Vitest or
  test runner scripts directly.
- During development, run targeted test files with:
  `npm run test:unit -- tests/unit/core/AgentManager.test.ts`
  Separate multiple paths with whitespace.
- To verify stability, append `--repeat N` (e.g. `--repeat 3`). Repeated runs stop
  immediately on the first failure; never retry until green.
- Run unit coverage with `npm run coverage`; pass source paths and `--repeat N`
  after npm's `--`. Unit execution and coverage do not build bundles.
- All test and coverage commands, including focused unit runs, typecheck and
  run ESLint and Knip first; a failed check stops the command.
- Keep Linux containment prerequisites mandatory on Linux. Test unsupported
  platforms explicitly where behavior differs; do not hide portability gaps
  with broad skips. See the platform limits in `tests/AGENTS.md`.
- Always report the exact npm command, scope, repeat count, and results; a
  focused test pass is not a substitute for the full gate.
- Before handoff, run `npm run test:unit` (or the full gate `npm test`); both
  include typecheck and lint before the test run.
