import { beforeEach, describe, expect, it } from 'vitest';
import { answer as agentText, connect, loadChatPage, type ChatPage } from '@tests/webview/chatPage';

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
  const rasterUri = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

  function resolveDataImage(): Extract<ReturnType<ChatPage['takePosted']>[number], { type: 'resolveMarkdownImage' }> {
    expect(page.takePosted()).toEqual([{ type: 'markdownImageContext', sessionId: 's1' }]);
    page.send({ type: 'markdownImageContext', sessionId: 's1', context: 42 });
    const requests = page.takePosted();
    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (request?.type !== 'resolveMarkdownImage') { throw new Error('No image validation request'); }
    expect(request.source).toBe(rasterUri);
    expect(message().querySelector('img')).toBeNull();
    page.send({ type: 'markdownImage', context: 42, occurrence: request.occurrence, src: rasterUri });
    return request;
  }

  it('displays a Markdown data image only after core validation and retains it on append', () => {
    answer(`Before ![Tiny picture](${rasterUri}) after`);
    resolveDataImage();
    const image = message().querySelector('img');
    expect(image?.getAttribute('src')).toBe(rasterUri);
    expect(image?.getAttribute('alt')).toBe('Tiny picture');
    expect(message().textContent).toContain('Before');
    expect(message().textContent).toContain('after');
    agentText(page, ' appended');
    expect(message().querySelector('img')).toBe(image);
    expect(page.takePosted()).toEqual([]);
  });

  it('resolves a reference-style data image without exposing its source to the browser', () => {
    answer(`![Tiny picture][picture]\n\n[picture]: ${rasterUri}`);
    resolveDataImage();
    expect(message().querySelector('img')?.getAttribute('src')).toBe(rasterUri);
  });

  it('releases a removed image and ignores its late result', () => {
    page.send({ type: 'agentText', messageId: 'a1', text: `![Tiny picture](${rasterUri})` });
    const request = resolveDataImage();
    page.send({ type: 'agentMessage', messageId: 'a1', text: 'replacement' });
    expect(page.takePosted()).toContainEqual({ type: 'releaseMarkdownImage', context: 42, occurrence: request.occurrence });
    page.send({ type: 'markdownImage', context: 42, occurrence: request.occurrence, src: rasterUri });
    expect(message().querySelector('img')).toBeNull();
  });

  it('shows the alt text and core failure without creating an image', () => {
    answer(`![Broken picture](data:image/png;base64,AAAA)`);
    expect(page.takePosted()).toEqual([{ type: 'markdownImageContext', sessionId: 's1' }]);
    page.send({ type: 'markdownImageContext', sessionId: 's1', context: 42 });
    const request = page.takePosted()[0];
    if (request?.type !== 'resolveMarkdownImage') { throw new Error('No image validation request'); }
    page.send({ type: 'markdownImage', context: 42, occurrence: request.occurrence, src: null, fallback: 'Invalid image data' });
    expect(message().textContent).toContain('Broken picture');
    expect(message().textContent).toContain('Invalid image data');
    expect(message().querySelector('img')).toBeNull();
  });

  it('allocates separate slots for duplicate images in different Markdown blocks', () => {
    answer(`![First](${rasterUri})\n\n![Second](${rasterUri})`);
    expect(page.takePosted()).toEqual([{ type: 'markdownImageContext', sessionId: 's1' }]);
    page.send({ type: 'markdownImageContext', sessionId: 's1', context: 42 });
    const requests = page.takePosted();
    expect(requests).toHaveLength(2);
    const occurrences = requests.map((request) => {
      if (request.type !== 'resolveMarkdownImage') { throw new Error('No image validation request'); }
      page.send({ type: 'markdownImage', context: 42, occurrence: request.occurrence, src: rasterUri });
      return request.occurrence;
    });
    expect(new Set(occurrences).size).toBe(2);
    expect([...message().querySelectorAll('img')].map((image) => image.alt)).toEqual(['First', 'Second']);
  });

  it.each(['clear', 'replay', 'switch'] as const)('rejects a late result and creates new slots after %s', (change) => {
    answer(`![Tiny picture](${rasterUri})`);
    const original = resolveDataImage();
    if (change === 'clear') { page.send({ type: 'clearTranscript' }); connect(page); }
    else if (change === 'replay') { page.send({ type: 'loadSessionStart' }); }
    else {
      page.send({ type: 'state', activeSessionId: 'other', session: { sessionId: 'other', agentName: 'Other', cwd: '/other', pickers: [], commands: [] } });
      connect(page);
    }
    page.takePosted();
    answer(`![Tiny picture](${rasterUri})`);
    expect(page.takePosted()).toEqual([{ type: 'markdownImageContext', sessionId: 's1' }]);
    page.send({ type: 'markdownImage', context: 42, occurrence: original.occurrence, src: rasterUri });
    expect(message().querySelector('img')).toBeNull();
    page.send({ type: 'markdownImageContext', sessionId: 's1', context: 43 });
    const request = page.takePosted()[0];
    if (request?.type !== 'resolveMarkdownImage') { throw new Error('No fresh image validation request'); }
    expect(request.occurrence).not.toBe(original.occurrence);
    page.send({ type: 'markdownImage', context: 43, occurrence: request.occurrence, src: rasterUri });
    expect(message().querySelector('img')?.getAttribute('src')).toBe(rasterUri);
  });

  it('revalidates identical images when whole-message replacement recreates their content', () => {
    page.send({ type: 'agentText', messageId: 'a1', text: `![Tiny picture](${rasterUri})` });
    const original = resolveDataImage();
    page.send({ type: 'agentMessage', messageId: 'a1', text: `![Tiny picture](${rasterUri})` });
    const requests = page.takePosted();
    expect(requests).toContainEqual({ type: 'releaseMarkdownImage', context: 42, occurrence: original.occurrence });
    const fresh = requests.find((request) => request.type === 'resolveMarkdownImage');
    expect(fresh?.type === 'resolveMarkdownImage' && fresh.occurrence).not.toBe(original.occurrence);
    expect(fresh?.type).toBe('resolveMarkdownImage');
    expect(message().querySelector('img')).toBeNull();
  });

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

  it.each(['http://example.invalid/blocked.png', 'ftp://example.invalid/blocked.png'])('never creates an image request for Markdown source %s', (source) => {
    answer(`Before ![Blocked picture](${source}) after`);
    expect(message().querySelectorAll('img, source, picture, link')).toHaveLength(0);
    expect(message().textContent).toContain('Blocked picture');
    expect(message().textContent).toContain('not displayed');
    expect(page.takePosted()).toEqual([]);
  });

  it.each(['local extension host', 'remote extension host (ssh-remote)'])('asks per-occurrence HTTPS consent and explains the %s origin', (origin) => {
    const source = 'https://images.example/picture.gif?token=secret';
    answer(`Before ![Remote picture](${source}) after`);
    expect(page.takePosted()).toEqual([{ type: 'markdownImageContext', sessionId: 's1' }]);
    page.send({ type: 'markdownImageContext', sessionId: 's1', context: 42, origin });
    const request = page.takePosted()[0];
    if (request?.type !== 'resolveMarkdownImage') { throw new Error('No image occurrence'); }
    page.send({ type: 'markdownImage', context: 42, occurrence: request.occurrence, src: null, status: 'consent' });
    expect(message().textContent).toContain('images.example');
    expect(message().textContent).toContain(source);
    expect(message().textContent).toContain(origin);
    expect(message().textContent).toContain('redirect');
    expect(message().textContent).toContain('external server');
    expect(message().querySelector('img')).toBeNull();
    expect(page.takePosted()).toEqual([]);
    const load = [...message().querySelectorAll('button')].find((button) => button.textContent === 'Load image');
    expect(load).toBeDefined();
    load?.click();
    expect(page.takePosted()).toEqual([{ type: 'loadMarkdownImage', context: 42, occurrence: request.occurrence }]);
    page.send({ type: 'markdownImage', context: 42, occurrence: request.occurrence, src: rasterUri });
    expect(message().querySelector('img')?.getAttribute('src')).toBe(rasterUri);
    agentText(page, ' appended');
    expect(page.takePosted()).toEqual([]);
    expect(message().querySelector('img')?.getAttribute('src')).toBe(rasterUri);
  });

  it('automatically requests local images, retains validated bytes, and offers an explicit retry after failure', () => {
    answer('Before ![Local picture](./tiny.gif) after');
    expect(page.takePosted()).toEqual([{ type: 'markdownImageContext', sessionId: 's1' }]);
    page.send({ type: 'markdownImageContext', sessionId: 's1', context: 42 });
    const request = page.takePosted()[0];
    if (request?.type !== 'resolveMarkdownImage') { throw new Error('No local image request'); }
    expect(request.source).toBe('./tiny.gif');
    page.send({ type: 'markdownImage', context: 42, occurrence: request.occurrence, src: null, fallback: 'Could not read image file', status: 'retry' });
    expect(message().querySelector('img')).toBeNull();
    const retry = [...message().querySelectorAll('button')].find((button) => button.textContent === 'Retry');
    expect(retry).toBeDefined();
    retry?.click();
    expect(page.takePosted()).toEqual([{ type: 'loadMarkdownImage', context: 42, occurrence: request.occurrence }]);
    page.send({ type: 'markdownImage', context: 42, occurrence: request.occurrence, src: rasterUri });
    expect(message().querySelector('img')?.getAttribute('alt')).toBe('Local picture');
    agentText(page, ' appended');
    expect(page.takePosted()).toEqual([]);
  });

  it.each(['agentRichMessage', 'thoughtRichMessage', 'toolCall'] as const)('invalidates HTTPS consent on an identical %s content replacement', (surface) => {
    const text = '![Picture](https://images.example/picture.gif)';
    const send = () => {
      if (surface === 'toolCall') { page.send({ type: 'toolCall', toolCallId: 'image-tool', content: [{ kind: 'text', text }] }); }
      else { page.send({ type: surface, messageId: 'image-message', content: [{ kind: 'text', text }] }); }
    };
    send();
    if (surface === 'toolCall') { page.byId('tc-image-tool').querySelector('summary')?.click(); }
    expect(page.takePosted()).toEqual([{ type: 'markdownImageContext', sessionId: 's1' }]);
    page.send({ type: 'markdownImageContext', sessionId: 's1', context: 42 });
    const first = page.takePosted()[0];
    if (first?.type !== 'resolveMarkdownImage') { throw new Error('No first image occurrence'); }
    page.send({ type: 'markdownImage', context: 42, occurrence: first.occurrence, src: rasterUri });
    expect(page.document.querySelector('#messages img')).not.toBeNull();
    send();
    const requests = page.takePosted();
    expect(requests).toContainEqual({ type: 'releaseMarkdownImage', context: 42, occurrence: first.occurrence });
    const fresh = requests.find((request) => request.type === 'resolveMarkdownImage');
    expect(fresh?.type).toBe('resolveMarkdownImage');
    expect(fresh?.type === 'resolveMarkdownImage' && fresh.occurrence).not.toBe(first.occurrence);
    expect(page.document.querySelector('#messages img')).toBeNull();
  });

  it('keeps duplicate HTTPS approvals independent and ignores replies after the source changes', () => {
    page.send({ type: 'agentText', messageId: 'a1', text: '![One](https://images.example/a) ![Two](https://images.example/a)' });
    page.takePosted();
    page.send({ type: 'markdownImageContext', sessionId: 's1', context: 42, origin: 'remote extension host (ssh-remote)' });
    const requests = page.takePosted();
    const slots = requests.filter((request) => request.type === 'resolveMarkdownImage');
    expect(slots).toHaveLength(2);
    for (const slot of slots) { page.send({ type: 'markdownImage', context: 42, occurrence: slot.occurrence, src: null, status: 'consent' }); }
    const buttons = [...message().querySelectorAll('button')].filter((button) => button.textContent === 'Load image');
    buttons[0]?.click();
    expect(page.takePosted()).toEqual([{ type: 'loadMarkdownImage', context: 42, occurrence: slots[0]?.occurrence }]);
    expect([...message().querySelectorAll('button')].filter((button) => button.textContent === 'Load image')).toHaveLength(1);
    page.send({ type: 'agentMessage', messageId: 'a1', text: '![Replacement](https://other.example/b)' });
    const fresh = page.takePosted().find((request) => request.type === 'resolveMarkdownImage');
    for (const slot of slots) { page.send({ type: 'markdownImage', context: 42, occurrence: slot.occurrence, src: rasterUri }); }
    expect(message().querySelector('img')).toBeNull();
    if (fresh?.type !== 'resolveMarkdownImage') { throw new Error('No replacement image occurrence'); }
    page.send({ type: 'markdownImage', context: 42, occurrence: fresh.occurrence, src: null, status: 'consent' });
    expect(message().textContent).toContain('other.example');
    expect([...message().querySelectorAll('button')].find((button) => button.textContent === 'Load image')).toBeDefined();
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
