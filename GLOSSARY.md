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

**Connection**:
The live ACP link to one running agent, established by the initialize handshake.
_Avoid_: agent instance, link

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
