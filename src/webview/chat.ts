// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck

const vscode = acquireVsCodeApi();
const messagesEl = document.getElementById('messages');
const emptyState = document.getElementById('emptyState');
const promptInput = document.getElementById('promptInput');
const sendStopBtn = document.getElementById('sendStopBtn');
const statusEl = document.getElementById('status');
const sessionBanner = document.getElementById('sessionBanner');
const bannerAgent = document.getElementById('bannerAgent');
const bannerCwd = document.getElementById('bannerCwd');
const inputArea = document.getElementById('inputArea');
const resizeHandle = document.getElementById('resizeHandle');
const slashPopup = document.getElementById('slashPopup');

// Picker elements
const modePickerWrap = document.getElementById('modePickerWrap');
const modePickerBtn = document.getElementById('modePickerBtn');
const modePickerLabel = document.getElementById('modePickerLabel');
const modeDropdown = document.getElementById('modeDropdown');
const configOptionsContainer = document.getElementById('configOptionsContainer');

let hasActiveSession = false;
let isProcessing = false;

// Modes state (legacy fallback path)
let availableModes = [];
let currentModeId = null;

// ACP Session Config Options state (preferred path)
let configOptions = [];        // SessionConfigOption[]
let useConfigOptions = false;  // true when the agent provided configOptions

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

// --- State persistence ---
let chatHistory = [];
let sessionState = null;

function saveState() {
  vscode.setState({ chatHistory, sessionState, hasActiveSession });
}

function restoreState() {
  const saved = vscode.getState();
  if (!saved) { return; }

  chatHistory = saved.chatHistory || [];
  sessionState = saved.sessionState || null;
  hasActiveSession = saved.hasActiveSession || false;

  if (hasActiveSession && sessionState) {
    showSessionConnectedFromState(sessionState);
  }

  const assistantItems = [];
  for (let i = 0; i < chatHistory.length; i++) {
    const item = chatHistory[i];
    switch (item.kind) {
      case 'message':
        addMessageDOM(item.role, item.text);
        if (item.role === 'assistant') {
          assistantItems.push({ index: i, text: item.text });
        }
        break;
      case 'thought':
        addThoughtDOM(item.text, item.durationSec || 0);
        break;
      case 'toolCall':
        addToolCallDOM(item.toolCallId, item.title, item.status, item.content);
        break;
      case 'plan':
        addPlanDOM(item.plan);
        break;
    }
  }

  // Request markdown rendering for all restored assistant messages
  if (assistantItems.length > 0) {
    vscode.postMessage({ type: 'renderMarkdown', items: assistantItems });
  }
}

// Start with input disabled
if (inputArea) { inputArea.classList.add('disabled'); }
let currentAssistantEl = null;
let currentAssistantText = '';
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
  vscode.postMessage({ type: 'sendPrompt', text });
}

function handleCancel() {
  vscode.postMessage({ type: 'cancelTurn' });
}

function execCmd(command) {
  vscode.postMessage({ type: 'executeCommand', command });
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
    statusEl.innerHTML = '<span class="spinner"></span>';
  } else {
    sendStopBtn.className = 'send-stop-btn send';
    sendStopBtn.textContent = 'Send';
    sendStopBtn.disabled = false;
    promptInput.disabled = false;
    statusEl.textContent = '';
  }
}

// --- Session/load overlay ---
const loadOverlay = document.getElementById('loadOverlay');

function handleLoadSessionStart() {
  // Reset all chat state; behaves like clearChat but keeps the session
  // banner / input area structure intact.
  chatHistory = [];
  saveState();
  currentAssistantEl = null;
  currentAssistantText = '';
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
  if (emptyState) {
    messagesEl.appendChild(emptyState);
    emptyState.style.display = 'none';
  }
  if (loadOverlay) { loadOverlay.classList.add('visible'); }
  if (inputArea) { inputArea.classList.add('disabled'); }
  setProcessing(false);
}

