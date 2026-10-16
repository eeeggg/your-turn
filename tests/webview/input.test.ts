import { afterEach, describe, expect, it } from 'vitest';
import { connect, loadChatPage, update, type ChatPage } from './chatPage';

let page: ChatPage;

afterEach(() => {
  expect(page.errors).toEqual([]);
  page.close();
});

const commands = [
  { name: 'init', description: 'Initialize the project' },
  { name: 'review', description: 'Review changes', input: { hint: 'What to review' } },
];

function promptInput(): HTMLTextAreaElement {
  return page.byId<HTMLTextAreaElement>('promptInput');
}

function userMessages(): string[] {
  return [...page.document.querySelectorAll('.message.user')].map((el) => el.textContent ?? '');
}

function popupItems(): Element[] {
  return [...page.byId('slashPopup').querySelectorAll('.slash-popup-item')];
}

function popupOpen(): boolean {
  return page.byId('slashPopup').classList.contains('open');
}

describe('sending prompts', () => {
  it('sends the trimmed prompt on Enter and shows it as a user message', () => {
    page = loadChatPage();
    connect(page);
    page.takePosted();

    page.typePrompt('  hello  ');
    page.pressKey('Enter');

    expect(page.takePosted()).toEqual([{ type: 'sendPrompt', text: 'hello' }]);
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
    page.byId('sendStopBtn').click();

    expect(page.takePosted()).toEqual([]);
    expect(userMessages()).toEqual([]);
  });

  it('sends from the Send button', () => {
    page = loadChatPage();
    connect(page);
    page.takePosted();

    page.typePrompt('hello');
    page.byId('sendStopBtn').click();

    expect(page.takePosted()).toEqual([{ type: 'sendPrompt', text: 'hello' }]);
  });

  it('cancels from the Stop button while a prompt runs, and still sends on Enter', () => {
    page = loadChatPage();
    connect(page);
    page.send({ type: 'promptStart' });
    page.takePosted();

    page.typePrompt('follow-up');
    page.byId('sendStopBtn').click();
    expect(page.takePosted()).toEqual([{ type: 'cancelTurn' }]);

    page.pressKey('Enter');
    expect(page.takePosted()).toEqual([{ type: 'sendPrompt', text: 'follow-up' }]);
    expect(userMessages()).toEqual(['follow-up']);
  });
});

describe('slash commands', () => {
  it('advertises commands in the placeholder', () => {
    page = loadChatPage();
    connect(page);
    expect(promptInput().placeholder).toBe('Type a message...');

    update(page, 'available_commands_update', { availableCommands: commands });
    expect(promptInput().placeholder).toBe('Type a message or / for commands...');
  });

  it('shows matching commands while the command name is typed', () => {
    page = loadChatPage();
    connect(page, { availableCommands: commands });

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
    connect(page, { availableCommands: commands });
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
    connect(page, { availableCommands: commands });
    page.takePosted();

    page.typePrompt('/in');
    page.pressKey('Enter');

    expect(page.takePosted()).toEqual([{ type: 'sendPrompt', text: '/init' }]);
    expect(popupOpen()).toBe(false);
  });

  it('inserts a command that takes input and shows its hint', () => {
    page = loadChatPage();
    connect(page, { availableCommands: commands });
    page.takePosted();

    page.typePrompt('/re');
    page.pressKey('Tab');

    expect(page.takePosted()).toEqual([]);
    expect(promptInput().value).toBe('/review ');
    expect(promptInput().placeholder).toBe('What to review');
  });

  it('selects a command by clicking it', () => {
    page = loadChatPage();
    connect(page, { availableCommands: commands });
    page.takePosted();

    page.typePrompt('/');
    (popupItems()[0] as HTMLElement).click();

    expect(page.takePosted()).toEqual([{ type: 'sendPrompt', text: '/init' }]);
  });

  it('closes on Escape without sending', () => {
    page = loadChatPage();
    connect(page, { availableCommands: commands });
    page.takePosted();

    page.typePrompt('/');
    page.pressKey('Escape');

    expect(popupOpen()).toBe(false);
    expect(page.takePosted()).toEqual([]);
  });
});
