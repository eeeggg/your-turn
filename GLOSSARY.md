# ACP Client for VS Code

A VS Code extension that lets a user work with any ACP agent from inside the editor: it launches the agent, speaks ACP to it, and shows each session's transcript in its chat view.

## Language

### Architecture

**Extension**:
The whole package as installed into VS Code.
_Avoid_: plugin, app

**Core**:
The part of the extension that holds its logic and does not depend on the VS Code API.
_Avoid_: backend, extension side, host

**Adapter**:
The part of the extension that connects core to the VS Code API: views, commands, settings, and storage.
_Avoid_: host, glue, integration

**Chat view**:
The VS Code view, named Chat, in which the webview shows the active session. "Chat" on its own is never a term: say the chat view, the session, or the transcript.
_Avoid_: chat panel, chat (unqualified)

**Webview**:
The page inside the chat view, running in VS Code's sandboxed browser frame and reachable from the extension only by messages.
_Avoid_: frontend, UI, client

**Webview message**:
One message crossing between the extension and the webview, in either direction.
_Avoid_: event, IPC, protocol message

**User action**:
Something the user does in the webview, such as choosing a mode, dispatched to the webview's store together with webview messages.
_Avoid_: event, UI event

**Saved state**:
What a webview can ask VS Code to keep across a rebuild of its page. The chat view keeps none: a rebuilt page starts empty and redraws only what the extension sends.
_Avoid_: cache, webview state

**Extension host**:
The VS Code process that runs core and the adapters.
_Avoid_: host (unqualified)

### Agents

**ACP**:
The Agent Client Protocol, spoken between the extension and an agent; the extension plays the client role.
_Avoid_: protocol (unqualified)

**Agent**:
An external program that speaks ACP, which the extension launches and talks to.
_Avoid_: harness, server, backend, model

**Agent configuration**:
A named recipe for launching an agent: its command, arguments, and environment.
_Avoid_: profile, agent (when the recipe is meant)

**Agent registry**:
The public catalog of ACP agents from which the user can add an agent configuration.
_Avoid_: marketplace, store

**Package runner**:
`npx` or `uvx`, which fetches an agent's package when the agent is launched and runs it; the only way an agent from the agent registry can be added.
_Avoid_: tool, package manager, installer

**Connection**:
The live ACP link to one running agent, established by the initialize handshake.
_Avoid_: agent instance, link

**Negotiation**:
Agreeing on the ACP version for a connection during the initialize handshake: the extension asks for the newest version it speaks, and the agent's answer chooses the ACP driver.
_Avoid_: version detection, probing

**ACP driver**:
The part of core that speaks one version of ACP over a connection, behind an interface the extension defines: commands go down to the agent, and session updates and the agent's requests come up. There is one per ACP version, each speaking its version in full and translating it into the interface's terms.
_Avoid_: adapter (an Adapter, or an ACP adapter such as `claude-agent-acp`), protocol layer, client

**Deviation**:
Something an agent sends against the ACP standard that the extension accepts anyway, repaired where it first reaches the extension's code and logged as a warning, every time, under a code of our own (`ACP-DEV-001`) from the catalog in `src/core/StandardDeviations.ts`. A deviation applies to every agent, not to any agent by name.
_Avoid_: workaround, quirk, hack, compatibility shim

### Sessions

**Session**:
One conversation with an agent, identified by a session ID and owned by the agent.
_Avoid_: conversation, chat, thread

**Active session**:
The one session the chat view currently shows.
_Avoid_: current conversation

**Session history**:
The extension's own list of past sessions per agent, used when the agent cannot list them itself.
_Avoid_: history (unqualified), recent sessions

**Session list**:
The past sessions shown under an agent in the Agents view, listed by the agent when it can, otherwise taken from session history.
_Avoid_: tier 2, session tree

**Load**:
Reopening a past session, during which the agent replays its transcript.
_Avoid_: restore, resume (a separate ACP operation), reopen

**Session update**:
A notification from the agent describing something new or changed in a session.
_Avoid_: event, message

