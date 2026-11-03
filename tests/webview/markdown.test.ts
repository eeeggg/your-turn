import { beforeEach, describe, expect, it } from 'vitest';
import { answer as agentText, connect, loadChatPage, type ChatPage } from './chatPage';

let page: ChatPage;

beforeEach(() => {
  page = loadChatPage();
  connect(page);
  page.takePosted();
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
    agentText(page, chunk);
  }
}

describe('markdown while it streams', () => {
  it('drops image payloads when replay replaces a transcript and when its session changes', () => {
    const src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
    page.send({ type: 'agentImage', messageId: 'm', src });
    expect(page.document.querySelectorAll('#messages img')).toHaveLength(1);
    page.send({ type: 'loadSessionStart' });
    expect(page.document.querySelectorAll('#messages img')).toHaveLength(0);
    page.send({ type: 'agentImage', messageId: 'm', src });
    page.send({ type: 'loadSessionEnd', ok: true });
    expect(page.document.querySelectorAll('#messages img')).toHaveLength(1);
    page.send({ type: 'state', activeSessionId: 'other', session: { sessionId: 'other', agentName: 'Other', cwd: '/other', pickers: [], commands: [] } });
    expect(page.document.querySelectorAll('#messages img')).toHaveLength(0);
  });

  it('replaces tool images and reference fallbacks without leaving old payloads', () => {
    const src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
    page.send({ type: 'toolCall', toolCallId: 't', content: [{ kind: 'image', src }, { kind: 'image', src: null, reference: true }] });
    expect(page.document.querySelectorAll('#messages img')).toHaveLength(1);
    expect(page.document.querySelector('#messages')?.textContent).toContain('Image reference not displayed');
    page.send({ type: 'toolCall', toolCallId: 't', status: 'completed' });
    expect(page.document.querySelectorAll('#messages img')).toHaveLength(1);
    page.send({ type: 'toolCall', toolCallId: 't', content: [] });
    expect(page.document.querySelectorAll('#messages img')).toHaveLength(0);
    expect(page.document.querySelector('#messages')?.textContent).not.toContain('Image reference not displayed');
  });

  it('keeps adjacent whole-message text as one Markdown span before an image', () => {
    page.send({ type: 'agentRichMessage', messageId: 'm1', content: [
      { kind: 'text', text: '**bo' }, { kind: 'text', text: 'ld**' }, { kind: 'image', src: null, fallback: 'Invalid image data' },
    ] });
    expect(bold()).toEqual(['bold']);
    expect(page.document.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Image from agent: Image not displayed: Invalid image data');
  });

  it.each(['https://example.invalid/blocked.png', 'http://example.invalid/blocked.png', './blocked.png', '/blocked.png', 'file:///blocked.png', 'data:image/png;base64,AAAA'])('never creates an image request for Markdown source %s', (source) => {
    answer(`Before ![Blocked picture](${source}) after`);
    expect(message().querySelectorAll('img, source, picture, link')).toHaveLength(0);
    expect(message().textContent).toContain('Blocked picture');
    expect(message().textContent).toContain('not displayed');
    expect(page.takePosted()).toEqual([]);
  });

  it('explains browser decoding failure and retries a replacement image', async () => {
    const src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
    page.send({ type: 'agentRichMessage', messageId: 'm1', content: [{ kind: 'image', src }] });
    const image = page.document.querySelector('#messages img');
    expect(image).not.toBeNull();
    const changed = new Promise<void>((resolve) => {
      const observer = new page.window.MutationObserver(() => {
        if (page.document.querySelector('#messages')?.textContent.includes('Image not displayed')) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(page.byId('messages'), { childList: true, subtree: true, characterData: true });
    });
    image?.dispatchEvent(new page.window.Event('error'));
    await changed;
    expect(page.document.querySelector('#messages')?.textContent).toContain('Image not displayed: browser could not render it');
    expect(page.document.querySelector('#messages img')).toBeNull();
    page.send({ type: 'agentRichMessage', messageId: 'm1', content: [{ kind: 'image', src: `${src}AAAA` }] });
    expect(page.document.querySelector('#messages img')?.getAttribute('src')).toBe(`${src}AAAA`);
  });

  it.each([
    ['thoughtRichMessage', 'thoughtText', 'thoughtMessage', 'thoughtImage'],
    ['promptRichMessage', 'promptText', 'promptMessage', 'promptImage'],
  ] as const)('replaces, appends and clears mixed %s content', (type, chunk, clear, image) => {
    const src = 'data:image/png;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
    page.send({ type: chunk, messageId: 'm1', text: 'obsolete' });
    page.send({ type: image, messageId: 'm1', src });
    page.send({ type, messageId: 'm1', content: [
      { kind: 'text', text: 'before' }, { kind: 'image', src }, { kind: 'text', text: 'after' },
    ] });
    page.send({ type: chunk, messageId: 'm1', text: ' appended' });
    const messages = page.document.querySelector('#messages');
    expect(messages?.querySelectorAll('img')).toHaveLength(1);
    expect(messages?.textContent).not.toContain('obsolete');
    expect(messages?.textContent).toContain('before');
    expect(messages?.textContent).toContain('after appended');
    page.send({ type: clear, messageId: 'm1', text: '' });
    expect(messages?.querySelectorAll('img')).toHaveLength(0);
    expect(messages?.textContent).not.toContain('before');
    expect(messages?.textContent).not.toContain('after');
  });

  it('renders a delivered agent image between surrounding text', () => {
    const src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR0YAAAAASUVORK5CYII=';
    answer('Before');
    page.send({ type: 'agentImage', messageId: null, src });
    agentText(page, 'After');

    const messages = page.document.querySelector('#messages');
    const image = messages?.querySelector('img');
    expect(image?.getAttribute('src')).toBe(src);
    expect(image?.getAttribute('alt')).toBe('Image from agent');
    expect(messages?.textContent).toContain('Before');
    expect(messages?.textContent).toContain('After');
    expect(image?.previousElementSibling?.textContent).toContain('Before');
    expect(image?.nextElementSibling?.textContent).toContain('After');
  });

  it('shows a readable fallback for an image reference', () => {
    page.send({ type: 'promptStart' });
    page.send({ type: 'agentImage', messageId: 'a1', src: null, reference: true });
    expect(page.document.querySelector('#messages')?.textContent).toContain('Image reference not displayed');
    expect(page.document.querySelector('#messages img')).toBeNull();
  });

  it('replaces streamed text and images with a whole message and clears them later', () => {
    const src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR0YAAAAASUVORK5CYII=';
    page.send({ type: 'promptStart' });
    page.send({ type: 'agentText', messageId: 'a1', text: 'old' });
    page.send({ type: 'agentImage', messageId: 'a1', src });
    page.send({ type: 'agentRichMessage', messageId: 'a1', content: [
      { kind: 'text', text: 'before' }, { kind: 'image', src }, { kind: 'text', text: 'after' },
    ] });
    const messages = page.document.querySelector('#messages');
    expect(messages?.querySelectorAll('img')).toHaveLength(1);
    expect(messages?.textContent).not.toContain('old');
    expect(messages?.textContent).toContain('before');
    expect(messages?.textContent).toContain('after');

    page.send({ type: 'agentMessage', messageId: 'a1', text: '' });
    expect(messages?.querySelectorAll('img')).toHaveLength(0);
    expect(messages?.textContent).not.toContain('before');
    expect(messages?.textContent).not.toContain('after');
  });

  it('shows images from a replayed prompt and an agent thought', () => {
    const src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR0YAAAAASUVORK5CYII=';
    page.send({ type: 'promptText', messageId: 'u1', text: 'Question' });
    page.send({ type: 'promptImage', messageId: 'u1', src });
    page.send({ type: 'thoughtText', messageId: 't1', text: 'Thinking' });
    page.send({ type: 'thoughtImage', messageId: 't1', src });

    expect(page.document.querySelector('img[alt="Image in user prompt"]')?.getAttribute('src')).toBe(src);
    expect(page.document.querySelector('img[alt="Image in agent thought"]')?.getAttribute('src')).toBe(src);
  });

  it('shows a tool-call image among its content', () => {
    const src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR0YAAAAASUVORK5CYII=';
    page.send({ type: 'promptStart' });
    page.send({ type: 'toolCall', toolCallId: 't1', title: 'Inspect', content: [
      { kind: 'text', text: 'before' }, { kind: 'image', src }, { kind: 'text', text: 'after' },
    ] });
    expect(page.document.querySelector('img[alt="Image in tool output"]')?.getAttribute('src')).toBe(src);
  });

  it('renders each chunk as it arrives, closing what is half-written', () => {
    answer('Some **bo');
    expect(bold()).toEqual(['bo']);

    agentText(page, 'ld** and `code`');
    expect(bold()).toEqual(['bold']);
    expect(message().querySelector('code')?.textContent).toBe('code');
  });

  it('asks the extension for nothing when the turn ends', () => {
    answer('**bold**');
    page.send({ type: 'promptEnd' });

    expect(page.takePosted()).toEqual([]);
    expect(bold()).toEqual(['bold']);
  });

  it("keeps a code block's controls disabled until its turn ends", () => {
    answer('```ts\nconst a = 1;\n```\n');
    const copy = () => message().querySelector<HTMLButtonElement>('[data-streamdown="code-block-copy-button"]');
    expect(copy()?.disabled).toBe(true);

    page.send({ type: 'promptEnd' });
    expect(copy()?.disabled).toBe(false);
  });
});

describe('what the agent cannot put on the page', () => {
  it('shows image descriptions without loading Markdown image sources', () => {
    answer('Before ![Sales chart](https://example.com/chart.png) and ![Local graph](./graph.png) after');

    expect(message().querySelectorAll('img')).toHaveLength(0);
    expect(message().textContent).toContain('Sales chart');
    expect(message().textContent).toContain('Local graph');
    expect(message().textContent).toContain('not displayed');
    expect(message().textContent).toContain('Before');
    expect(message().textContent).toContain('after');
  });

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
    let written: () => void = () => {};
    const clipboardWritten = new Promise<void>((resolve) => { written = resolve; });
    Object.defineProperty(page.window.navigator, 'clipboard', {
      value: { writeText: async (text: string) => { copied.push(text); written(); } },
    });
    answer('See [the site](https://example.com/).');

    const copy = message().querySelector<HTMLButtonElement>('button[aria-label="Copy link"]');
    expect(copy).not.toBeNull();
    copy?.click();
    await clipboardWritten;

    expect(copied).toEqual(['https://example.com/']);
  });

  it('offers no copy button for a link that is still being written', () => {
    answer('See [the site](https://exam');

    expect(message().querySelector('button[aria-label="Copy link"]')).toBeNull();
  });
});
