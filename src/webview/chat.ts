// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck

import { postMessage } from '@/webview/VsCodeApi';

const messagesEl = document.getElementById('messages');
const emptyState = document.getElementById('emptyState');
const promptInput = document.getElementById('promptInput');
const sendStopBtn = document.getElementById('sendStopBtn');
const inputArea = document.getElementById('inputArea');
const resizeHandle = document.getElementById('resizeHandle');
const slashPopup = document.getElementById('slashPopup');

let isProcessing = false;

// Thinking state
let currentThoughtEl = null;
let currentThoughtTextEl = null;
let currentThoughtText = '';
let thoughtStartTime = null;
let thoughtEndTime = null;

// Slash commands state
let availableCommands = [];
let slashPopupSelectedIdx = -1;
let slashFilteredCommands = [];
let savedPlaceholder = 'Type a message...';

function updatePlaceholder() {
  savedPlaceholder = availableCommands.length > 0
    ? 'Type a message or / for commands...'
    : 'Type a message...';
  if (!promptInput.value.startsWith('/')) {
    promptInput.placeholder = savedPlaceholder;
  }
}

// The page draws only what the extension tells it and saves nothing: a
// rebuilt page starts empty, and a transcript comes back only by loading
// the session from the agent.
let transcript = [];
// The session the transcript on screen belongs to.
let transcriptSessionId = null;

// Start with input disabled
if (inputArea) { inputArea.classList.add('disabled'); }
let currentAgentMessageEl = null;
let currentAgentMessageText = '';
let currentTurnEl = null;       // .turn container for current response
let currentToolsListEl = null;  // .turn-tools-list inside current turn
let currentToolsCountEl = null; // .turn-tools-summary counter
let currentToolCount = 0;
let toolCalls = {};
const TOOL_CALL_CONTENT_LIMIT = 20000;

// --- Resize handle ---
let inputAreaHeight = 140;
const MIN_INPUT_HEIGHT = 90;
const MAX_INPUT_HEIGHT = 400;

function applyInputHeight(h) {
  inputAreaHeight = Math.max(MIN_INPUT_HEIGHT, Math.min(MAX_INPUT_HEIGHT, h));
  inputArea.style.height = inputAreaHeight + 'px';
}

resizeHandle.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const startY = e.clientY;
  const startHeight = inputArea.offsetHeight;
  function onMove(ev) {
    const delta = startY - ev.clientY;
    applyInputHeight(startHeight + delta);
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

// --- Auto-resize textarea (within the input area constraints) ---
promptInput.addEventListener('input', () => {
  // Slash command autocomplete
  const text = promptInput.value;
  if (text.startsWith('/') && availableCommands.length > 0) {
    const firstSpace = text.indexOf(' ');
    const query = (firstSpace > 0 ? text.slice(1, firstSpace) : text.slice(1)).toLowerCase();
    if (firstSpace < 0) {
      // Still typing command name — show filtered popup
      slashFilteredCommands = availableCommands.filter(c =>
        c.name.toLowerCase().startsWith(query)
      );
      if (slashFilteredCommands.length > 0) {
        renderSlashPopup(slashFilteredCommands);
        slashPopup.classList.add('open');
        slashPopupSelectedIdx = 0;
        highlightSlashItem(0);
      } else {
        slashPopup.classList.remove('open');
      }
    } else {
      slashPopup.classList.remove('open');
    }
  } else {
    slashPopup.classList.remove('open');
    if (!text.startsWith('/')) {
      promptInput.placeholder = savedPlaceholder;
    }
  }
});

// Send on Enter (Shift+Enter for newline)
promptInput.addEventListener('keydown', (e) => {
  // Slash popup navigation
  if (slashPopup.classList.contains('open')) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      slashPopupSelectedIdx = Math.min(slashPopupSelectedIdx + 1, slashFilteredCommands.length - 1);
      highlightSlashItem(slashPopupSelectedIdx);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      slashPopupSelectedIdx = Math.max(slashPopupSelectedIdx - 1, 0);
      highlightSlashItem(slashPopupSelectedIdx);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      selectSlashCommand(slashFilteredCommands[slashPopupSelectedIdx]);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      selectSlashCommand(slashFilteredCommands[slashPopupSelectedIdx]);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      slashPopup.classList.remove('open');
      return;
    }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});