**Transcript**:
Everything the chat view shows for a session: prompts, agent messages, thoughts, tool calls, and plans.
_Avoid_: chat, chat history, conversation history, messages

**Following**:
The transcript keeping the newest of the stream in view as it arrives.
_Avoid_: auto-scroll, stick to bottom

**Reading**:
The transcript staying where the user scrolled while the stream continues below.
_Avoid_: paused, scrolled up

### Turns

**Prompt**:
What the user sends to start a turn.
_Avoid_: message, query, request

**Turn**:
One prompt and all of the agent's work in response, ending with a stop reason.
_Avoid_: run, round, request

**Mid-turn prompt**:
A prompt the user sends while a turn is still running, which waits for that turn to end.
_Avoid_: mid-run prompt, interrupt

**Queued prompt**:
A prompt the user sent during a turn, pinned above the prompt box until the turn ends, when it goes to the agent and joins the transcript. If the agent exits instead, it is dropped: nothing can send it.
_Avoid_: pending prompt

**Agent message**:
Text the agent streams back as its reply during a turn.
_Avoid_: assistant message, response, completion

**Thought**:
The agent's streamed reasoning, shown separately from its reply.
_Avoid_: thinking, reasoning

**Tool call**:
An action the agent reports taking, such as editing a file or running a command, with its status.
_Avoid_: tool use, action, step

**Command output**:
What a command the agent ran wrote: an agent terminal's output, or the text of an `execute` tool call. The tool call shows its end, cleaned of control sequences; Open in Terminal shows all of it that was kept, in a read-only VS Code terminal.
_Avoid_: logs, console output

**Agent terminal**:
A terminal the agent owns and reports by ID (ACP v2), for display only: the extension shows its output and has no control over it.
_Avoid_: client terminal (ACP v1's, which the client creates; the extension offers none), shell

**Plan**:
The agent's list of intended steps and their statuses.
_Avoid_: todo list, tasks

**Part**:
One piece of a turn, in the order it arrived: an agent message, a thought, a group of tool calls, or the plan.
_Avoid_: block (a markdown block within an agent message), item, segment

**Permission request**:
The agent asking the user to approve an action by choosing one of the options it offers.
_Avoid_: approval, confirmation, prompt

### Session controls

**Config option**:
An agent-defined session setting, such as model, mode, or thought level, with the values the agent allows.
_Avoid_: setting, preference

**Mode**:
An agent-defined way of working, chosen per session; the older mechanism that config options supersede.
_Avoid_: profile, persona

**Slash command**:
A command the agent advertises, invoked by typing `/` in the prompt box.
_Avoid_: command (unqualified), action

### Review

**Review**:
A session's files whose net change the human has yet to keep or undo, each from its baseline to what it holds now, whoever changed it since. Only evidence of an agent's change puts a file under review.
_Avoid_: diff (a tool call's, which is history), changeset, pending changes

**Baseline**:
What a file under review held when the review first saw it change; nothing, for a file the agent created. A file back at its baseline leaves the review.
_Avoid_: original, before

**Evidence**:
A report, trusted by a guard, that a path held one content and now holds another.
_Avoid_: event, edit

**Keep**:
Accepting a file's net change: what it holds becomes its baseline, so it leaves the review.
_Avoid_: accept, approve

**Undo**:
Dropping a file's net change by restoring its baseline, then letting it leave the review.
_Avoid_: reject, revert, discard

### Observability

**Traffic**:
The raw ACP messages exchanged with agents, recorded for inspection.
_Avoid_: protocol log, wire log

### Verification

**Unit suite**:
Tests of core and webview modules in isolation, the only tests measured for coverage.
_Avoid_: fast tests

**Webview suite**:
Tests of the assembled webview page, driven by webview messages.
_Avoid_: DOM tests, UI tests

**Integration suite**:
Tests of the extension running inside a real VS Code.
_Avoid_: end-to-end tests, extension tests

**Live gate**:
The user installing a packaged build into VS Code Insiders and trying it against a real agent before work is accepted.
_Avoid_: manual QA, smoke test
