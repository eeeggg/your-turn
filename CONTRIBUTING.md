# Contributing to Your Turn

Contributions are welcome: bug reports, documentation improvements, tests, and
code changes all help. For substantial features or architectural changes, open
an issue first so we can agree on scope before you invest in implementation.

For suspected vulnerabilities, follow [SECURITY.md](SECURITY.md) rather than
opening a public issue.

## Getting started

1. Fork the repository and create a branch for your change.
2. Use Node.js 24, as specified in `.nvmrc`, and npm.
3. Install the locked dependencies with `npm ci`.
4. Read [AGENTS.md](AGENTS.md) for repository conventions and
   [GLOSSARY.md](GLOSSARY.md) for project terminology.

Keep changes focused and follow the surrounding code's structure and style.

## Verification

Use the npm scripts to verify your changes. See [tests/AGENTS.md](tests/AGENTS.md)
for prerequisites, test layers, and options for running individual tests.

| Command | Scope |
| --- | --- |
| `npm run check` | Type checking, ESLint, and Knip; no build or tests. |
| `npm run test:unit` | Checked unit suite. |
| `npm run test:webview` | Checked bundled-webview suite. |
| `npm run test:integration` | Checked tests in isolated VS Code instances. |
| `npm test` | Unfiltered checked unit, webview, and integration gate. |
| `npm run test:ui` | Separate checked desktop UI suite. |

Run `npm test` for code changes and `npm run test:ui` for rendered workbench
behavior. Add tests for new behavior and regression coverage for bug fixes.

Hosted CI currently verifies Linux. Reports from macOS and Windows are welcome.

## Pull requests and review

Open contribution pull requests against `master`. Explain the problem, the change, and how
you verified it. Include exact commands, test scope, and any failures or checks
you could not run.

Pull requests are reviewed and merged by the project maintainers, Eric Graf
([@eeeggg](https://github.com/eeeggg)) and Brian Peterson
([@braverock](https://github.com/braverock)). Changes must pass the applicable
CI checks before merging.

See [RELEASING.md](RELEASING.md) for the branch and release workflow.

## Reporting bugs

For bug reports, include the extension version, VS Code version, operating
system, expected and actual behavior, and minimal reproduction steps. Sanitize
logs, ACP traffic exports, and screenshots before attaching them.
