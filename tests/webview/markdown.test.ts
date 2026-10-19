import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect, loadChatPage, textChunk, update, type ChatPage } from './chatPage';

let page: ChatPage;

beforeEach(() => {
  page = loadChatPage();
  connect(page);
  page.takePosted();
});

afterEach(() => {
  expect(page.errors).toEqual([]);
  page.close();
});

function message(): Element {
  const el = page.document.querySelector('.message.agent');
  if (!el) {
    throw new Error('no agent message');
  }
  return el;
}

function bold(): string[] {
  return [...message().querySelectorAll('[data-streamdown="strong"]')].map((el) => el.textContent);
}

function answer(...chunks: string[]): void {
  page.send({ type: 'promptStart' });
  for (const chunk of chunks) {
    update(page, 'agent_message_chunk', textChunk(chunk));
  }
}

describe('markdown while it streams', () => {
  it('renders each chunk as it arrives, closing what is half-written', () => {
    answer('Some **bo');
    expect(bold()).toEqual(['bo']);

    update(page, 'agent_message_chunk', textChunk('ld** and `code`'));
    expect(bold()).toEqual(['bold']);
    expect(message().querySelector('code')?.textContent).toBe('code');
  });

  it('asks the extension for nothing when the turn ends', () => {
    answer('**bold**');
    page.send({ type: 'promptEnd', stopReason: 'end_turn' });

    expect(page.takePosted()).toEqual([]);
    expect(bold()).toEqual(['bold']);
  });

  it("keeps a code block's controls disabled until its turn ends", () => {
    answer('```ts\nconst a = 1;\n```\n');
    const copy = () => message().querySelector<HTMLButtonElement>('[data-streamdown="code-block-copy-button"]');
    expect(copy()?.disabled).toBe(true);

    page.send({ type: 'promptEnd', stopReason: 'end_turn' });
    expect(copy()?.disabled).toBe(false);
  });
});

describe('what the agent cannot put on the page', () => {
  it('drops scripts, styles and frames', () => {
    answer('<script>window.injected = true</script>\n\n<style>body { display: none }</style>\n\n<iframe src="https://example.com"></iframe>\n\nafter');

    expect(message().querySelectorAll('script, style, iframe')).toHaveLength(0);
    expect((page.window as unknown as { injected?: boolean }).injected).toBeUndefined();
    expect(message().textContent).toContain('after');
  });

  it('drops event handler attributes', () => {
    answer('<img src="x" onerror="window.injected = true">\n\n<b onclick="window.injected = true">bold</b>');

    const handlers = [...message().querySelectorAll('*')].flatMap((el) =>
      [...el.attributes].filter((attribute) => attribute.name.startsWith('on')).map((attribute) => attribute.name),
    );
    expect(handlers).toEqual([]);
  });

  it('turns no javascript: URL into a link', () => {
    answer('[md](javascript:alert(1)) and <a href="javascript:alert(1)">html</a>');

    const hrefs = [...message().querySelectorAll('a')].map((link) => link.getAttribute('href') ?? '');
    expect(hrefs.filter((href) => href.trim().toLowerCase().startsWith('javascript:'))).toEqual([]);
  });
});

describe('links', () => {
  it('leaves a click on a link to VS Code, which opens it', () => {
    answer('See [the site](https://example.com/).');
    const link = message().querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/');

    let prevented: boolean | undefined;
    // VS Code listens for clicks on the webview's window and opens the link unless the page took the click.
    page.window.addEventListener('click', (event) => {
      prevented = event.defaultPrevented;
      event.preventDefault();
    });
    link?.dispatchEvent(new page.window.MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(prevented).toBe(false);
    expect(page.document.querySelector('[data-streamdown="link-safety-modal"]')).toBeNull();
  });

  it('copies a link to the clipboard from the button beside it', async () => {
    const copied: string[] = [];
    Object.defineProperty(page.window.navigator, 'clipboard', {
      value: { writeText: (text: string) => Promise.resolve(void copied.push(text)) },
    });
    answer('See [the site](https://example.com/).');

    message().querySelector<HTMLButtonElement>('button[aria-label="Copy link"]')?.click();
    await Promise.resolve();

    expect(copied).toEqual(['https://example.com/']);
  });

  it('offers no copy button for a link that is still being written', () => {
    answer('See [the site](https://exam');

    expect(message().querySelector('button[aria-label="Copy link"]')).toBeNull();
  });
});