function handleSend() {
  const text = promptInput.value.trim();
  if (!text) { return; }

  addMessage('user', text);
  promptInput.value = '';
  postMessage({ type: 'sendPrompt', text });
}

function handleCancel() {
  postMessage({ type: 'cancelTurn' });
}

function execCmd(command) {
  postMessage({ type: 'executeCommand', command });
}

// Wire up buttons
sendStopBtn.addEventListener('click', () => {
  if (isProcessing) {
    handleCancel();
  } else {
    handleSend();
  }
});

const welcomeConnectAgent = document.getElementById('welcomeConnectAgent');
const welcomeAddAgent = document.getElementById('welcomeAddAgent');
if (welcomeConnectAgent) { welcomeConnectAgent.addEventListener('click', () => execCmd('acp.connectAgent')); }
if (welcomeAddAgent) { welcomeAddAgent.addEventListener('click', () => execCmd('acp.addAgent')); }

// --- Send/Stop toggle ---
function setProcessing(processing) {
  isProcessing = processing;
  if (processing) {
    sendStopBtn.className = 'send-stop-btn stop';
    sendStopBtn.textContent = '■ Stop';
    sendStopBtn.disabled = false;
  } else {
    sendStopBtn.className = 'send-stop-btn send';
    sendStopBtn.textContent = 'Send';
    sendStopBtn.disabled = false;
    promptInput.disabled = false;
  }
}

// --- Session/load overlay ---
const loadOverlay = document.getElementById('loadOverlay');

/** Remove the transcript and every in-progress turn pointer, leaving only the empty state. */
function clearTranscript() {
  transcript = [];
  currentAgentMessageEl = null;
  currentAgentMessageText = '';
  toolCalls = {};
  currentTurnEl = null;
  currentToolsListEl = null;
  currentToolsCountEl = null;
  currentToolCount = 0;
  currentThoughtEl = null;
  currentThoughtTextEl = null;
  currentThoughtText = '';
  thoughtStartTime = null;
  thoughtEndTime = null;
  messagesEl.innerHTML = '';
  if (emptyState) { messagesEl.appendChild(emptyState); }
}

function handleLoadSessionStart() {
  // Keeps the session banner / input area structure intact.
  clearTranscript();
  if (emptyState) { emptyState.style.display = 'none'; }
  if (loadOverlay) { loadOverlay.classList.add('visible'); }
  if (inputArea) { inputArea.classList.add('disabled'); }
  setProcessing(false);
}

function handleLoadSessionEnd(ok) {
  // Commit any trailing turn captured during the replay.
  finalizeCurrentTurn();
  if (loadOverlay) { loadOverlay.classList.remove('visible'); }
  if (inputArea) { inputArea.classList.remove('disabled'); }
  // Batch-render markdown for every agent message captured during
  // the replay (avoids per-chunk render storms).
  const items = [];
  for (let i = 0; i < transcript.length; i++) {
    const item = transcript[i];
    if (item.kind === 'message' && item.role === 'agent') {
      items.push({ index: i, text: item.text });
    }
  }
  if (items.length > 0) {
    postMessage({ type: 'renderMarkdown', items });
  }
  scrollToBottom();
  if (!ok) {
    addMessage('error', 'Failed to load session.');
  }
}

// --- Slash command helpers ---
function renderSlashPopup(commands) {
  slashPopup.innerHTML = '<div class="slash-popup-header">Commands</div>';
  commands.forEach((cmd, i) => {
    const item = document.createElement('div');
    item.className = 'slash-popup-item' + (i === 0 ? ' active' : '');
    item.dataset.index = String(i);
    item.innerHTML =
      '<span class="cmd-name">/' + escapeHtml(cmd.name) + '</span>' +
      '<span class="cmd-desc">' + escapeHtml(cmd.description) + '</span>';
    item.addEventListener('click', () => selectSlashCommand(cmd));
    item.addEventListener('mouseenter', () => {
      slashPopupSelectedIdx = i;
      highlightSlashItem(i);
    });
    slashPopup.appendChild(item);
  });
}

function highlightSlashItem(idx) {
  const items = slashPopup.querySelectorAll('.slash-popup-item');
  items.forEach((el, i) => el.classList.toggle('active', i === idx));
  if (items[idx]) { items[idx].scrollIntoView({ block: 'nearest' }); }
}

