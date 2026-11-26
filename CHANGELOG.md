# Changelog

## 0.6.1 — 2026-11-26 — Beta

### Sessions and chat

- Catch up without reloading after a temporary Remote-SSH interruption when
  the same extension host and chat view survive. Restore missed output and
  session switches without discarding pending drafts or queue edits.
- Open Markdown file links from the transcript in VS Code. Links can point
  to a heading or a line range.
- Keep Chat tab titles in sync with the Agents view refresh.

### Agent setup and reliability

- Configure different agent commands for local and remote workspaces. Remote
  workspaces use only the group for their remote authority; they no longer use
  top-level agent entries.
- Upgrade the ACP SDK to reduce lost session updates when the agent connection
  closes or fails. Support partial ACP v2 compaction status updates.

## 0.6.0 — 2026-11-22 — Beta

### Sessions and chat

- Keep multiple sessions live at once, across agents or on the same agent
  connection. Switch tabs without reloading live sessions or interrupting
  their work. Queued prompts can advance while their session is unselected.
- See which tabs are working, need input, finished, or failed, and which have
  files under review. Tab order and selection are restored after a window reload.
- Use **New Session** to start work and **Connect to Agent** to connect without
  opening a session. Find connection actions in the Agents view. Closing a
  working tab asks whether to stop its turn before closing it.
- Switch tabs faster. Collapsed tool groups and closed tool calls, thoughts,
  and compaction summaries no longer render their contents until opened.

### Review

- Review the same pending file across sessions without maintaining separate
  baselines. Keeping or undoing a shared change updates every affected session.
- Inspect files under review while sessions are working. Keep and Undo wait
  until no session in the workspace is running, waiting for input, or has an
  outstanding prompt submission.

### Changes to defaults and commands

- Automatic active-file context and ACP traffic capture are now off by default.
  Opt in with `your-turn.includeActiveFile` and `your-turn.logTraffic`.
  Use `your-turn.activeFileExcludes` to exclude files from automatic context.
- Removed the **Attach File to Prompt** command. Automatic active-file context
  remains available as a separate setting.

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
