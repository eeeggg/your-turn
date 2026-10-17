import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole, type DOMWindow } from 'jsdom';
import { renderChatHtml } from '../../src/ui/ChatHtml';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const bundlePath = join(repoRoot, 'dist', 'webview', 'chat.js');
const sourceDir = join(repoRoot, 'src', 'webview');
const nonce = 'test-nonce';
const scriptUri = 'chat.js';

export type PostedMessage = { type: string } & Record<string, unknown>;

export interface ChatPage {
  readonly window: DOMWindow;
  readonly document: Document;
  /** Errors raised by the page's script, including uncaught exceptions in event handlers. */
  readonly errors: string[];
  /** Messages posted to the extension host since the last call. */
  takePosted(): PostedMessage[];
  /** The value most recently passed to `setState`. */
  savedState(): unknown;
  /** Deliver a message from the extension host. */
  send(message: object): void;
  byId<T extends HTMLElement = HTMLElement>(id: string): T;
  typePrompt(text: string): void;
  pressKey(key: string, init?: KeyboardEventInit): void;
  close(): void;
}

let bundle: string | undefined;

/** The compiled webview script, refusing to run against a build older than its sources. */
function readBundle(): string {
  if (bundle !== undefined) {
    return bundle;
  }
  const builtAt = statSync(bundlePath, { throwIfNoEntry: false })?.mtimeMs;
  if (builtAt === undefined) {
    throw new Error(`${bundlePath} is missing; run \`npm run compile\` first.`);
  }
  for (const file of readdirSync(sourceDir, { recursive: true, encoding: 'utf8' })) {
    if (statSync(join(sourceDir, file)).mtimeMs > builtAt) {
      throw new Error(`${bundlePath} is older than src/webview/${file}; run \`npm run compile\` first.`);
    }
  }
  bundle = readFileSync(bundlePath, 'utf8');
  return bundle;
}

/**
 * Load the chat webview into a fresh jsdom window: the production HTML from
 * `renderChatHtml`, with the compiled bundle inlined where the webview would
 * load it, and a fake `acquireVsCodeApi`.
 */
export function loadChatPage(options: { savedState?: unknown } = {}): ChatPage {
  const scriptTag = `<script nonce="${nonce}" src="${scriptUri}"></script>`;
  const html = renderChatHtml({ cspSource: 'test-csp', nonce, styleUri: 'chat.css', scriptUri });
  if (!html.includes(scriptTag)) {
    throw new Error('renderChatHtml no longer emits the expected script tag');
  }
  // A replacer function inserts the bundle verbatim; a replacement string would expand `$&`-style patterns in it.
  const inlined = html.replace(scriptTag, () => `<script nonce="${nonce}">${readBundle()}</script>`);

  // VS Code serializes everything crossing the webview boundary; cloning keeps
  // the page and the test from sharing objects.
  let posted: PostedMessage[] = [];
  let state = structuredClone(options.savedState);
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(error.stack ?? error.message));

  const dom = new JSDOM(inlined, {
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window) {
      // jsdom does not implement scrolling.
      window.Element.prototype.scrollIntoView = () => undefined;
      Object.assign(window, {
        acquireVsCodeApi: () => ({
          postMessage: (message: PostedMessage) => posted.push(structuredClone(message)),
          getState: () => structuredClone(state),
          setState: (next: unknown) => {
            state = structuredClone(next);
          },
        }),
      });
    },
  });
  const { window } = dom;
  const { document } = window;

  const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) {
      throw new Error(`#${id} not found`);
    }
    return el as T;
  };

  return {
    window,
    document,
    errors,
    takePosted() {
      const taken = posted;
      posted = [];
      return taken;
    },
    savedState: () => state,
    send(message) {
      window.dispatchEvent(new window.MessageEvent('message', { data: structuredClone(message) }));
    },
    byId,
    typePrompt(text) {
      const input = byId<HTMLTextAreaElement>('promptInput');
      input.value = text;
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    },
    pressKey(key, init = {}) {
      byId('promptInput').dispatchEvent(
        new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
      );
    },
    close: () => window.close(),
  };
}

export interface SessionFixture {
  agentName?: string;
  title?: string | null;
  cwd?: string;
  configOptions?: unknown[];
  modes?: unknown;
  availableCommands?: unknown[];
}

/** Send a `state` message describing a connected session, as the host does on connect. */
export function connect(page: ChatPage, session: SessionFixture = {}): void {
  page.send({
    type: 'state',
    activeSessionId: 's1',
    session: { sessionId: 's1', agentName: 'Fake Agent', cwd: '/work/project', ...session },
  });
}

/** Send a `sessionUpdate` notification for the active session. */
export function update(page: ChatPage, sessionUpdate: string, fields: object = {}): void {
  page.send({ type: 'sessionUpdate', sessionId: 's1', update: { sessionUpdate, ...fields } });
}

export function textChunk(text: string): { content: { type: 'text'; text: string } } {
  return { content: { type: 'text', text } };
}