function selectSlashCommand(cmd) {
  slashPopup.classList.remove('open');
  if (!cmd) { return; }

  if (cmd.input) {
    // Command expects input — insert "/name " and set placeholder to hint
    promptInput.value = '/' + cmd.name + ' ';
    promptInput.placeholder = cmd.input.hint || 'Type input...';
    promptInput.focus();
  } else {
    // No input required — send immediately
    promptInput.value = '/' + cmd.name;
    handleSend();
  }
}

// --- Messages ---
function addMessage(role, text) {
  transcript.push({ kind: 'message', role, text });
  return addMessageDOM(role, text);
}

function addMessageDOM(role, text) {
  hideEmpty();
  const el = document.createElement('div');
  el.className = 'message ' + role;
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}

function hideEmpty() {
  if (emptyState) { emptyState.style.display = 'none'; }
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function getStatusIcon(status) {
  switch (status) {
    case 'running': return '⟳';
    case 'completed': return '✓';
    case 'failed': return '✗';
    default: return '…';
  }
}

// Ensure the current turn has a tools container
function ensureTurnTools() {
  if (!currentTurnEl) {
    // Create turn container if none (e.g., tool call before first text)
    currentTurnEl = document.createElement('div');
    currentTurnEl.className = 'turn';
    messagesEl.appendChild(currentTurnEl);
  }
  if (!currentToolsListEl) {
    const toolsWrap = document.createElement('div');
    toolsWrap.className = 'turn-tools';

    currentToolCount = 0;
    const summary = document.createElement('div');
    summary.className = 'turn-tools-summary';
    summary.textContent = '▸ Tool calls';
    currentToolsCountEl = summary;
    summary.addEventListener('click', () => {
      const list = summary.nextElementSibling;
      if (list) {
        const count = parseInt(summary.dataset.count || '0', 10);
        const collapsed = list.classList.toggle('collapsed');
        summary.textContent = (collapsed ? '▸ ' : '▾ ') + count + ' tool call' + (count !== 1 ? 's' : '');
      }
    });
    toolsWrap.appendChild(summary);

    const list = document.createElement('div');
    list.className = 'turn-tools-list';
    toolsWrap.appendChild(list);
    currentToolsListEl = list;

    currentTurnEl.appendChild(toolsWrap);
  }
}

function toolStatusClass(status) {
  return status === 'in_progress' ? 'running' : status;
}

function extractToolCallBlocks(content) {
  if (!Array.isArray(content)) { return []; }
  const blocks = [];
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (!block || typeof block !== 'object') { continue; }
    const inner = block.content;
    if (block.type === 'content' && inner && typeof inner === 'object'
      && inner.type === 'text' && typeof inner.text === 'string') {
      blocks.push(inner.text);
    } else if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push(block.text);
    }
  }
  return blocks;
}

function setToolCallContent(el, blocks) {
  const body = el.querySelector('.tc-body');
  const contentEl = el.querySelector('.tc-body-content');
  if (!body || !contentEl) { return; }

  const texts = Array.isArray(blocks)
    ? blocks.filter(function (t) { return typeof t === 'string' && t.length > 0; })
    : [];
  contentEl.textContent = '';
  if (texts.length === 0) {
    body.style.display = 'none';
    return;
  }

  let used = 0;
  let truncated = false;
  for (let i = 0; i < texts.length; i++) {
    if (used >= TOOL_CALL_CONTENT_LIMIT) { truncated = true; break; }
    let text = texts[i];
    const room = TOOL_CALL_CONTENT_LIMIT - used;
    if (text.length > room) {
      text = text.slice(0, room);
      truncated = true;
    }
    used += text.length;
    const blockEl = document.createElement('div');
    blockEl.className = 'tc-body-block';
    blockEl.textContent = text;
    contentEl.appendChild(blockEl);
  }
  if (truncated) {
    const noteEl = document.createElement('div');
    noteEl.className = 'tc-body-truncated';
    noteEl.textContent = '... (output truncated)';
    contentEl.appendChild(noteEl);
  }
  body.style.display = '';
}

