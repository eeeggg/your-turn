# Repository Instructions

## Tooling and Verification

- Use Node.js 24 (`.nvmrc`) and npm. Read `package.json` for the supported
  operations; use its npm scripts instead of invoking framework CLIs or runner
  files directly for operations they provide.
- Start with [tests/AGENTS.md](tests/AGENTS.md) when choosing a test layer,
  verifying changes, or changing test infrastructure.
- Follow the testing guide's checked verification workflow after substantive
  changes. Report the exact commands, scope, repeat counts, failures, and
  incomplete runs; do not present a focused pass as a full gate.
- Do not overlap builds. Production packaging clears development and integration
  bundles; use the supported preparation workflow before subsequent verification.
- Update `package-lock.json` through npm tooling, never by hand.
- `tools/icons.mjs` is the source of truth for generated `resources/icon.svg`
  and `resources/icon.png`. Builds generate both; keep them Git-ignored.

## Language and Architecture

- Use [GLOSSARY.md](GLOSSARY.md) in code, plans, and discussion. Treat a term
  marked _Avoid_ as a naming defect.
- Follow the import boundaries in `eslint.config.mjs`; do not bypass them or
  introduce another shared layer to evade them.
- `eslint.config.mjs` enforces rooted module imports in source and tests:
  `@/` for `src/` and `@tests/` for `tests/`, including siblings. Node-executed
  tooling retains runtime-supported paths; external package imports are unchanged.
- Core and shared code import neither `vscode`, adapters, nor webview modules.
  Declare interfaces for adapters to implement; `src/core/VsCodeApi.ts` defines
  the extension's VS Code-facing interface without importing the VS Code API.
- `src/shared/WebviewMessages.ts` defines the webview message contract without
  reusing core or ACP SDK types. Only `ChatViewController` translates core into
  that contract; other core modules, including ACP drivers, do not depend on it.
- ACP SDK imports in core belong in `src/core/acp/`. The rest of core uses
  `AcpDriver`; the webview does not speak ACP. Monaco imports belong only in
  `src/core/diff/`.
- Webview state modules are React-free and import no views. Keep
  `update(state, action, now)` pure. Views read through `useSelector` with
  selectors returning existing state. Use `useState` only for visual state and
  `useRef`/`useLayoutEffect` for DOM work; do not synchronize state with
  `useEffect`. Only `Main.tsx` posts through `VsCodeApi.ts`.

## API and Protocol Policy

- Use only stable VS Code APIs. Do not introduce proposed APIs or
  `enabledApiProposals`.
- Use the supported ACP SDK entry points: `@agentclientprotocol/sdk` for v1 and
  `@agentclientprotocol/sdk/experimental/v2` for v2. Never import unstable feature
  paths or internal SDK modules, including in tests, fixtures, tooling, or
  type-only imports. The `experimental/v2` name does not authorize its unstable
  feature channel.
- Protocol types establish representable shapes, not actual agent behavior.
  Request captured traffic as evidence for claims about what an agent sends, not
  as a replacement specification. Follow the standard schemas and the
  guard/deviation distinction in `GLOSSARY.md`; deviations are cataloged in
  `src/core/StandardDeviations.ts`, repaired at the boundary, and warned about
  every time, without agent-name-specific behavior.
- Client-owned ACP terminals are intentionally unsupported. Do not advertise
  v1 `terminal` capability or introduce client-side `terminal/*` execution.
  Agents own command execution; displaying their reported output is separate.

## Environment and Release Safety

- Follow [RELEASING.md](RELEASING.md) for branch, version, development-build,
  release-candidate, and publication policy. Do not couple version changes to
  dependency installation or infer publication authorization from a merge.
- Use isolated automated editor instances through the supported test tooling.
  Follow [tests/AGENTS.md](tests/AGENTS.md) for isolation and cleanup requirements.
- Packaging, version changes, installation, commits, tags, publishing, and pushing
  require explicit authorization. Passing verification does not grant it or
  authorize installing into, reloading, or otherwise modifying the user's working
  VS Code environment.