function handleLoadSessionEnd(ok) {
  // Commit any trailing assistant turn captured during the replay.
  finalizeCurrentAssistantTurn();
  if (loadOverlay) { loadOverlay.classList.remove('visible'); }
  if (inputArea) { inputArea.classList.remove('disabled'); }
  // Batch-render markdown for every assistant message captured during
  // the replay (avoids per-chunk render storms).
  const items = [];
  for (let i = 0; i < chatHistory.length; i++) {
    const item = chatHistory[i];
    if (item.kind === 'message' && item.role === 'assistant') {
      items.push({ index: i, text: item.text });
    }
  }
  if (items.length > 0) {
    vscode.postMessage({ type: 'renderMarkdown', items });
  }
  scrollToBottom();
  if (!ok) {
    addMessage('error', 'Failed to load session history.');
  }
}

function handleSessionInfoUpdate(title) {
  if (!sessionState) { return; }
  if (typeof title === 'string') {
    sessionState.title = title;
  } else if (title === null) {
    delete sessionState.title;
  }
  saveState();
  if (bannerAgent) {
    bannerAgent.textContent = sessionState.title || sessionState.agentName || 'Agent';
  }
}

// --- Mode / Model pickers ---

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

// --- Mode / Model pickers (cont.) ---
function updateModePicker(modes) {
  if (!modes || !modes.availableModes || modes.availableModes.length === 0) {
    modePickerWrap.classList.add('hidden');
    availableModes = [];
    currentModeId = null;
    return;
  }
  availableModes = modes.availableModes;
  currentModeId = modes.currentModeId || null;
  modePickerWrap.classList.remove('hidden');
  const current = availableModes.find(m => m.id === currentModeId);
  modePickerLabel.textContent = current ? current.name : 'Mode';
  modePickerLabel.title = current && current.description ? current.description : '';
  renderModeDropdown();
}

function renderModeDropdown() {
  modeDropdown.innerHTML = '';
  for (const mode of availableModes) {
    const item = document.createElement('div');
    item.className = 'picker-dropdown-item' + (mode.id === currentModeId ? ' selected' : '');
    item.dataset.desc = mode.description || '';
    if (mode.description) { item.title = mode.description; }
    item.innerHTML =
      '<span class="check">' + (mode.id === currentModeId ? '✓' : '') + '</span>' +
      '<span class="item-label">' + escapeHtml(mode.name) + '</span>';
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      closePickers();
      if (mode.id !== currentModeId) {
        currentModeId = mode.id;
        const current = availableModes.find(m => m.id === currentModeId);
        modePickerLabel.textContent = current ? current.name : 'Mode';
        renderModeDropdown();
        vscode.postMessage({ type: 'setMode', modeId: mode.id });
      }
    });
    modeDropdown.appendChild(item);
  }
}

// --- ACP Session Config Options ---

function iconForCategory(cat) {
  switch (cat) {
    case 'mode': return '⚡';
    case 'model': return '🧠';
    case 'thought_level': return '💭';
    default: return '⚙';
  }
}

function isGroupedOptions(opt) {
  const arr = opt && opt.options;
  if (!Array.isArray(arr) || arr.length === 0) { return false; }
  const first = arr[0];
  return !!(first && typeof first.group === 'string' && Array.isArray(first.options));
}

function findOptionValue(opt, value) {
  if (!opt || !Array.isArray(opt.options)) { return null; }
  if (isGroupedOptions(opt)) {
    for (const group of opt.options) {
      if (!group || !Array.isArray(group.options)) { continue; }
      const hit = group.options.find(v => v && v.value === value);
      if (hit) { return hit; }
    }
    return null;
  }
  return opt.options.find(v => v && v.value === value) || null;
}

function pickerLabelFor(opt) {
  const v = findOptionValue(opt, opt.currentValue);
  return v && v.name ? v.name : (opt.name || 'Option');
}

function pickerTooltipFor(opt) {
  const v = findOptionValue(opt, opt.currentValue);
  return (v && v.description) || opt.description || opt.name || '';
}

function renderConfigPickers(opts) {
  configOptionsContainer.innerHTML = '';
  if (!Array.isArray(opts)) { return; }

  for (const opt of opts) {
    // Spec: ignore unknown types and empty option lists
    if (!opt || opt.type !== 'select') { continue; }
    if (!Array.isArray(opt.options) || opt.options.length === 0) { continue; }

    const wrap = document.createElement('div');
    wrap.className = 'picker-wrap';
    wrap.dataset.configId = opt.id;

    const btn = document.createElement('button');
    btn.className = 'picker-btn';
    btn.title = pickerTooltipFor(opt);
    btn.innerHTML =
      '<span class="picker-icon">' + iconForCategory(opt.category) + '</span>' +
      '<span class="picker-label"></span>' +
      '<span class="picker-chevron">▾</span>';
    btn.querySelector('.picker-label').textContent = pickerLabelFor(opt);
    wrap.appendChild(btn);

    const dropdown = document.createElement('div');
    dropdown.className = 'picker-dropdown';
    renderConfigDropdown(dropdown, opt);
    wrap.appendChild(dropdown);

    configOptionsContainer.appendChild(wrap);
  }
}