function createToolCallElement(toolCallId, title, status, blocks) {
  const el = document.createElement('details');
  el.className = 'tool-call-inline';
  el.id = 'tc-' + toolCallId;

  const summary = document.createElement('summary');
  summary.className = 'tc-summary';

  const iconEl = document.createElement('span');
  iconEl.className = 'tc-icon ' + toolStatusClass(status);
  iconEl.textContent = getStatusIcon(status);

  const titleEl = document.createElement('span');
  titleEl.className = 'tc-title';
  titleEl.textContent = title || 'Tool Call';

  summary.appendChild(iconEl);
  summary.appendChild(titleEl);
  el.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'tc-body';
  body.style.display = 'none';
  const contentEl = document.createElement('div');
  contentEl.className = 'tc-body-content';
  body.appendChild(contentEl);
  el.appendChild(body);

  setToolCallContent(el, blocks);
  return el;
}

function addToolCall(toolCallId, title, status, content) {
  const blocks = extractToolCallBlocks(content);
  transcript.push({ kind: 'toolCall', toolCallId, title, status, content: blocks });
  addToolCallInline(toolCallId, title, status, blocks);
}

function addToolCallInline(toolCallId, title, status, blocks) {
  hideEmpty();
  ensureTurnTools();
  currentToolCount++;
  if (currentToolsCountEl) {
    currentToolsCountEl.dataset.count = String(currentToolCount);
    currentToolsCountEl.textContent = '▾ ' + currentToolCount + ' tool call' + (currentToolCount !== 1 ? 's' : '');
  }

  const el = createToolCallElement(toolCallId, title, status, blocks);
  currentToolsListEl.appendChild(el);
  toolCalls[toolCallId] = el;
  scrollToBottom();
}

function updateToolCall(toolCallId, status, title, content) {
  const hasContent = content !== undefined && content !== null;
  const blocks = hasContent ? extractToolCallBlocks(content) : null;

  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].kind === 'toolCall' && transcript[i].toolCallId === toolCallId) {
      transcript[i].status = status;
      if (title) { transcript[i].title = title; }
      if (hasContent) { transcript[i].content = blocks; }
      break;
    }
  }

  const el = toolCalls[toolCallId] || document.getElementById('tc-' + toolCallId);
  if (!el) { return; }

  const iconEl = el.querySelector('.tc-icon');
  if (iconEl) {
    iconEl.className = 'tc-icon ' + toolStatusClass(status);
    iconEl.textContent = getStatusIcon(status);
  }
  const titleEl = el.querySelector('.tc-title') || el.querySelector('.title');
  if (titleEl && title) {
    titleEl.textContent = title;
  }

  if (hasContent) {
    setToolCallContent(el, blocks);
  }

  // Auto-expand once if tool failed
  if (status === 'failed' && el.tagName === 'DETAILS' && el.dataset.tcAutoExpanded !== '1') {
    el.dataset.tcAutoExpanded = '1';
    el.open = true;
  }
}

function addPlan(plan) {
  transcript.push({ kind: 'plan', plan: plan });
  addPlanDOM(plan);
}

