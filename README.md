# Your Turn

[![CI](https://github.com/eeeggg/your-turn/actions/workflows/ci.yml/badge.svg)](https://github.com/eeeggg/your-turn/actions/workflows/ci.yml)

Work with coding agents and understand their changes, one turn at a time.

Your Turn brings agent sessions and code review together in VS Code — without
leaving your editor.

You choose and configure the agent. Your Turn connects to it through the
[Agent Client Protocol (ACP)](https://agentclientprotocol.com/) and provides
the session and review controls in VS Code.

## Working with your agent

### Follow the work

Follow the agent's messages, plans, and tool calls as they happen. Expand
what needs a closer look, scroll back while new work keeps streaming in,
and move between sessions without losing your place.

### Shape the work together

Answer questions and permission requests without breaking your flow. Queue
your next prompt while the agent works, edit it before it sends, or steer
the current turn mid-stream when the agent supports it — so your direction
lands while it still matters.

### Review the result

See what actually changed, not just what the agent reported. Keep what's
right, undo what isn't, or fix it yourself — by change, by file, or all at
once — in diff editors built into your normal editing.

## The Review Buffer

Most agent tools hand you a pile of edits and assume you will use Git to sort
out what happened. Git tracks commits, not turns — it has no notion of "this is
what the agent just did" versus everything else in your working tree. Once
you start folding agent changes into the same diff as your own edits, or into
a history built for commits instead of turns, you lose the one thing you
actually need: a clean view of what *this turn* changed.

The Review Buffer is a separate source control provider, running alongside
Git rather than inside it. It gives the session its own Files Under Review,
each baselined from before the agent's first change to it. Keep or Undo a
file's net change independently of your commits and staging area, while
working in Git exactly as you already do. You don't need to resolve review
after every turn; unresolved changes simply accumulate into one diff until
you do.

**Review is not a sandbox or an approval gate before writing.** Agents change
files as they work (this is one of the things we like about them). The Review
Buffer helps you understand and decide how to respond to these changes.

Today the evidence comes from the agent's own ACP messages, checked against
the file as it is now. Agents can change files without reporting usable
evidence, so the Review Buffer is not a complete audit of filesystem activity.
Closing that gap means adding other sources of evidence over time (Git
included!). Until then, consider this extension to be in beta — though ACP
messages alone already provide enough visibility that we're using this
extension to build itself.

Review decisions are disabled during an agent's running turn but you are able
to review changes as they happen. Review state is held in memory for the
window's lifetime; it is not a durable backup or a replacement for commits.

## Getting started

You need VS Code 1.140 or newer and an ACP-compatible agent. Your Turn connects
to your agent; it does not configure the agent for you or provide a model
subscription or credentials. Follow your agent's documentation for setup,
authentication, permissions, and other agent-specific settings.

1. Install a locally built VSIX with **Extensions: Install from VSIX...**, or run
   the extension from source as described in [AGENTS.md](AGENTS.md).
2. Open a folder on disk. For a multi-root workspace, save the workspace first;
   agents run in its first folder by default.
3. Open **Your Turn** in the Activity Bar.
4. Select **Your Turn: Add Agent Configuration**. Choose an agent from the ACP
   registry or enter a custom command and arguments.
5. Select **Your Turn: Connect to Agent**, then send a prompt.

The ACP registry provides suggested launch commands—a starting point, not a
requirement. You control the command, arguments, and environment variables in
`your-turn.agents`. Use the registry's suggestion, modify it, or supply your own
command or wrapper to launch the agent in the environment you choose.
Your Turn does not sandbox the agent; any isolation must come from your launch
setup.

Registry configurations use `npx` or `uvx`; the required package runner must be
available on the PATH seen by the extension host. **Your Turn: Detect Agents**
looks for registry-listed binary agents already installed on that PATH. It does
not install them.

You can also configure a command directly. For example, with an ACP-capable
OpenCode installation on PATH:

```json
"your-turn.agents": {
  "OpenCode": {
    "command": "opencode",
    "args": ["acp"]
  }
}
```

Session listing, history replay, model controls, slash commands, and other
agent-specific features depend on the capabilities the agent advertises.
Your Turn speaks stable-channel ACP v1 and v2. Protocol compatibility does not
guarantee that every agent reports enough information for every extension
feature.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `your-turn.agents` | `{}` | Named agent commands, arguments, and optional environment variables. |
| `your-turn.review.presentation` | `diffEditor` | Native review diff editors, or `quickDiff` for inline review. |
| `your-turn.autoApprovePermissions` | `ask` | Ask about agent permission requests, or automatically allow them with `allowAll`. |
| `your-turn.includeActiveFile` | `true` | Attach the active editor file as a resource link to prompts. |
| `your-turn.logTraffic` | `true` | Retain ACP traffic in memory for explicit export. |
| `your-turn.showToolCallDiffs` | `false` | Show agent-reported diffs in the transcript, separately from the live Review Buffer. |

Keep permission requests enabled unless you intend to allow the agent's actions
automatically. Permission handling depends on what the agent asks; it does not
isolate the agent from your machine.

## Diagnostics, sensitive information, and telemetry

**Your Turn collects no telemetry.** This does not govern telemetry or data
collection by VS Code, your agent, or services your agent uses.

**Protocol traffic stays in memory unless you export it.** With
`your-turn.logTraffic` enabled (the default), Your Turn retains recent ACP
messages in a bounded in-memory buffer. The buffer does not survive a window
reload or extension shutdown. Disabling the setting stops new capture but does
not clear messages already retained.

**Your Turn: Export Protocol Traffic** saves the retained messages as JSONL
to a location you choose. These messages can contain prompts, source code,
file paths, tool output, credentials, and other sensitive information. Inspect
exports before sharing them, and do not commit them to a repository.

**Your Turn: Show Log** opens operational diagnostics about the extension and
its communication with agents, rather than the full ACP message capture.
Diagnostics can still contain sensitive information, including file paths,
error details, launch arguments at Debug level, and agent stderr at Trace
level. Inspect logs before sharing them.

## License and acknowledgments

Copyright (c) 2026 Eric Graf and Brian Peterson.
Copyright (c) 2026 QuantStrat.

Your Turn is distributed under the [Mozilla Public License, v. 2.0](LICENSE).

Thank you to Jun Han (formulahendry) for publishing [vscode-acp](https://github.com/formulahendry/vscode-acp) and exposing the seam.