function renderConfigDropdown(dropdown, opt) {
  dropdown.innerHTML = '';
  if (isGroupedOptions(opt)) {
    for (const group of opt.options) {
      if (!group || !Array.isArray(group.options)) { continue; }
      const header = document.createElement('div');
      header.className = 'picker-dropdown-group-header';
      header.textContent = group.name || group.group || '';
      dropdown.appendChild(header);
      for (const v of group.options) {
        dropdown.appendChild(buildConfigItem(opt, v));
      }
    }
  } else {
    for (const v of opt.options) {
      dropdown.appendChild(buildConfigItem(opt, v));
    }
  }
}

function buildConfigItem(opt, v) {
  const selected = v.value === opt.currentValue;
  const item = document.createElement('div');
  item.className = 'picker-dropdown-item' + (selected ? ' selected' : '');
  item.dataset.value = v.value;
  item.dataset.desc = v.description || '';
  if (v.description) { item.title = v.description; }
  item.innerHTML =
    '<span class="check">' + (selected ? '✓' : '') + '</span>' +
    '<span class="item-label"></span>';
  item.querySelector('.item-label').textContent = v.name || v.value;
  return item;
}

// Event delegation: handle clicks on dynamically-rendered config pickers
configOptionsContainer.addEventListener('click', (e) => {
  const target = e.target;
  if (!(target instanceof Element)) { return; }

  const item = target.closest('.picker-dropdown-item');
  if (item) {
    e.stopPropagation();
    const wrap = item.closest('.picker-wrap');
    const dropdown = item.closest('.picker-dropdown');
    if (!wrap || !dropdown) { return; }
    const configId = wrap.dataset.configId;
    const value = item.dataset.value;
    if (!configId || value === undefined) { return; }

    // Find option in current state
    const opt = configOptions.find(o => o && o.id === configId);
    if (!opt || value === opt.currentValue) {
      dropdown.classList.remove('open');
      return;
    }

    // Optimistic update — agent's response will replace with authoritative state
    opt.currentValue = value;
    const labelEl = wrap.querySelector('.picker-btn .picker-label');
    const btn = wrap.querySelector('.picker-btn');
    if (labelEl) { labelEl.textContent = pickerLabelFor(opt); }
    if (btn) { btn.title = pickerTooltipFor(opt); }
    renderConfigDropdown(dropdown, opt);

    dropdown.classList.remove('open');
    vscode.postMessage({ type: 'setConfigOption', configId, value });
    return;
  }

  const btn = target.closest('.picker-btn');
  if (btn) {
    e.stopPropagation();
    const wrap = btn.closest('.picker-wrap');
    if (!wrap) { return; }
    const dropdown = wrap.querySelector('.picker-dropdown');
    if (!dropdown) { return; }
    const wasOpen = dropdown.classList.contains('open');
    closePickers();
    if (!wasOpen) { dropdown.classList.add('open'); }
  }
});

function setConfigOptionsState(opts) {
  configOptions = Array.isArray(opts) ? opts : [];
  useConfigOptions = configOptions.length > 0;

  if (useConfigOptions) {
    // Hide legacy mode picker — spec requires configOptions to be used exclusively
    modePickerWrap.classList.add('hidden');
    renderConfigPickers(configOptions);
  } else {
    configOptionsContainer.innerHTML = '';
  }
}

// Toggle picker dropdowns
modePickerBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const wasOpen = modeDropdown.classList.contains('open');
  closePickers();
  if (!wasOpen) { modeDropdown.classList.add('open'); }
});

function closePickers() {
  modeDropdown.classList.remove('open');
  // Close any dynamic config-option dropdowns
  const open = configOptionsContainer.querySelectorAll('.picker-dropdown.open');
  open.forEach(el => el.classList.remove('open'));
  hidePickerTooltip();
}