function addPlanDOM(plan) {
  hideEmpty();
  const el = document.createElement('div');
  el.className = 'plan';
  let html = '<div class="plan-title">Plan</div>';
  if (plan.entries) {
    for (const entry of plan.entries) {
      const icon = entry.status === 'completed' ? '✅'
        : entry.status === 'in_progress' ? '🔄' : '⬜';
      const cls = entry.status === 'completed' ? ' completed' : '';
      html += '<div class="plan-entry' + cls + '">'
        + icon + ' ' + escapeHtml(entry.title || entry.description || entry.content || '')
        + '</div>';
    }
  }
  el.innerHTML = html;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function finalizeThought() {
  if (!currentThoughtEl) { return; }
  if (thoughtEndTime) { return; } // already finalized
  thoughtEndTime = Date.now();
  currentThoughtEl.classList.remove('streaming');
  const elapsed = thoughtStartTime ? Math.round((thoughtEndTime - thoughtStartTime) / 1000) : 0;
  const summary = currentThoughtEl.querySelector('summary');
  if (summary) {
    summary.innerHTML = elapsed > 0
      ? 'Thought for ' + elapsed + 's'
      : 'Thought';
  }
}

/**
 * Commit the in-progress turn to the transcript (without firing
 * the live promptEnd markdown-render request — replay does that
 * batched at loadSessionEnd). Resets all per-turn DOM/state pointers so
 * the next turn starts fresh.
 */
function finalizeCurrentTurn() {
  if (currentThoughtText) {
    finalizeThought();
    const tEnd = thoughtEndTime || Date.now();
    transcript.push({
      kind: 'thought',
      text: currentThoughtText,
      durationSec: thoughtStartTime ? Math.round((tEnd - thoughtStartTime) / 1000) : 0,
    });
  }
  if (currentAgentMessageText) {
    transcript.push({ kind: 'message', role: 'agent', text: currentAgentMessageText });
  }
  currentAgentMessageEl = null;
  currentAgentMessageText = '';
  currentTurnEl = null;
  currentToolsListEl = null;
  currentToolsCountEl = null;
  currentToolCount = 0;
  currentThoughtEl = null;
  currentThoughtTextEl = null;
  currentThoughtText = '';
  thoughtStartTime = null;
  thoughtEndTime = null;
}

function showSession(session) {
  hideEmpty();
  if (inputArea) { inputArea.classList.remove('disabled'); }
  promptInput.disabled = false;

  // Restore available commands
  if (session.availableCommands) {
    availableCommands = session.availableCommands;
  }
  updatePlaceholder();
}

/** Without a session nothing on screen can be used, so only the welcome card is left. */
function showNoSession() {
  clearTranscript();
  transcriptSessionId = null;
  availableCommands = [];
  slashPopup.classList.remove('open');
  if (emptyState) { emptyState.style.display = ''; }
  if (inputArea) { inputArea.classList.add('disabled'); }
  setProcessing(false);
}

// Handle messages from the extension
window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'state':
      if (msg.session) {
        if (msg.session.sessionId !== transcriptSessionId) {
          clearTranscript();
          setProcessing(false);
          transcriptSessionId = msg.session.sessionId;
        }
        showSession(msg.session);
      } else {
        showNoSession();
      }
      break;

    case 'promptStart':
      setProcessing(true);
      currentAgentMessageEl = null;
      currentAgentMessageText = '';
      currentTurnEl = null;
      currentToolsListEl = null;
      currentToolsCountEl = null;
      currentToolCount = 0;
      currentThoughtEl = null;
      currentThoughtTextEl = null;
      currentThoughtText = '';
      thoughtStartTime = null;
      thoughtEndTime = null;
      break;

    case 'promptEnd':
      // Finalize thought block if present
      if (currentThoughtText) {
        finalizeThought();
        const tEnd = thoughtEndTime || Date.now();
        transcript.push({
          kind: 'thought',
          text: currentThoughtText,
          durationSec: thoughtStartTime ? Math.round((tEnd - thoughtStartTime) / 1000) : 0,
        });
      }
      if (currentAgentMessageText) {
        transcript.push({ kind: 'message', role: 'agent', text: currentAgentMessageText });
        // Request markdown rendering from extension host
        if (currentAgentMessageEl) {
          postMessage({
            type: 'renderMarkdown',
            items: [{ index: transcript.length - 1, text: currentAgentMessageText }]
          });
        }
      }
      setProcessing(false);
      currentAgentMessageEl = null;
      currentAgentMessageText = '';
      // Auto-collapse tool calls in completed turns
      if (currentToolsListEl && currentToolCount > 3) {
        currentToolsListEl.classList.add('collapsed');
        if (currentToolsCountEl) {
          currentToolsCountEl.dataset.count = String(currentToolCount);
          currentToolsCountEl.textContent = '▸ ' + currentToolCount + ' tool calls';
        }
      }
      currentTurnEl = null;
      currentToolsListEl = null;
      currentToolsCountEl = null;
      currentToolCount = 0;
      currentThoughtEl = null;
      currentThoughtTextEl = null;
      currentThoughtText = '';
      thoughtStartTime = null;
      thoughtEndTime = null;
      break;

    case 'clearTranscript':
      showNoSession();
      break;

    case 'error':
      addMessage('error', msg.message || 'An error occurred');
      break;

    case 'sessionUpdate':
      handleUpdate(msg.update);
      break;

    case 'loadSessionStart':
      handleLoadSessionStart();
      break;

    case 'loadSessionEnd':
      handleLoadSessionEnd(!!msg.ok);
      break;

    case 'markdownRendered': {
      // Extension sent back rendered HTML for messages
      const rendered = msg.items || [];
      for (const item of rendered) {
        // Find the DOM element for this history item
        // For the just-completed streaming message, update the last agent message element
        const transcriptItem = transcript[item.index];
        if (!transcriptItem || transcriptItem.role !== 'agent') { continue; }

        // Find the element — walk all .message.agent elements
        const agentMessageEls = messagesEl.querySelectorAll('.message.agent');
        // The item.index tracks position in transcript; count only agent messages up to this index
        let agentMessageIdx = 0;
        for (let i = 0; i < transcript.length; i++) {
          if (i === item.index) { break; }
          if (transcript[i].kind === 'message' && transcript[i].role === 'agent') { agentMessageIdx++; }
        }
        const el = agentMessageEls[agentMessageIdx];
        if (el) {
          el.classList.add('md-rendered');
          el.innerHTML = item.html;
        }
      }
      scrollToBottom();
      break;
    }
  }
});

