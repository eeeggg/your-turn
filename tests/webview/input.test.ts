import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { SlashCommand } from '@/shared/WebviewMessages';
import { answer, connect, loadChatPage as loadPage, replayed, type ChatPage } from '@tests/webview/chatPage';
import { issuedTarget, setup } from '@tests/unit/core/ChatViewControllerTestSupport';

const loadChatPage = () => loadPage({ retained: true });

let page: ChatPage;

const commands: SlashCommand[] = [
  { name: 'init', description: 'Initialize the project', takesInput: false, hint: null },
  { name: 'review', description: 'Review changes', takesInput: true, hint: 'What to review' },
];

function promptInput(): HTMLTextAreaElement {
  return page.byId<HTMLTextAreaElement>('promptInput');
}

function userMessages(): string[] {
  return [...page.document.querySelectorAll('.message.user')].map((el) => el.textContent);
}

function popupItems(): Element[] {
  return [...page.byId('slashPopup').querySelectorAll('.slash-popup-item')];
}

function popupOpen(): boolean {
  return page.byId('slashPopup').classList.contains('open');
}

describe('sending prompts', () => {
  it('edits locally at once and synchronizes only the latest draft after 200 ms without typing', async () => {
    page = loadChatPage();
    connect(page);
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    page.typePrompt('h');
    expect(promptInput().value).toBe('h');
    expect(page.takeComposerEdits()).toEqual([]);
    await vi.advanceTimersByTimeAsync(150);
    page.typePrompt('hello');
    await vi.advanceTimersByTimeAsync(199);
    expect(promptInput().value).toBe('hello');
    expect(page.takeComposerEdits()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(page.takeComposerEdits()).toEqual([{ type: 'composerEdited', target: page.target(), revision: 2, text: 'hello' }]);
  });

  it('flushes a pending draft before tab navigation and cannot post it again later', async () => {
    page = loadChatPage();
    connect(page);
    page.takePosted();
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    page.typePrompt('draft before switch');
    expect(page.takeComposerEdits()).toEqual([]);
    page.document.querySelector<HTMLButtonElement>('[role="tab"]')?.click();
    expect(page.takeComposerEdits()).toEqual([{ type: 'composerEdited', target: page.target(), revision: 1, text: 'draft before switch' }]);
    expect(page.takePosted()).toEqual([{ type: 'selectSessionTab', tabId: 'tab-primary' }]);
    await vi.advanceTimersByTimeAsync(200);
    expect(page.takeComposerEdits()).toEqual([]);
  });

  it('flushes pending draft text when the page is leaving', () => {
    page = loadChatPage();
    connect(page);
    page.typePrompt('last edit');
    expect(page.takeComposerEdits()).toEqual([]);
    page.window.dispatchEvent(new page.window.Event('pagehide'));
    expect(page.takeComposerEdits()).toEqual([{ type: 'composerEdited', target: page.target(), revision: 1, text: 'last edit' }]);
  });

  it('keeps newer local input when an older composer echo arrives during the debounce interval', async () => {
    page = loadChatPage();
    connect(page);
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    page.typePrompt('new local text');
    expect(page.takeComposerEdits()).toEqual([]);
    page.send({ type: 'contentPatch', target: page.target(), base: 0, revision: 1,
      patches: [], currentTurn: null, nextId: 1, usage: null, composer: { text: 'old echo', revision: 0 } });
    expect(promptInput().value).toBe('new local text');
    expect(page.takeComposerEdits()).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(page.takeComposerEdits()).toEqual([{ type: 'composerEdited', target: page.target(), revision: 1, text: 'new local text' }]);
  });

  it('saves a pending draft before acknowledging a repaired projection', async () => {
    const host = setup();
    const { controller, environment } = host;
    await issuedTarget(host);
    await controller.handleMessage({ type: 'ready' });
    const initial = environment.take().find((message) => message.type === 'viewSnapshot');
    if (!initial?.content) { throw new Error('Missing initial projection'); }
    const { target } = initial.content;

    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    page = loadPage();
    page.send(initial);
    page.takePosted();
    await vi.advanceTimersByTimeAsync(50);
    page.takePosted();

    delete environment.acknowledge;
    controller.notifyActiveSessionChanged();
    const missed = environment.take().find((message) => message.type === 'viewSnapshot');
    if (!missed?.content) { throw new Error('Missing changed projection'); }
    const next = missed.content.target;
    page.send({ type: 'contentManifestRequested', target: next });
    const [manifest] = page.takePosted();
    if (manifest?.type !== 'contentManifest') { throw new Error('Missing manifest'); }
    await controller.handleMessage(manifest);
    const repair = environment.take().find((message) => message.type === 'contentPatch');
    if (!repair) { throw new Error('Missing repair patch'); }

    page.typePrompt('draft during reconnect');
    page.send({ ...repair, target: { ...next, sessionId: 'other-session' } });
    expect(page.takeComposerEdits()).toEqual([]);
    page.send(repair);
    const edits = page.takeComposerEdits();
    expect(edits).toEqual([{ type: 'composerEdited', target, revision: 1, text: 'draft during reconnect' }]);
    expect(page.takePosted()).toEqual([]);
    expect(promptInput().value).toBe('draft during reconnect');
    for (const edit of edits) { await controller.handleMessage(edit); }

    await vi.advanceTimersByTimeAsync(50);
    const acknowledgments = page.takePosted();
    expect(acknowledgments).toEqual([{ type: 'contentApplied', target: next, revision: repair.revision }]);
    for (const acknowledgment of acknowledgments) { await controller.handleMessage(acknowledgment); }
    await vi.advanceTimersByTimeAsync(200);
    expect(page.takeComposerEdits()).toEqual([]);
    expect(page.takePosted()).toEqual([]);

    await controller.handleMessage({ type: 'ready' });
    const reopened = environment.take().find((message) => message.type === 'viewSnapshot');
    if (!reopened) { throw new Error('Missing reopened view'); }
    const fresh = loadPage();
    fresh.send(reopened);
    expect(fresh.byId<HTMLTextAreaElement>('promptInput').value).toBe('draft during reconnect');
  });

  it('flushes before Send and never restores the submitted draft from a delayed timer', async () => {
    page = loadChatPage();
    connect(page);
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    page.typePrompt('send without waiting');
    expect(page.takeComposerEdits()).toEqual([]);
    page.pressKey('Enter');
    expect(page.takeComposerEdits()).toEqual([
      { type: 'composerEdited', target: page.target(), revision: 1, text: 'send without waiting' },
      { type: 'composerEdited', target: page.target(), revision: 2, text: '' },
    ]);
    await vi.advanceTimersByTimeAsync(200);
    expect(page.takeComposerEdits()).toEqual([]);
    expect(promptInput().value).toBe('');
    expect(userMessages()).toEqual(['send without waiting']);
  });

  it('sends the trimmed prompt on Enter and shows it as a user message', () => {
    page = loadChatPage();
    connect(page);
    page.takePosted();

    page.typePrompt('  hello  ');
    const target = page.target();
    page.pressKey('Enter');

    expect(page.takePosted()).toEqual([{ type: 'sendPrompt', target, text: 'hello' }]);
    expect(page.takeComposerEdits()).toEqual([
      { type: 'composerEdited', target, revision: 1, text: '  hello  ' },
      { type: 'composerEdited', target, revision: 2, text: '' },
    ]);
    expect(userMessages()).toEqual(['hello']);
    expect(promptInput().value).toBe('');
  });

  it('does not send on Shift+Enter', () => {
    page = loadChatPage();
    connect(page);
    page.takePosted();

    page.typePrompt('hello');
    page.pressKey('Enter', { shiftKey: true });

    expect(page.takePosted()).toEqual([]);
  });

  it('does not send an empty prompt', () => {
    page = loadChatPage();
    connect(page);
    page.takePosted();

    page.typePrompt('   ');
    page.pressKey('Enter');

    expect(page.takePosted()).toEqual([]);
    expect(userMessages()).toEqual([]);
  });

  it('does not send on Enter while an input method is composing', () => {
    page = loadChatPage();
    connect(page);
    page.takePosted();

    page.typePrompt('にほん');
    page.pressKey('Enter', { isComposing: true });

    expect(page.takePosted()).toEqual([]);
    expect(promptInput().value).toBe('にほん');
  });

  it('on Enter while a prompt runs, holds the prompt until the turn ends', () => {
    page = loadChatPage();
    connect(page);
    page.send({ type: 'promptStart' });
    page.takePosted();

    page.typePrompt('follow-up');
    const target = page.target();
    page.pressKey('Enter');
    expect(page.takePosted()).toEqual([{ type: 'sendPrompt', target, text: 'follow-up' }]);
    expect(userMessages()).toEqual([]);
    expect(promptInput().value).toBe('');

    page.send({ type: 'promptEnd' });
    expect(page.takePosted()).toEqual([]);
    expect(userMessages()).toEqual(['follow-up']);
  });
});

describe('when the prompt box can be used', () => {
  function usable(): boolean {
    return !promptInput().disabled;
  }

  it('disables the prompt box without a session, and sends nothing', () => {
    page = loadChatPage();
    page.takePosted();
    expect(usable()).toBe(false);

    page.typePrompt('hello');
    page.pressKey('Enter');
    expect(page.takePosted()).toEqual([]);
    expect(userMessages()).toEqual([]);

    connect(page);
    expect(usable()).toBe(true);
  });

  it('disables it while a session loads, and sends nothing until it has loaded', () => {
    page = loadChatPage();
    connect(page);
    page.send({ type: 'loadSessionStart' });
    page.takePosted();
    expect(usable()).toBe(false);

    page.typePrompt('hello');
    page.pressKey('Enter');
    expect(page.takePosted()).toEqual([]);

    page.send({ type: 'loadSessionEnd', ok: true });
    expect(usable()).toBe(true);
    const target = page.target();
    page.pressKey('Enter');
    expect(page.takePosted()).toEqual([{ type: 'sendPrompt', target, text: 'hello' }]);
  });
});

describe('slash commands', () => {
  it('advertises commands in the placeholder', () => {
    page = loadChatPage();
    connect(page);
    expect(promptInput().placeholder).toBe('Type a message...');

    page.send({ type: 'commands', commands });
    expect(promptInput().placeholder).toBe('Type a message or / for commands...');
  });

  it('shows matching commands while the command name is typed', () => {
    page = loadChatPage();
    connect(page, { commands });

    page.typePrompt('/');
    expect(popupOpen()).toBe(true);
    expect(popupItems().map((el) => el.querySelector('.cmd-name')?.textContent)).toEqual(['/init', '/review']);
    expect(popupItems()[0]?.classList.contains('active')).toBe(true);

    page.typePrompt('/re');
    expect(popupItems().map((el) => el.querySelector('.cmd-name')?.textContent)).toEqual(['/review']);

    page.typePrompt('/zzz');
    expect(popupOpen()).toBe(false);

    page.typePrompt('/review x');
    expect(popupOpen()).toBe(false);
  });

  it('does not open without commands', () => {
    page = loadChatPage();
    connect(page);

    page.typePrompt('/');

    expect(popupOpen()).toBe(false);
  });

  it('moves the selection with the arrow keys', () => {
    page = loadChatPage();
    connect(page, { commands });
    page.typePrompt('/');
    const active = (): boolean[] => popupItems().map((el) => el.classList.contains('active'));

    page.pressKey('ArrowDown');
    expect(active()).toEqual([false, true]);
    page.pressKey('ArrowDown');
    expect(active()).toEqual([false, true]);
    page.pressKey('ArrowUp');
    expect(active()).toEqual([true, false]);
  });

  it('sends a command without input immediately on Enter', () => {
    page = loadChatPage();
    connect(page, { commands });
    page.takePosted();

    page.typePrompt('/in');
    const target = page.target();
    page.pressKey('Enter');

    expect(page.takePosted()).toEqual([{ type: 'sendPrompt', target, text: '/init' }]);
    expect(popupOpen()).toBe(false);
  });

  it('inserts a command that takes input, leaving the prompt box focused for it', () => {
    page = loadChatPage();
    connect(page, { commands });
    page.takePosted();

    page.typePrompt('/re');
    page.pressKey('Tab');

    expect(page.takePosted()).toEqual([]);
    expect(promptInput().value).toBe('/review ');
    expect(popupOpen()).toBe(false);
    expect(page.document.activeElement).toBe(promptInput());
  });

  it("shows a command's input hint beside its name, since the placeholder is hidden once the name is inserted", () => {
    page = loadChatPage();
    connect(page, { commands });

    page.typePrompt('/');
    expect(popupItems().map((el) => el.querySelector('.cmd-hint')?.textContent ?? null)).toEqual([null, 'What to review']);

    page.pressKey('ArrowDown');
    page.pressKey('Tab');
    expect(promptInput().placeholder).toBe('Type a message or / for commands...');
  });

  it('selects a command by clicking it', () => {
    page = loadChatPage();
    connect(page, { commands });
    page.takePosted();

    page.typePrompt('/');
    const target = page.target();
    (popupItems()[0] as HTMLElement).click();

    expect(page.takePosted()).toEqual([{ type: 'sendPrompt', target, text: '/init' }]);
  });

  it('closes on Escape without sending', () => {
    page = loadChatPage();
    connect(page, { commands });
    page.takePosted();

    page.typePrompt('/');
    page.pressKey('Escape');

    expect(popupOpen()).toBe(false);
    expect(page.takePosted()).toEqual([]);
  });
});

describe('the prompt history', () => {
  /** Each prompt sent on Enter and its turn ended. */
  function sendPrompts(...texts: string[]): void {
    for (const text of texts) {
      page.typePrompt(text);
      page.pressKey('Enter');
      page.send({ type: 'promptEnd' });
    }
  }

  function caretAt(start: number, end = start): void {
    promptInput().setSelectionRange(start, end);
  }

  function caret(): [number, number] {
    return [promptInput().selectionStart, promptInput().selectionEnd];
  }

  function announced(): string {
    return page.byId('promptHistoryStatus').textContent;
  }

  it('recalls an older prompt on Up at the start, with the caret at the start, and a newer one on Down at the end, with the caret at the end, sending nothing', () => {
    page = loadChatPage();
    connect(page);
    sendPrompts('first line\nsecond line', 'q2');
    page.takePosted();

    expect(page.pressKey('ArrowUp')).toBe(false);
    expect([promptInput().value, caret(), announced()]).toEqual(['q2', [0, 0], 'Prompt 2 of 2']);
    page.pressKey('ArrowUp');
    expect([promptInput().value, caret()]).toEqual(['first line\nsecond line', [0, 0]]);

    caretAt(promptInput().value.length);
    expect(page.pressKey('ArrowDown')).toBe(false);
    expect([promptInput().value, caret()]).toEqual(['q2', [2, 2]]);
    page.pressKey('ArrowDown');
    expect([promptInput().value, announced()]).toEqual(['', 'Empty prompt']);

    expect(page.takePosted()).toEqual([]);
    expect(userMessages()).toEqual(['first line\nsecond line', 'q2']);
  });

  it('leaves Up and Down to the textarea away from the edges, over a selection, and with a modifier', () => {
    page = loadChatPage();
    connect(page);
    sendPrompts('q1', 'older prompt', 'newest prompt');
    page.pressKey('ArrowUp');
    page.pressKey('ArrowUp');

    caretAt(3);
    const unhandled = [
      page.pressKey('ArrowUp'),
      page.pressKey('ArrowDown'),
      (caretAt(0, 5), page.pressKey('ArrowUp')),
      (caretAt(0), page.pressKey('ArrowUp', { shiftKey: true })),
      page.pressKey('ArrowUp', { altKey: true }),
      page.pressKey('ArrowUp', { ctrlKey: true }),
      page.pressKey('ArrowUp', { metaKey: true }),
      (caretAt(12), page.pressKey('ArrowDown', { shiftKey: true })),
    ];

    expect([unhandled, promptInput().value]).toEqual([unhandled.map(() => true), 'older prompt']);
  });

  it('places the caret once per recall, leaving it where editing the recalled prompt puts it', () => {
    page = loadChatPage();
    connect(page);
    sendPrompts('q1');
    page.pressKey('ArrowUp');

    page.typePrompt('q1, edited');

    expect(caret()).toEqual([10, 10]);
  });

  it('keeps a draft that differs from the latest prompt', () => {
    page = loadChatPage();
    connect(page);
    sendPrompts('q1');

    page.typePrompt('draft');
    caretAt(0);

    expect(page.pressKey('ArrowUp')).toBe(true);
    expect(promptInput().value).toBe('draft');
  });

  it('recalls nothing while an input method is composing', () => {
    page = loadChatPage();
    connect(page);
    sendPrompts('q1');

    expect(page.pressKey('ArrowUp', { isComposing: true })).toBe(true);

    expect(promptInput().value).toBe('');
  });

  it('recalls a slash command with its popup closed, so Up goes on through the history', () => {
    page = loadChatPage();
    connect(page, { commands });
    sendPrompts('q1', '/init');

    page.pressKey('ArrowUp');
    expect([promptInput().value, popupOpen()]).toEqual(['/init', false]);
    caretAt(0);
    page.pressKey('ArrowUp');

    expect(promptInput().value).toBe('q1');
  });

  it('is rebuilt from a replayed load, each prompt once, with the prompts sent after it', () => {
    page = loadChatPage();
    connect(page);
    sendPrompts('before the load');
    page.send({ type: 'loadSessionStart' });
    replayed(page, 'l1', 'u1');
    answer(page, 'a1');
    replayed(page, 'l', 'u2');
    replayed(page, '2', 'u2');
    page.send({ type: 'promptMessage', messageId: 'u2', text: 'l2, revised' });
    page.send({ type: 'loadSessionEnd', ok: true });
    sendPrompts('q3');

    const recalled = [1, 2, 3, 4].map(() => {
      caretAt(0);
      return [page.pressKey('ArrowUp'), promptInput().value];
    });

    expect([recalled, announced()]).toEqual([
      [[false, 'q3'], [false, 'l2, revised'], [false, 'l1'], [true, 'l1']],
      'Prompt 1 of 3',
    ]);
  });
});