// --- Picker hover tooltip (shared by all picker dropdowns) ---
const pickerTooltip = document.getElementById('pickerTooltip');

function hidePickerTooltip() {
  if (pickerTooltip) { pickerTooltip.classList.remove('visible'); }
}

function showPickerTooltip(itemEl) {
  if (!pickerTooltip || !itemEl) { return; }
  const desc = itemEl.dataset && itemEl.dataset.desc;
  if (!desc) { hidePickerTooltip(); return; }

  pickerTooltip.textContent = desc;
  // Make it measurable while invisible to the user.
  pickerTooltip.style.left = '-9999px';
  pickerTooltip.style.top = '-9999px';
  pickerTooltip.classList.add('visible');

  const dropdown = itemEl.closest('.picker-dropdown');
  if (!dropdown) { hidePickerTooltip(); return; }
  const dropRect = dropdown.getBoundingClientRect();
  const itemRect = itemEl.getBoundingClientRect();
  const tipRect = pickerTooltip.getBoundingClientRect();
  const gap = 6;

  // Prefer left side; flip to right if not enough room.
  let left = dropRect.left - tipRect.width - gap;
  if (left < 4) { left = dropRect.right + gap; }
  // Clamp horizontally inside the viewport.
  const maxLeft = window.innerWidth - tipRect.width - 4;
  if (left > maxLeft) { left = Math.max(4, maxLeft); }

  // Vertically align with the hovered item, clamped inside the viewport.
  let top = itemRect.top;
  const maxTop = window.innerHeight - tipRect.height - 4;
  if (top > maxTop) { top = Math.max(4, maxTop); }

  pickerTooltip.style.left = left + 'px';
  pickerTooltip.style.top = top + 'px';
}

// Delegated hover handling — one listener handles every picker dropdown.
document.addEventListener('mouseover', (e) => {
  const target = e.target;
  if (!(target instanceof Element)) { return; }
  const item = target.closest('.picker-dropdown-item');
  if (!item) { return; }
  // Only consider items inside an open dropdown.
  const dropdown = item.closest('.picker-dropdown');
  if (!dropdown || !dropdown.classList.contains('open')) { return; }
  showPickerTooltip(item);
});

document.addEventListener('mouseout', (e) => {
  const target = e.target;
  const related = e.relatedTarget;
  if (!(target instanceof Element)) { return; }
  const item = target.closest('.picker-dropdown-item');
  if (!item) { return; }
  // Stay visible if the mouse moved to another item inside the same dropdown.
  if (related instanceof Element) {
    const nextItem = related.closest('.picker-dropdown-item');
    if (nextItem && nextItem !== item) { return; }
  }
  hidePickerTooltip();
});

// Hide the tooltip when the user scrolls a dropdown so it doesn't drift.
function attachScrollHide(dropdownEl) {
  if (!dropdownEl || dropdownEl._tooltipScrollAttached) { return; }
  dropdownEl._tooltipScrollAttached = true;
  dropdownEl.addEventListener('scroll', hidePickerTooltip);
}
attachScrollHide(modeDropdown);
// Dynamic configOption dropdowns: rely on the same handler via event-delegation
// (they exist inside #configOptionsContainer); attach once per dropdown when created.
if (configOptionsContainer) {
  const mo = new MutationObserver(() => {
    configOptionsContainer.querySelectorAll('.picker-dropdown').forEach(attachScrollHide);
  });
  mo.observe(configOptionsContainer, { childList: true, subtree: true });
}

// Close pickers when clicking outside
document.addEventListener('click', () => closePickers());

