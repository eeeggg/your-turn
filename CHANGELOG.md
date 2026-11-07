# Changelog

## 0.4.0 — 2026-11-07 — First public beta

Your Turn brings ACP agents into VS Code, with streamed conversations,
session management, and review of agent changes in the editor.

This is a beta release. Expect bugs and changes as the extension develops;
feedback and bug reports are welcome.

### Agents and sessions

- Connect to agents using ACP v1 or v2. Add agents from the ACP agent registry,
  detect supported agents on your PATH, or configure a command yourself.
- Choose the models, modes, and other session options offered by your agent,
  use its slash commands, and respond to permission requests in VS Code.
- Browse and load previous sessions. The last active session loads after a
  window reload, and the Agents view lets you open sessions from other
  workspaces, including Remote-SSH workspaces.
- Work in multi-root workspaces: agents that support additional directories
  receive the workspace's other folders.

### Prompts and transcripts

- Switch between sessions using tabs in the chat view, including sessions from
  different agents. Session tabs do not run multiple agents concurrently.
- See agent-reported context usage and session cost when available, and follow
  context compaction in the transcript.
- Answer agent questions through forms and follow agent-requested URL
  interactions with confirmation before opening a link.
- Use **Steer now** with supporting agents to send a queued prompt without
  stopping foreground work.
- View images supplied by agents and images referenced in Markdown, including
  supported local files and HTTPS sources.

- Read streamed Markdown, thoughts, plans, and tool calls in the order the
  agent reports them. Copy message text, Markdown, or links.
- Scroll back without being pulled to the latest output, then jump to the end
  to follow the stream again.
- Queue prompts while the agent works, or send the next queued prompt by
  interrupting the current turn. Recall earlier prompts with the arrow keys.
- Optionally attach the active file to prompts as a resource link.
- Inspect command output in tool calls, or open the retained output in a
  read-only VS Code terminal. Optionally display agent-reported file diffs in
  tool calls and open their files or comparisons from the chat view.

### Review in the editor

- Review supported agent-reported file deletions as well as created and
  modified files.

- Review supported file changes reported by agents in VS Code's native diff
  editor, or choose an inline quick-diff presentation.
- Keep or undo individual changes or whole files, or keep all files under review.
  Your own edits are incorporated into the review baseline rather than
  treated as changes to accept or undo.
- Each session keeps its own review across turns and session switches until
  the window reloads. Review is separate from Git's comparisons and staging
  area.

### Diagnostics and privacy

- View diagnostics through VS Code's log output channel. Capture ACP traffic
  in bounded memory and export it explicitly when needed for troubleshooting.
- No extension usage or error telemetry is sent.

Requires VS Code 1.140.0 or later. Available through the Visual Studio
Marketplace and as a VSIX download from GitHub Releases.
