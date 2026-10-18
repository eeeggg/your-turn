import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { JSDOM, VirtualConsole, type DOMWindow } from 'jsdom';
import type { WebviewApi } from 'vscode-webview';
import { renderChatHtml } from '@/adapters/ChatHtml';
import type { ExtensionToWebviewMessage, SessionSnapshot, WebviewToExtensionMessage } from '@/shared/WebviewMessages';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const bundlePath = join(repoRoot, 'dist', 'webview', 'chat.js');
const sourceDir = join(repoRoot, 'src', 'webview');
const nonce = 'test-nonce';
const scriptUri = 'chat.js';

export interface ChatPage {
  readonly window: DOMWindow;
  readonly document: Document;
  /** Errors raised by the page's script, including uncaught exceptions in event handlers. */
  readonly errors: string[];
  /** Messages posted to the extension since the last call. */
  takePosted(): WebviewToExtensionMessage[];
  /** The value most recently passed to `setState`. */
  savedState(): unknown;
  /** Deliver a message from the extension. */
  send(message: ExtensionToWebviewMessage): void;
  /** Deliver a message that breaks the SDK's types but passes its runtime validation, so it can still reach the webview. */
  sendUnchecked(message: unknown): void;
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
  let posted: WebviewToExtensionMessage[] = [];
  let state = structuredClone(options.savedState);
  const api: WebviewApi<unknown> = {
    postMessage: (message) => posted.push(structuredClone(message as WebviewToExtensionMessage)),
    getState: () => structuredClone(state),
    setState: (next) => {
      state = structuredClone(next);
      return next;
    },
  };
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(error.stack ?? error.message));

  const dom = new JSDOM(inlined, {
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window) {
      // jsdom does not implement scrolling.
      window.Element.prototype.scrollIntoView = () => undefined;
      Object.assign(window, { acquireVsCodeApi: () => api });
    },
  });
  const { window } = dom;
  const { document } = window;

  const deliver = (message: unknown): void => {
    window.dispatchEvent(new window.MessageEvent('message', { data: structuredClone(message) }));
  };

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
    send: deliver,
    sendUnchecked: deliver,
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

export function sessionSnapshot(session: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: 's1',
    agentName: 'Fake Agent',
    cwd: '/work/project',
    modes: null,
    configOptions: null,
    availableCommands: [],
    ...session,
  };
}

/** Send a `state` message describing the active session, as the extension does on connect. */
export function connect(page: ChatPage, session: Partial<SessionSnapshot> = {}): void {
  const full = sessionSnapshot(session);
  page.send({ type: 'state', activeSessionId: full.sessionId, session: full });
}

type SessionUpdateKind = SessionUpdate['sessionUpdate'];

/** Send a `sessionUpdate` notification for the active session. */
export function update<K extends SessionUpdateKind>(
  page: ChatPage,
  sessionUpdate: K,
  fields: Omit<Extract<SessionUpdate, { sessionUpdate: K }>, 'sessionUpdate'>,
): void {
  page.send({ type: 'sessionUpdate', sessionId: 's1', update: { sessionUpdate, ...fields } as SessionUpdate });
}

export function textChunk(text: string): { content: { type: 'text'; text: string } } {
  return { content: { type: 'text', text } };
}