// --- Messages ---
function addMessage(role, text) {
  chatHistory.push({ kind: 'message', role, text });
  saveState();
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
  chatHistory.push({ kind: 'toolCall', toolCallId, title, status, content: blocks });
  saveState();
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

function addToolCallDOM(toolCallId, title, status, blocks) {
  hideEmpty();
  const el = createToolCallElement(toolCallId, title, status, blocks);
  messagesEl.appendChild(el);
  toolCalls[toolCallId] = el;
  scrollToBottom();
}

function updateToolCall(toolCallId, status, title, content) {
  const hasContent = content !== undefined && content !== null;
  const blocks = hasContent ? extractToolCallBlocks(content) : null;

  for (let i = chatHistory.length - 1; i >= 0; i--) {
    if (chatHistory[i].kind === 'toolCall' && chatHistory[i].toolCallId === toolCallId) {
      chatHistory[i].status = status;
      if (title) { chatHistory[i].title = title; }
      if (hasContent) { chatHistory[i].content = blocks; }
      break;
    }
  }
  saveState();

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
  chatHistory.push({ kind: 'plan', plan: plan });
  saveState();
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
 * Commit the in-progress assistant turn to chatHistory (without firing
 * the live promptEnd markdown-render request — replay does that
 * batched at loadSessionEnd). Resets all per-turn DOM/state pointers so
 * the next turn starts fresh.
 */
function finalizeCurrentAssistantTurn() {
  if (currentThoughtText) {
    finalizeThought();
    const tEnd = thoughtEndTime || Date.now();
    chatHistory.push({
      kind: 'thought',
      text: currentThoughtText,
      durationSec: thoughtStartTime ? Math.round((tEnd - thoughtStartTime) / 1000) : 0,
    });
  }
  if (currentAssistantText) {
    chatHistory.push({ kind: 'message', role: 'assistant', text: currentAssistantText });
    saveState();
  }
  currentAssistantEl = null;
  currentAssistantText = '';
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

function addThoughtDOM(text, durationSec) {
  hideEmpty();
  const el = document.createElement('details');
  el.className = 'thought-block';
  el.innerHTML =
    '<summary>' + (durationSec > 0 ? 'Thought for ' + durationSec + 's' : 'Thought') + '</summary>' +
    '<div class="thought-content">' + escapeHtml(text) + '</div>';
  messagesEl.appendChild(el);
  scrollToBottom();
}

function showSessionConnected(session) {
  hasActiveSession = true;
  sessionState = {
    agentName: session.agentName,
    cwd: session.cwd,
    title: session.title || undefined,
  };
  saveState();
  showSessionConnectedFromState(sessionState);

  // Prefer ACP "Session Config Options" when provided. Spec: clients
  // that support configOptions MUST use them exclusively and ignore
  // the legacy modes field.
  const cfg = session.configOptions;
  if (Array.isArray(cfg) && cfg.length > 0) {
    setConfigOptionsState(cfg);
  } else {
    setConfigOptionsState([]);
    if (session.modes) { updateModePicker(session.modes); }
  }
  // Restore available commands
  if (session.availableCommands) {
    availableCommands = session.availableCommands;
  }
  updatePlaceholder();
}

function showSessionConnectedFromState(ss) {
  hasActiveSession = true;
  hideEmpty();
  if (bannerAgent) { bannerAgent.textContent = ss.title || ss.agentName || 'Agent'; }
  if (bannerCwd) { bannerCwd.textContent = ss.cwd || ''; }
  if (sessionBanner) { sessionBanner.classList.add('visible'); }
  if (inputArea) { inputArea.classList.remove('disabled'); }
  promptInput.disabled = false;
}

function showNoSession() {
  hasActiveSession = false;
  sessionState = null;
  saveState();
  if (sessionBanner) { sessionBanner.classList.remove('visible'); }
  if (emptyState) { emptyState.style.display = ''; }
  if (inputArea) { inputArea.classList.add('disabled'); }
  // Hide pickers when disconnected
  modePickerWrap.classList.add('hidden');
  setConfigOptionsState([]);
}

// Handle messages from the extension
window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'state':
      if (msg.session) {
        showSessionConnected(msg.session);
      } else {
        showNoSession();
      }
      break;

    case 'promptStart':
      setProcessing(true);
      currentAssistantEl = null;
      currentAssistantText = '';
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
        chatHistory.push({
          kind: 'thought',
          text: currentThoughtText,
          durationSec: thoughtStartTime ? Math.round((tEnd - thoughtStartTime) / 1000) : 0,
        });
      }
      if (currentAssistantText) {
        chatHistory.push({ kind: 'message', role: 'assistant', text: currentAssistantText });
        saveState();
        // Request markdown rendering from extension host
        if (currentAssistantEl) {
          vscode.postMessage({
            type: 'renderMarkdown',
            items: [{ index: chatHistory.length - 1, text: currentAssistantText }]
          });
        }
      }
      setProcessing(false);
      currentAssistantEl = null;
      currentAssistantText = '';
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

    case 'clearChat':
      chatHistory = [];
      sessionState = null;
      saveState();
      currentAssistantEl = null;
      currentAssistantText = '';
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
      availableCommands = [];
      slashPopup.classList.remove('open');
      messagesEl.innerHTML = '';
      messagesEl.appendChild(emptyState);
      if (emptyState) { emptyState.style.display = ''; }
      if (sessionBanner) { sessionBanner.classList.remove('visible'); }
      if (inputArea) { inputArea.classList.add('disabled'); }
      modePickerWrap.classList.add('hidden');
      setConfigOptionsState([]);
      setProcessing(false);
      break;

    case 'error':
      addMessage('error', msg.message || 'An error occurred');
      break;

    case 'sessionUpdate':
      handleUpdate(msg.update);
      break;

    case 'modesUpdate':
      updateModePicker(msg.modes);
      break;

    case 'configOptionsUpdate':
      setConfigOptionsState(msg.configOptions || []);
      break;

    case 'loadSessionStart':
      handleLoadSessionStart();
      break;

    case 'loadSessionEnd':
      handleLoadSessionEnd(!!msg.ok);
      break;

    case 'sessionInfoUpdate':
      handleSessionInfoUpdate(msg.title);
      break;

    case 'markdownRendered': {
      // Extension sent back rendered HTML for messages
      const rendered = msg.items || [];
      for (const item of rendered) {
        // Find the DOM element for this history item
        // For the just-completed streaming message, update the last assistant el
        const historyItem = chatHistory[item.index];
        if (!historyItem || historyItem.role !== 'assistant') { continue; }

        // Find the element — walk all .message.assistant elements
        const allAssistant = messagesEl.querySelectorAll('.message.assistant');
        // The item.index tracks position in chatHistory; count only assistant messages up to this index
        let assistantIdx = 0;
        for (let i = 0; i < chatHistory.length; i++) {
          if (i === item.index) { break; }
          if (chatHistory[i].kind === 'message' && chatHistory[i].role === 'assistant') { assistantIdx++; }
        }
        const el = allAssistant[assistantIdx];
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
        currentAssistantText += content.text;
        // Don't create visible element until there's non-whitespace content
        if (!currentAssistantEl && !currentAssistantText.trim()) {
          break;
        }
        // Auto-collapse thought when assistant text starts
        if (currentThoughtEl && currentThoughtEl.open) {
          finalizeThought();
          currentThoughtEl.open = false;
        }
        if (!currentAssistantEl) {
          // Create a turn container, assistant text goes inside it
          if (!currentTurnEl) {
            currentTurnEl = document.createElement('div');
            currentTurnEl.className = 'turn';
            messagesEl.appendChild(currentTurnEl);
            hideEmpty();
          }
          currentAssistantEl = document.createElement('div');
          currentAssistantEl.className = 'message assistant';
          currentTurnEl.insertBefore(currentAssistantEl, currentTurnEl.querySelector('.turn-tools'));
        }
        currentAssistantEl.textContent = currentAssistantText;
        scrollToBottom();
      }
      break;
    }

    case 'user_message_chunk': {
      // Only the session/load replay path emits this; live prompts
      // never echo the user's message. Use it to break apart historical
      // turns: finalize any pending assistant turn first, then append
      // the historical user message.
      const content = update.content;
      if (content && content.type === 'text' && typeof content.text === 'string') {
        finalizeCurrentAssistantTurn();
        // Coalesce consecutive user chunks into one message.
        const last = chatHistory[chatHistory.length - 1];
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

    case 'current_mode_update': {
      // Server pushed a mode change
      currentModeId = update.currentModeId || update.modeId || null;
      const current = availableModes.find(m => m.id === currentModeId);
      if (current) {
        modePickerLabel.textContent = current.name;
        renderModeDropdown();
      }
      break;
    }

    case 'config_option_update': {
      // Server pushed a full configOptions replacement
      setConfigOptionsState(update.configOptions || []);
      break;
    }

    case 'available_commands_update':
      availableCommands = update.availableCommands || [];
      updatePlaceholder();
      break;
  }
}

// Restore previous state before telling extension we're ready
restoreState();

// Tell extension we're ready
vscode.postMessage({ type: 'ready' });