function handleUpdate(update) {
  if (!update) { return; }
  const type = update.sessionUpdate;

  switch (type) {
    case 'agent_message_chunk': {
      const content = update.content;
      if (content && content.type === 'text' && content.text) {
        currentAgentMessageText += content.text;
        // Don't create visible element until there's non-whitespace content
        if (!currentAgentMessageEl && !currentAgentMessageText.trim()) {
          break;
        }
        // Auto-collapse thought when the agent message starts
        if (currentThoughtEl && currentThoughtEl.open) {
          finalizeThought();
          currentThoughtEl.open = false;
        }
        if (!currentAgentMessageEl) {
          // Create a turn container; the agent message goes inside it
          if (!currentTurnEl) {
            currentTurnEl = document.createElement('div');
            currentTurnEl.className = 'turn';
            messagesEl.appendChild(currentTurnEl);
            hideEmpty();
          }
          currentAgentMessageEl = document.createElement('div');
          currentAgentMessageEl.className = 'message agent';
          currentTurnEl.insertBefore(currentAgentMessageEl, currentTurnEl.querySelector('.turn-tools'));
        }
        currentAgentMessageEl.textContent = currentAgentMessageText;
        scrollToBottom();
      }
      break;
    }

    case 'user_message_chunk': {
      // Only the session/load replay path emits this; live prompts
      // never echo the user's message. Use it to break apart historical
      // turns: finalize any pending turn first, then append
      // the historical user message.
      const content = update.content;
      if (content && content.type === 'text' && typeof content.text === 'string') {
        finalizeCurrentTurn();
        // Coalesce consecutive user chunks into one message.
        const last = transcript[transcript.length - 1];
        if (last && last.kind === 'message' && last.role === 'user') {
          last.text += content.text;
          const allUser = messagesEl.querySelectorAll('.message.user');
          const el = allUser[allUser.length - 1];
          if (el) { el.textContent = last.text; }
        } else {
          addMessage('user', content.text);
        }
      }
      break;
    }

    case 'agent_thought_chunk': {
      const content = update.content;
      if (content && content.type === 'text') {
        if (!currentThoughtEl) {
          // Create thought block inside turn
          if (!currentTurnEl) {
            currentTurnEl = document.createElement('div');
            currentTurnEl.className = 'turn';
            messagesEl.appendChild(currentTurnEl);
            hideEmpty();
          }
          currentThoughtEl = document.createElement('details');
          currentThoughtEl.className = 'thought-block streaming';
          currentThoughtEl.open = true;
          currentThoughtEl.innerHTML =
            '<summary><span class="thought-indicator"></span> Thinking…</summary>' +
            '<div class="thought-content"></div>';
          currentThoughtTextEl = currentThoughtEl.querySelector('.thought-content');
          currentTurnEl.insertBefore(currentThoughtEl, currentTurnEl.firstChild);
          thoughtStartTime = Date.now();
          currentThoughtText = '';
        }
        currentThoughtText += content.text;
        currentThoughtTextEl.textContent = currentThoughtText;
        scrollToBottom();
      }
      break;
    }

    case 'tool_call': {
      const tc = update;
      addToolCall(
        tc.toolCallId || 'unknown',
        tc.title || 'Tool Call',
        tc.status || 'pending',
        tc.content,
      );
      break;
    }

    case 'tool_call_update': {
      updateToolCall(
        update.toolCallId || 'unknown',
        update.status || 'completed',
        update.title,
        update.content,
      );
      break;
    }

    case 'plan': {
      addPlan(update);
      break;
    }

    case 'available_commands_update':
      availableCommands = update.availableCommands || [];
      updatePlaceholder();
      break;
  }
}
