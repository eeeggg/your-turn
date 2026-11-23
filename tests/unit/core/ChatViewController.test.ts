import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import type { ConfigOption, Modes, SessionUpdate } from '@/core/acp/AcpDriver';
import { ChatViewController } from '@/core/ChatViewController';
import { Cleaner } from '@/core/CommandOutput';
import { setLogSink } from '@/core/Log';
import { ElicitationRequests } from '@/core/ElicitationRequests';
import { Reviews } from '@/core/review/Reviews';
import type { SessionInfo } from '@/core/sessions/Manager';
import type { ExtensionToWebviewMessage, Picker } from '@/shared/WebviewMessages';
import {
  SESSION_ID,
  OTHER_SESSION_ID,
  deferred,
  modelOption,
  sessionInfo,
  setup,
  sendPrompt,
  issuedTarget,
  contentSnapshots,
  questionSnapshots,
  type FakeEnvironment,
  type FakeSessions,
} from '@tests/unit/core/ChatViewControllerTestSupport';

/** {@link modelOption} as the webview gets it. */
const modelPicker: Picker = {
  id: 'model',
  category: 'model',
  name: 'Model',
  description: null,
  current: 'a',
  groups: [{ header: null, values: [{ id: 'a', name: 'Model A', description: null }, { id: 'b', name: 'Model B', description: 'The big one' }] }],
};

const modes: Modes = {
  current: 'ask',
  available: [{ id: 'ask', name: 'Ask', description: 'Asks first' }, { id: 'code', name: 'Code', description: null }],
};

/** {@link modes} as the webview gets it. */
const modePicker: Picker = {
  id: 'mode',
  category: 'mode',
  name: 'Mode',
  description: null,
  current: 'ask',
  groups: [{ header: null, values: [{ id: 'ask', name: 'Ask', description: 'Asks first' }, { id: 'code', name: 'Code', description: null }] }],
};

const toolCall: SessionUpdate = { kind: 'toolCall', toolCallId: 't1', title: 'Read' };

describe('ChatViewController', () => {
  const rasterUri = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

  async function imageContext(controller: ChatViewController, environment: FakeEnvironment, sessions: FakeSessions): Promise<number> {
    if (sessions.session) { sessions.retained.attach(sessions.session); }
    await controller.handleMessage({ type: 'ready' });
    const target = contentSnapshots(environment.take()).at(-1)?.target;
    if (!target) { throw new Error('Missing Markdown projection'); }
    await controller.handleMessage({ type: 'markdownImageContext', target });
    const response = environment.take().find((message) => message.type === 'markdownImageContext');
    if (response?.type !== 'markdownImageContext') { throw new Error('No Markdown image context'); }
    return response.context;
  }

  it('validates Markdown raster data URIs in the displayed session', async () => {
    const { controller, environment, sessions } = setup();
    const context = await imageContext(controller, environment, sessions);
    await controller.handleMessage({ type: 'resolveMarkdownImage', context, occurrence: 1, source: rasterUri });
    expect(environment.take()).toEqual([{ type: 'markdownImage', context, occurrence: 1, src: rasterUri }]);
  });

  it('never downloads HTTPS before occurrence consent, retries only explicitly, and validates MIME bytes', async () => {
    let requests = 0;
    const { controller, environment, sessions } = setup({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: async () => {
        requests++;
        return { status: 200, headers: { 'content-type': requests === 1 ? 'image/png' : 'image/gif' },
          body: Readable.from([Buffer.from(rasterUri.split(',')[1] ?? '', 'base64')]) };
      },
    });
    const context = await imageContext(controller, environment, sessions);
    await controller.handleMessage({ type: 'resolveMarkdownImage', context, occurrence: 1, source: 'https://images.example/a?secret=token' });
    expect(requests).toBe(0);
    expect(environment.take()).toEqual([{ type: 'markdownImage', context, occurrence: 1, src: null, status: 'consent' }]);
    await controller.handleMessage({ type: 'loadMarkdownImage', context, occurrence: 1 });
    expect(requests).toBe(1);
    expect(environment.take()).toEqual([
      { type: 'markdownImage', context, occurrence: 1, src: null, status: 'loading' },
      { type: 'markdownImage', context, occurrence: 1, src: null, fallback: 'Image MIME type does not match its bytes', status: 'retry' },
    ]);
    await controller.handleMessage({ type: 'loadMarkdownImage', context, occurrence: 1 });
    expect(requests).toBe(2);
    expect(environment.take()).toEqual([
      { type: 'markdownImage', context, occurrence: 1, src: null, status: 'loading' },
      { type: 'markdownImage', context, occurrence: 1, src: rasterUri },
    ]);
    await controller.handleMessage({ type: 'loadMarkdownImage', context, occurrence: 1 });
    expect(requests).toBe(2);
    expect(environment.take()).toEqual([]);
    await controller.handleMessage({ type: 'resolveMarkdownImage', context, occurrence: 2, source: 'https://images.example/a?secret=token' });
    expect(requests).toBe(2);
    expect(environment.take()).toEqual([{ type: 'markdownImage', context, occurrence: 2, src: null, status: 'consent' }]);
  });

  it.each(['remove', 'clear', 'switch', 'close'] as const)('cancels an approved download on %s and rejects its late result', async (change) => {
    const reply = deferred<{ status: number; headers: Record<string, string>; body: Readable }>();
    const started = deferred<AbortSignal>();
    const { controller, environment, sessions } = setup({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: (_url, _address, signal) => { started.resolve(signal); return reply.promise; },
    });
    const context = await imageContext(controller, environment, sessions);
    await controller.handleMessage({ type: 'resolveMarkdownImage', context, occurrence: 1, source: 'https://images.example/a' });
    const loading = controller.handleMessage({ type: 'loadMarkdownImage', context, occurrence: 1 });
    const signal = await started.promise;
    if (change === 'remove') { await controller.handleMessage({ type: 'releaseMarkdownImage', context, occurrence: 1 }); }
    else if (change === 'clear') { controller.clearTranscript(); }
    else if (change === 'close') { controller.notifySessionRemoved(sessions.requireSession()); }
    else { sessions.activeId = OTHER_SESSION_ID; sessions.session = sessionInfo({ sessionId: OTHER_SESSION_ID }); controller.notifyActiveSessionChanged(); }
    expect(signal.aborted).toBe(true);
    environment.take();
    reply.resolve({ status: 200, headers: { 'content-type': 'image/gif' }, body: Readable.from([Buffer.from(rasterUri.split(',')[1] ?? '', 'base64')]) });
    await loading;
    expect(environment.take()).toEqual([]);
  });

  it.each(['other configuration', 'replacement connection'] as const)('keeps image reads on their registration across an equal-ID %s', async (change) => {
    const reply = deferred<{ status: number; headers: Record<string, string>; body: Readable }>();
    const started = deferred<AbortSignal>();
    const { controller, environment, sessions } = setup({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: (_url, _address, signal) => { started.resolve(signal); return reply.promise; },
    });
    const context = await imageContext(controller, environment, sessions);
    await controller.handleMessage({ type: 'resolveMarkdownImage', context, occurrence: 1, source: 'https://images.example/a' });
    const loading = controller.handleMessage({ type: 'loadMarkdownImage', context, occurrence: 1 });
    const signal = await started.promise;
    try {
      const replacement = sessionInfo({ agentName: change === 'other configuration' ? 'other' : 'fake', agentId: 'replacement' });
      controller.notifySessionRemoved(replacement);
      expect(signal.aborted).toBe(false);
      environment.take();
      // The result can settle after the manager changes selection and before the controller receives notice.
      sessions.session = replacement;
      const target = environment.transcript().projection?.target;
      if (!target) { throw new Error('Missing preceding projection'); }
      await controller.handleMessage({ type: 'markdownImageContext', target });
      expect(environment.take()).toEqual([]);
    } finally {
      reply.resolve({ status: 200, headers: { 'content-type': 'image/gif' }, body: Readable.from([Buffer.from(rasterUri.split(',')[1] ?? '', 'base64')]) });
      await loading;
    }
    expect(environment.take()).toEqual([]);
    controller.notifyActiveSessionChanged();
    environment.take();
    await controller.handleMessage({ type: 'resolveMarkdownImage', context, occurrence: 2, source: rasterUri });
    expect(environment.take()).toEqual([]);
    const fresh = await imageContext(controller, environment, sessions);
    expect(fresh).not.toBe(context);
    await controller.handleMessage({ type: 'resolveMarkdownImage', context: fresh, occurrence: 2, source: rasterUri });
    expect(environment.take()).toEqual([{ type: 'markdownImage', context: fresh, occurrence: 2, src: rasterUri }]);
  });

  it('charges asynchronous images in completion order without evicting native images', async () => {
    const first = deferred<{ status: number; headers: Record<string, string>; body: Readable }>();
    const started = deferred<undefined>();
    const header = Buffer.from(rasterUri.split(',')[1] ?? '', 'base64');
    const bytes = Buffer.concat([header, Buffer.alloc(10 * 1024 * 1024 - header.length)]);
    const data = bytes.toString('base64');
    const { controller, environment, sessions } = setup({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: async (url) => {
        if (url.pathname === '/first') { started.resolve(undefined); return first.promise; }
        return { status: 200, headers: { 'content-type': 'image/gif' }, body: Readable.from([bytes]) };
      },
    });
    const context = await imageContext(controller, environment, sessions);
    for (let index = 0; index < 4; index++) {
      controller.handleSessionUpdate(SESSION_ID, { kind: 'agentImage', messageId: `native-${index}`, data, mimeType: 'image/gif' });
    }
    for (const occurrence of [1, 2]) {
      await controller.handleMessage({ type: 'resolveMarkdownImage', context, occurrence, source: `https://images.example/${occurrence === 1 ? 'first' : 'second'}` });
    }
    const pending = controller.handleMessage({ type: 'loadMarkdownImage', context, occurrence: 1 });
    await started.promise;
    environment.take();
    await controller.handleMessage({ type: 'loadMarkdownImage', context, occurrence: 2 });
    expect(environment.take()).toEqual([
      { type: 'markdownImage', context, occurrence: 2, src: null, status: 'loading' },
      { type: 'markdownImage', context, occurrence: 2, src: `data:image/gif;base64,${data}` },
    ]);
    first.resolve({ status: 200, headers: { 'content-type': 'image/gif' }, body: Readable.from([bytes]) });
    await pending;
    expect(environment.take()).toEqual([{ type: 'markdownImage', context, occurrence: 1, src: null, fallback: 'Session image budget exceeded', status: 'retry' }]);
  });

  async function localImages() {
    const directory = await mkdtemp(join(tmpdir(), 'transcript-images-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const root = join(directory, 'session');
    await mkdir(root);
    const bytes = Buffer.from(rasterUri.split(',')[1] ?? '', 'base64');
    await writeFile(join(root, 'tiny.gif'), bytes);
    await writeFile(join(directory, 'outside.gif'), bytes);
    const state = setup();
    state.sessions.session = sessionInfo({ cwd: root });
    const context = await imageContext(state.controller, state.environment, state.sessions);
    return { ...state, root, directory, bytes, context };
  }

  it('creates its local-image fixture directly in the system temporary directory', async () => {
    const { directory } = await localImages();
    expect(dirname(directory)).toBe(tmpdir());
  });

  it.each(['relative', 'absolute', 'file URL', 'symlink'] as const)('automatically reads a contained %s raster on the session filesystem', async (syntax) => {
    const { controller, environment, root, context } = await localImages();
    await symlink('tiny.gif', join(root, 'alias.gif'));
    const source = syntax === 'relative' ? './tiny.gif' : syntax === 'absolute' ? join(root, 'tiny.gif')
      : syntax === 'file URL' ? pathToFileURL(join(root, 'tiny.gif')).href : 'alias.gif';
    await controller.handleMessage({ type: 'resolveMarkdownImage', context, occurrence: 1, source });
    expect(environment.take()).toEqual([{ type: 'markdownImage', context, occurrence: 1, src: rasterUri }]);
  });

  it.each(['traversal', 'absolute', 'symlink', 'directory', 'missing', 'SVG', 'oversized'] as const)('blocks a local %s image', async (kind) => {
    const { controller, environment, root, directory, context } = await localImages();
    await symlink('../outside.gif', join(root, 'escape.gif'));
    await writeFile(join(root, 'unsupported.gif'), '<svg/>');
    await writeFile(join(root, 'large.gif'), Buffer.alloc(10 * 1024 * 1024 + 1));
    const source = { traversal: '../outside.gif', absolute: join(directory, 'outside.gif'), symlink: 'escape.gif',
      directory: '.', missing: 'missing.gif', SVG: 'unsupported.gif', oversized: 'large.gif' }[kind];
    await controller.handleMessage({ type: 'resolveMarkdownImage', context, occurrence: 1, source });
    const response = environment.take();
    expect(response).toHaveLength(1);
    expect(response[0]).toMatchObject({ type: 'markdownImage', context, occurrence: 1, src: null });
    expect(response[0]).toHaveProperty('fallback', expect.stringMatching(/outside|regular|read|format|large/i));
  });

  it('retains local bytes without rereading until an occurrence is explicitly recreated', async () => {
    const { controller, environment, root, context } = await localImages();
    await controller.handleMessage({ type: 'resolveMarkdownImage', context, occurrence: 1, source: 'tiny.gif' });
    expect(environment.take()).toEqual([{ type: 'markdownImage', context, occurrence: 1, src: rasterUri }]);
    await rm(join(root, 'tiny.gif'));
    await controller.handleMessage({ type: 'resolveMarkdownImage', context, occurrence: 1, source: 'tiny.gif' });
    expect(environment.take()).toEqual([]);
    await controller.handleMessage({ type: 'releaseMarkdownImage', context, occurrence: 1 });
    await controller.handleMessage({ type: 'resolveMarkdownImage', context, occurrence: 2, source: 'tiny.gif' });
    expect(environment.take()).toEqual([{ type: 'markdownImage', context, occurrence: 2, src: null, fallback: 'Could not read image file', status: 'retry' }]);
  });

  it.each([
    ['data:image/png;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'Image MIME type does not match its bytes'],
    ['data:image/gif;base64,AA!A', 'Invalid image data'],
    ['data:image/svg+xml;base64,PHN2Zy8+', 'Unsupported image format'],
    ['data:image/gif,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'Invalid image data URI'],
    ['http://example.invalid/image.png', 'Image source not supported'],
  ])('rejects unsupported or invalid Markdown source %s', async (source, fallback) => {
    const { controller, environment, sessions } = setup();
    const context = await imageContext(controller, environment, sessions);
    await controller.handleMessage({ type: 'resolveMarkdownImage', context, occurrence: 1, source });
    expect(environment.take()).toEqual([{ type: 'markdownImage', context, occurrence: 1, src: null, fallback }]);
  });

  it('binds each Markdown occurrence to its source until released', async () => {
    const { controller, environment, sessions } = setup();
    const context = await imageContext(controller, environment, sessions);
    await controller.handleMessage({ type: 'resolveMarkdownImage', context, occurrence: 1, source: rasterUri });
    environment.take();
    await controller.handleMessage({ type: 'resolveMarkdownImage', context, occurrence: 1, source: 'data:image/gif;base64,AAAA' });
    expect(environment.take()).toEqual([]);
    await controller.handleMessage({ type: 'releaseMarkdownImage', context, occurrence: 1 });
    await controller.handleMessage({ type: 'resolveMarkdownImage', context, occurrence: 2, source: rasterUri });
    expect(environment.take()).toEqual([{ type: 'markdownImage', context, occurrence: 2, src: rasterUri }]);
  });

  it.each(['clear', 'replay', 'switch'] as const)('rejects obsolete Markdown requests after %s', async (change) => {
    const { controller, environment, sessions } = setup();
    controller.notifyActiveSessionChanged();
    environment.take();
    const context = await imageContext(controller, environment, sessions);
    if (change === 'clear') { controller.clearTranscript(); }
    else if (change === 'replay') { controller.notifyLoadSessionStart(SESSION_ID); }
    else {
      sessions.activeId = OTHER_SESSION_ID;
      sessions.session = sessionInfo({ sessionId: OTHER_SESSION_ID });
      controller.notifyActiveSessionChanged();
      sessions.activeId = SESSION_ID;
      sessions.session = sessionInfo();
      controller.notifyActiveSessionChanged();
    }
    environment.take();
    await controller.handleMessage({ type: 'resolveMarkdownImage', context, occurrence: 1, source: rasterUri });
    expect(environment.take()).toEqual([]);
    const fresh = await imageContext(controller, environment, sessions);
    expect(fresh).not.toBe(context);
    await controller.handleMessage({ type: 'resolveMarkdownImage', context: fresh, occurrence: 1, source: rasterUri });
    expect(environment.take()).toEqual([{ type: 'markdownImage', context: fresh, occurrence: 1, src: rasterUri }]);
  });

  it('does not give a background session a Markdown image context', async () => {
    const { controller, environment } = setup();
    await controller.handleMessage({ type: 'markdownImageContext', target: { configuredName: 'fake', sessionId: 'other', generation: 1, projection: 1 } });
    expect(environment.take()).toEqual([]);
  });

  it('rejects a Markdown context request captured before page recreation', async () => {
    const parts = setup();
    const target = await issuedTarget(parts);
    await parts.controller.handleMessage({ type: 'ready' });
    parts.environment.take();
    const request = { type: 'markdownImageContext' as const, target };

    await parts.controller.handleMessage(request);

    expect(parts.environment.take()).toEqual([]);
  });

  it('starts a new consent lifetime when the webview is recreated', async () => {
    const { controller, environment, sessions } = setup();
    const context = await imageContext(controller, environment, sessions);
    await controller.handleMessage({ type: 'resolveMarkdownImage', context, occurrence: 1, source: rasterUri });
    await controller.handleMessage({ type: 'ready' });
    environment.take();
    const fresh = await imageContext(controller, environment, sessions);
    expect(fresh).not.toBe(context);
    await controller.handleMessage({ type: 'resolveMarkdownImage', context: fresh, occurrence: 1, source: rasterUri });
    expect(environment.take()).toEqual([{ type: 'markdownImage', context: fresh, occurrence: 1, src: rasterUri }]);
  });

  it('shares native and Markdown budgets without charging an unchanged occurrence twice', async () => {
    const { controller, environment, sessions } = setup();
    const header = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
    const data = Buffer.concat([header, Buffer.alloc(10 * 1024 * 1024 - header.length)]).toString('base64');
    const source = `data:image/gif;base64,${data}`;
    const context = await imageContext(controller, environment, sessions);
    await controller.handleMessage({ type: 'resolveMarkdownImage', context, occurrence: 1, source });
    expect(environment.take()).toEqual([{ type: 'markdownImage', context, occurrence: 1, src: source }]);
    await controller.handleMessage({ type: 'resolveMarkdownImage', context, occurrence: 1, source });
    expect(environment.take()).toEqual([]);
    for (let index = 0; index < 4; index++) {
      controller.handleSessionUpdate(SESSION_ID, { kind: 'agentImage', messageId: `native-${index}`, data, mimeType: 'image/gif' });
      expect(environment.parts().at(-1)).toEqual({ kind: 'image', messageId: `native-${index}`, src: source });
      environment.take();
    }
    await controller.handleMessage({ type: 'resolveMarkdownImage', context, occurrence: 2, source: rasterUri });
    expect(environment.take()).toEqual([{ type: 'markdownImage', context, occurrence: 2, src: null, fallback: 'Session image budget exceeded' }]);
    await controller.handleMessage({ type: 'releaseMarkdownImage', context, occurrence: 1 });
    await controller.handleMessage({ type: 'resolveMarkdownImage', context, occurrence: 3, source: rasterUri });
    expect(environment.take()).toEqual([{ type: 'markdownImage', context, occurrence: 3, src: rasterUri }]);
  });

  it('routes opaque tab requests to session commands without changing content', async () => {
    const { controller, environment } = setup();
    const requests: string[] = [];
    controller.setTabNavigation({
      selectTab: async (id) => { requests.push(`select:${id}`); },
      closeTab: async (id) => { requests.push(`close:${id}`); },
    });
    await controller.handleMessage({ type: 'selectSessionTab', tabId: 'opaque-one' });
    await controller.handleMessage({ type: 'closeSessionTab', tabId: 'opaque-two' });
    expect(requests).toEqual(['select:opaque-one', 'close:opaque-two']);
    expect(environment.take()).toEqual([]);
  });
  it('projects background review markers and clears both tabs when their shared file is kept', async () => {
    const { controller, sessions, environment } = setup();
    const reviews = new Reviews({ read: async () => 'new', watch: () => ({ dispose() {} }), snapshot: () => undefined,
      restore: async () => {}, applyEdit: async () => false, save: async () => {},
    }, { resolutionBlocked: () => false, onChanged: () => () => {},
      runDecision: async (action) => ({ kind: 'completed', value: await action(() => true) }),
    });
    onTestFinished(() => reviews.dispose());
    controller.setTabReviews(reviews);
    const first = sessionInfo();
    const second = sessionInfo({ sessionId: OTHER_SESSION_ID });
    controller.sessionTabs.open(first);
    controller.sessionTabs.open(second);
    sessions.session = second;
    sessions.activeId = second.sessionId;
    reviews.activeSessionChanged(second);
    for (const registration of [first, second]) {
      await reviews.handleSessionUpdate({ schema: 'v1', origin: { sourceId: registration.agentId,
        identity: { configuredName: registration.agentName, sessionId: registration.sessionId } },
        update: { kind: 'toolCall', toolCallId: 'edit', status: 'completed', content: [{ kind: 'diff',
          diff: { kind: 'wholeFile', path: '/work/project/file.ts', oldText: 'old', newText: 'new' } }] },
      });
    }
    const tabMessages = () => environment.take().filter((message) => message.type === 'sessionTabs');
    expect(tabMessages().at(-1)).toMatchObject({ selectedTabId: 'tab-2', tabs: [
      { review: { modified: true, created: false, deleted: false } }, { review: { modified: true, created: false, deleted: false } },
    ] });
    const keep = reviews.captureDecision({ action: 'keep-all' });
    if (!keep) { throw new Error('Missing decision'); }
    expect(await reviews.decide(keep)).toMatchObject({ kind: 'applied' });
    expect(tabMessages().at(-1)).toMatchObject({ selectedTabId: 'tab-2', tabs: [
      { review: { modified: false, created: false, deleted: false } }, { review: { modified: false, created: false, deleted: false } },
    ] });
  });

  it('commits tabs only on successful opens and re-sends the complete navigation on readiness', async () => {
    const { controller, sessions, environment } = setup();
    controller.notifyActiveSessionChanged();
    expect(environment.take().filter((message) => message.type === 'sessionTabs')).toEqual([]);
    controller.notifySessionOpened(sessions.requireSession());
    const first = environment.take();
    const snapshot = first.find((message) => message.type === 'sessionTabs');
    expect(snapshot).toEqual({ type: 'sessionTabs', selectedTabId: 'tab-1', tabs: [
      { tabId: 'tab-1', title: null, agentName: 'Fake Agent', cwd: '/work/project', additionalDirectories: ['/other'], status: 'quiet',
        review: { modified: false, created: false, deleted: false } },
    ] });
    if (snapshot?.type !== 'sessionTabs') { throw new Error('missing tab snapshot'); }
    expect(snapshot.selectedTabId).toBe(snapshot.tabs[0]?.tabId);

    sessions.session = sessionInfo({ sessionId: OTHER_SESSION_ID, title: 'Second' });
    sessions.activeId = OTHER_SESSION_ID;
    controller.notifyActiveSessionChanged();
    controller.notifyLoadSessionEnd(false);
    expect(environment.take().filter((message) => message.type === 'sessionTabs')).toEqual([]);
    await controller.handleMessage({ type: 'ready' });
    const ready = environment.take();
    expect(ready.map((message) => message.type)).toEqual(['viewSnapshot']);
    expect(ready[0]?.type === 'viewSnapshot' && ready[0].tabs).toEqual({ selectedTabId: snapshot.selectedTabId, tabs: snapshot.tabs });

    controller.notifySessionOpened(sessions.requireSession());
    const second = environment.take().find((message) => message.type === 'sessionTabs');
    expect(second?.type === 'sessionTabs' && second.tabs).toEqual([
      snapshot.tabs[0],
      { tabId: 'tab-2', title: 'Second', agentName: 'Fake Agent', cwd: '/work/project', additionalDirectories: ['/other'], status: 'quiet',
        review: { modified: false, created: false, deleted: false } },
    ]);
    controller.notifySessionOpened(sessions.requireSession());
    expect(environment.take()).toEqual([second]);
  });

  it('does not select a replacement from an obsolete open notification', () => {
    const { controller, sessions, environment } = setup();
    const first = sessionInfo({ sessionId: OTHER_SESSION_ID });
    controller.sessionTabs.open(first);
    const obsolete = sessionInfo({ agentId: 'old-source' });
    sessions.session = sessionInfo({ agentId: 'replacement-source' });

    controller.notifySessionOpened(obsolete);

    expect(controller.sessionTabs.snapshot()).toMatchObject({ selectedTabId: 'tab-1', tabs: [{ sessionId: OTHER_SESSION_ID }] });
    expect(environment.take()).toEqual([]);
  });

  it('publishes a listed title for the existing tab without replacing its transcript', () => {
    const { controller, sessions, environment } = setup();
    controller.notifySessionOpened(sessions.requireSession());
    const initial = environment.take().find((message) => message.type === 'sessionTabs');
    if (!initial) { throw new Error('missing tab snapshot'); }

    controller.sessionTabs.updateListedTitles('fake', new Map([[SESSION_ID, 'Listed title']]));

    expect(environment.take()).toEqual([{ ...initial, tabs: initial.tabs.map((tab) => ({ ...tab, title: 'Listed title' })) }]);
  });

  it('updates tab labels and foreground indicators without creating content or prompt boundaries', async () => {
    const { controller, sessions, environment } = setup();
    controller.notifySessionOpened(sessions.requireSession());
    const initial = environment.take().find((message) => message.type === 'sessionTabs');
    if (initial?.type !== 'sessionTabs') { throw new Error('missing tab snapshot'); }
    const tab = initial.tabs[0];
    controller.handleSessionUpdate(SESSION_ID, { kind: 'sessionInfo', title: 'Renamed' });
    expect(environment.take().filter((message) => message.type === 'sessionTabs')).toEqual([
      { ...initial, tabs: [{ ...tab, title: 'Renamed' }] },
    ]);
    controller.handleSessionUpdate(SESSION_ID, { kind: 'sessionInfo', title: null });
    environment.take();
    controller.handleSessionUpdate(SESSION_ID, { kind: 'foreground', state: 'running' });
    expect(environment.take().filter((message) => message.type === 'sessionTabs')).toEqual([
      { ...initial, tabs: [{ ...tab, status: 'working' }] },
    ]);
    const turn = sendPrompt(controller, sessions, 'steering');
    const registration = sessions.session;
    if (!registration) { throw new Error('Missing registration'); }
    const identity = { configuredName: registration.agentName, sessionId: SESSION_ID };
    const state = sessions.sessionState(identity);
    const head = state?.queue[0];
    if (!head) { throw new Error('Missing steering head'); }
    sessions.changeQueuedPrompt(identity, state.generation, { kind: 'steer', id: head.id });
    environment.take();
    sessions.fail(new Error('Rejected'));
    await turn;
    const result = sessions.sendPrompt.mock.results.at(-1);
    if (result?.type !== 'return') { throw new Error('Missing steering result'); }
    await result.value.catch(() => {});
    expect(controller.hasRunningTurn).toBe(true);
    expect(environment.take().some((message) => message.type === 'promptEnd')).toBe(false);
    sessions.retireSession(SESSION_ID);
    controller.notifySessionRemoved(registration);
    const removed = environment.take();
    expect(removed).toEqual([initial]);
  });

  it('keeps the running indicator attached to a live tab after its configuration is renamed', () => {
    const { controller, environment, sessions } = setup();
    controller.notifySessionOpened(sessions.requireSession());
    controller.sessionTabs.agentsChanged({ fake: { command: 'agent' } }, { renamed: { command: 'agent' } });
    if (!sessions.session) { throw new Error('Missing session'); }
    sessions.session.agentName = 'renamed';
    environment.take();
    controller.handleSessionUpdate(SESSION_ID, { kind: 'foreground', state: 'running' });
    const snapshot = environment.take().find((message) => message.type === 'sessionTabs');
    expect(snapshot).toMatchObject({ tabs: [{ status: 'working' }] });
  });

  it('rejects stale controls after reconnect and rechecks connection ownership after native reveal', async () => {
    const parts = setup();
    const { controller, environment, sessions } = parts;
    let target = await issuedTarget(parts);
    environment.visible = false;
    const old = new ElicitationRequests();
    const detachOld = sessions.interactions.observe({ agentName: 'fake', agentId: 'fake', elicitations: old, permissions: undefined });
    const withdrawn = old.create({ mode: 'form', rpcId: 1, scope: { sessionId: SESSION_ID }, message: 'Old', requestedSchema: {} });
    const rejected = expect(withdrawn).rejects.toMatchObject({ kind: 'closed' });
    const oldId = old.snapshot()[0]?.interactionId ?? '';
    old.close(); detachOld(); await rejected;
    const replacement = new ElicitationRequests();
    const detach = sessions.interactions.observe({ agentName: 'fake', agentId: 'replacement', elicitations: replacement, permissions: undefined });
    sessions.session = sessionInfo({ agentId: 'replacement' });
    const answer = replacement.create({ mode: 'form', rpcId: 1, scope: { sessionId: SESSION_ID }, message: 'New', requestedSchema: {} });
    const id = replacement.snapshot()[0]?.interactionId ?? '';
    await controller.handleMessage({ type: 'questionResponse', target, interactionId: oldId, action: 'accept', content: {} });
    await controller.handleMessage({ type: 'questionDraft', target, interactionId: oldId, draft: { injected: 'stale' } });
    expect(replacement.snapshot()).toHaveLength(1);
    environment.notifications[0]?.reply.resolve('Open');
    await environment.notifications[0]?.reply.promise;
    expect(environment.reveal).not.toHaveBeenCalled();
    const revealing = deferred<undefined>();
    environment.reveal.mockImplementation(() => revealing.promise);
    environment.notifications[1]?.reply.resolve('Open');
    await environment.notifications[1]?.reply.promise;
    expect(environment.reveal).toHaveBeenCalledOnce();
    sessions.session = sessionInfo({ agentId: 'another-connection' });
    environment.take();
    revealing.resolve(undefined);
    await revealing.promise;
    expect(environment.take()).toEqual([]);
    sessions.session = sessionInfo({ agentId: 'replacement' });
    await controller.handleMessage({ type: 'ready' });
    expect(questionSnapshots(environment.take())).toEqual([{ questions: [expect.objectContaining({ interactionId: id, draft: null })] }]);
    target = await issuedTarget(parts);
    await controller.handleMessage({ type: 'questionResponse', target, interactionId: id, action: 'decline' });
    expect(await answer).toEqual({ action: 'decline' });
    detach(); replacement.close();
  });

  it.each(['draft', 'response'] as const)('rejects a session question %s captured before page recreation', async (action) => {
    const parts = setup();
    const target = await issuedTarget(parts);
    const requests = new ElicitationRequests();
    const detach = parts.sessions.interactions.observe({ agentName: 'fake', agentId: 'fake', elicitations: requests, permissions: undefined });
    const answer = requests.create({ mode: 'form', rpcId: 1, scope: { sessionId: SESSION_ID }, message: 'Pending?', requestedSchema: {} });
    const id = requests.snapshot()[0]?.interactionId ?? '';
    try {
      await parts.controller.handleMessage({ type: 'ready' });
      parts.environment.take();
      const message = action === 'draft'
        ? { type: 'questionDraft' as const, target, interactionId: id, draft: { injected: 'obsolete' } }
        : { type: 'questionResponse' as const, target, interactionId: id, action: 'decline' as const };
      await parts.controller.handleMessage(message);
      expect(requests.snapshot()).toHaveLength(1);
      await parts.controller.handleMessage({ type: 'ready' });
      expect(questionSnapshots(parts.environment.take()).at(-1)?.questions)
        .toEqual([expect.objectContaining({ interactionId: id, draft: null })]);
    } finally {
      requests.respond(id, { action: 'cancel' });
      await answer;
      detach();
      requests.close();
    }
  });

  it('keeps questions from multiple connections in arrival order', async () => {
    const { controller, environment, sessions } = setup();
    const a = new ElicitationRequests();
    const b = new ElicitationRequests();
    const detachA = sessions.interactions.observe({ agentName: 'A', agentId: 'a', elicitations: a, permissions: undefined });
    const detachB = sessions.interactions.observe({ agentName: 'B', agentId: 'b', elicitations: b, permissions: undefined });
    const first = b.create({ mode: 'form', rpcId: 1, scope: { requestId: 'auth-b' }, message: 'First', requestedSchema: {} });
    const second = a.create({ mode: 'form', rpcId: 1, scope: { requestId: 'auth-a' }, message: 'Second', requestedSchema: {} });
    await controller.handleMessage({ type: 'ready' });
    expect(questionSnapshots(environment.take()).at(-1)?.questions.map((question) => question.message)).toEqual(['First', 'Second']);
    a.respond(a.snapshot()[0]?.interactionId ?? '', { action: 'cancel' });
    b.respond(b.snapshot()[0]?.interactionId ?? '', { action: 'decline' });
    await Promise.all([first, second]);
    detachA(); detachB(); a.close(); b.close();
  });

  it('does not expose, answer or record a foreign connection question with the active session ID', async () => {
    const { controller, environment, sessions } = setup();
    sessions.session = sessionInfo({ agentId: 'other-connection', agentName: 'other' });
    environment.visible = false;
    const requests = new ElicitationRequests();
    const detach = sessions.interactions.observe({ agentName: 'fake', agentId: 'fake', elicitations: requests, permissions: undefined });
    const answer = requests.create({ mode: 'form', rpcId: 1, scope: { sessionId: SESSION_ID }, message: 'Foreign?', requestedSchema: {} });
    const id = requests.snapshot()[0]?.interactionId ?? '';
    expect(environment.take()).toEqual([{ type: 'questions', questions: [] }, { type: 'questions', questions: [] }]);
    expect(environment.notifications).toEqual([]);
    const target = { configuredName: 'other', sessionId: SESSION_ID, generation: 1, projection: 1 };
    await controller.handleMessage({ type: 'questionDraft', target, interactionId: id, draft: { answer: 'forged' } });
    await controller.handleMessage({ type: 'questionResponse', target, interactionId: id, action: 'accept', content: {} });
    expect(requests.snapshot()).toHaveLength(1);
    requests.respond(id, { action: 'decline' });
    expect(await answer).toEqual({ action: 'decline' });
    expect(environment.take()).toEqual([{ type: 'questions', questions: [] }]);
    detach();
    requests.close();
  });

  it('announces a hidden question without revealing or answering, then opens only the explicitly selected request', async () => {
    const { controller, environment, sessions } = setup();
    sessions.session = sessionInfo({ title: 'Work session' });
    environment.visible = false;
    const requests = new ElicitationRequests();
    const detach = sessions.interactions.observe({ agentName: 'fake', agentId: 'fake', elicitations: requests, permissions: undefined });
    const first = requests.create({ mode: 'form', rpcId: 1, scope: { sessionId: SESSION_ID }, message: 'First?', requestedSchema: {} });
    const second = requests.create({ mode: 'form', rpcId: 2, scope: { sessionId: SESSION_ID }, message: 'Second?', requestedSchema: {} });
    const id = requests.snapshot()[1]?.interactionId ?? '';
    expect(environment.notifications.map(({ message, items }) => ({ message, items }))).toEqual([
      { message: 'fake has a question for Work session.', items: ['Open'] },
      { message: 'fake has a question for Work session.', items: ['Open'] },
    ]);
    expect(environment.reveal).not.toHaveBeenCalled();
    expect(requests.snapshot()).toHaveLength(2);
    environment.notifications[0]?.reply.resolve(undefined);
    environment.notifications[1]?.reply.resolve('Open');
    await environment.notifications[1]?.reply.promise;
    await controller.handleMessage({ type: 'ready' });
    expect(environment.reveal).toHaveBeenCalledOnce();
    expect(environment.take()).toContainEqual({ type: 'questionOpen', interactionId: id });
    expect(requests.snapshot()).toHaveLength(2);
    requests.respond(requests.snapshot()[0]?.interactionId ?? '', { action: 'cancel' });
    requests.respond(id, { action: 'decline' });
    expect(await first).toEqual({ action: 'cancel' });
    expect(await second).toEqual({ action: 'decline' });
    detach();
    requests.close();
  });

  it('does not reveal a stale notification or navigate to a different active session', async () => {
    const { environment, sessions } = setup();
    environment.visible = false;
    const requests = new ElicitationRequests();
    const detach = sessions.interactions.observe({ agentName: 'fake', agentId: 'fake', elicitations: requests, permissions: undefined });
    const answer = requests.create({ mode: 'form', rpcId: 1, scope: { sessionId: SESSION_ID }, message: 'Pending?', requestedSchema: {} });
    const id = requests.snapshot()[0]?.interactionId ?? '';
    sessions.activeId = 'other';
    environment.notifications[0]?.reply.resolve('Open');
    await environment.notifications[0]?.reply.promise;
    expect(environment.reveal).not.toHaveBeenCalled();
    requests.respond(id, { action: 'cancel' });
    await answer;
    detach();
    requests.close();
  });

  it('announces outside-session questions without inventing a session and ignores withdrawn notification actions', async () => {
    const { environment, sessions } = setup();
    sessions.activeId = null;
    environment.visible = false;
    const requests = new ElicitationRequests();
    const detach = sessions.interactions.observe({ agentName: 'Setup Agent', agentId: 'fake', elicitations: requests, permissions: undefined });
    const abort = new AbortController();
    const answer = requests.create({ mode: 'form', rpcId: 1, scope: { requestId: 'auth' }, message: 'Setup?', requestedSchema: {} }, abort.signal);
    const rejected = expect(answer).rejects.toMatchObject({ kind: 'cancelled' });
    expect(environment.notifications[0]?.message).toBe('Setup Agent has a question.');
    abort.abort();
    await rejected;
    environment.notifications[0]?.reply.resolve('Open');
    await environment.notifications[0]?.reply.promise;
    expect(environment.reveal).not.toHaveBeenCalled();
    expect(environment.take().filter((message) => message.type === 'questionOpen')).toEqual([]);
    detach();
    requests.close();
  });
  it.each(['accept', 'decline', 'cancel'] as const)('records only core-confirmed session form response %s, once', async (action) => {
    const parts = setup();
    const { controller, environment, sessions } = parts;
    const target = await issuedTarget(parts);
    const requests = new ElicitationRequests();
    const detach = sessions.interactions.observe({ agentName: 'fake', agentId: 'fake', elicitations: requests, permissions: undefined });
    const answer = requests.create({ mode: 'form', rpcId: 1, scope: { sessionId: SESSION_ID }, message: 'Count?', requestedSchema: { title: 'Settings', properties: { count: { type: 'integer', default: 0 } }, required: ['count'] } });
    const id = requests.snapshot()[0]?.interactionId ?? '';
    environment.take();
    await controller.handleMessage({ type: 'questionResponse', target, interactionId: id, action: 'accept', content: { count: 0.5 } });
    expect(environment.take()).toEqual([{ type: 'questionErrors', interactionId: id, errors: { count: 'Invalid value' } }]);
    const response = action === 'accept' ? { action, content: { count: 0 } } : { action };
    await controller.handleMessage({ type: 'questionResponse', target, interactionId: id, ...response });
    expect(await answer).toEqual(response);
    const messages = environment.take();
    expect(messages.map((message) => message.type)).toEqual(['contentPatch', 'questions']);
    expect(messages.at(-1)).toEqual({ type: 'questions', questions: [] });
    expect(environment.transcript().entries).toMatchObject([
      { kind: 'question', record: { interactionId: id, sessionId: SESSION_ID, agentName: 'fake', message: 'Count?', title: 'Settings', description: null,
        fields: [{ name: 'count', kind: 'integer', default: 0 }], response } },
    ]);
    await controller.handleMessage({ type: 'questionResponse', target, interactionId: id, ...response });
    expect(environment.take()).toEqual([]);
    await controller.handleMessage({ type: 'ready' });
    expect(environment.take().map((message) => message.type)).toEqual(['viewSnapshot']);
    expect(environment.transcript().entries.filter((entry) => entry.kind === 'question')).toHaveLength(1);
    detach();
    requests.close();
  });

  it('does not record outside-session responses or request withdrawal as session answers', async () => {
    const { controller, environment, sessions } = setup();
    const requests = new ElicitationRequests();
    const detach = sessions.interactions.observe({ agentName: 'Setup Agent', agentId: 'fake', elicitations: requests, permissions: undefined });
    const answer = requests.create({ mode: 'form', rpcId: 1, scope: { requestId: 'auth' }, message: 'Setup?', requestedSchema: {} });
    const id = requests.snapshot()[0]?.interactionId ?? '';
    environment.take();
    await controller.handleMessage({ type: 'questionResponse', target: null, interactionId: id, action: 'accept', content: {} });
    expect(await answer).toEqual({ action: 'accept', content: {} });
    expect(environment.take()).toEqual([{ type: 'questions', questions: [] }]);
    const abort = new AbortController();
    const withdrawn = requests.create({ mode: 'form', rpcId: 2, scope: { sessionId: SESSION_ID }, message: 'Pending?', requestedSchema: {} }, abort.signal);
    const rejected = expect(withdrawn).rejects.toMatchObject({ kind: 'cancelled' });
    environment.take();
    abort.abort();
    await rejected;
    expect(environment.take()).toEqual([{ type: 'questions', questions: [] }]);
    detach();
    requests.close();
  });
  it('keeps outside-session forms available without a session and removes aborted drafts on resynchronization', async () => {
    const { controller, environment, sessions } = setup();
    sessions.activeId = null;
    const requests = new ElicitationRequests();
    const detach = sessions.interactions.observe({ agentName: 'Setup Agent', agentId: 'fake', elicitations: requests, permissions: undefined });
    const abort = new AbortController();
    const answer = requests.create({ mode: 'form', rpcId: 1, scope: { requestId: 'auth' }, message: 'Setup?', requestedSchema: {} }, abort.signal);
    const rejected = expect(answer).rejects.toMatchObject({ kind: 'cancelled' });
    const id = requests.snapshot()[0]?.interactionId ?? '';
    await controller.handleMessage({ type: 'questionDraft', target: null, interactionId: id, draft: { text: 'draft' } });
    expect(environment.take()).toContainEqual({ type: 'questions', questions: [expect.objectContaining({ interactionId: id, sessionId: null, agentName: 'Setup Agent' })] });
    abort.abort();
    await rejected;
    expect(environment.take()).toEqual([{ type: 'questions', questions: [] }]);
    await controller.handleMessage({ type: 'questionResponse', target: null, interactionId: id, action: 'accept', content: {} });
    await controller.handleMessage({ type: 'ready' });
    expect(questionSnapshots(environment.take())).toEqual([{ questions: [] }]);
    detach();
    requests.close();
  });

  it('resynchronizes pending forms and raw drafts without answering or exposing another session', async () => {
    const parts = setup();
    const { controller, environment, sessions } = parts;
    let target = await issuedTarget(parts);
    const requests = new ElicitationRequests();
    const detach = sessions.interactions.observe({ agentName: 'fake', agentId: 'fake', elicitations: requests, permissions: undefined });
    const answer = requests.create({ mode: 'form', rpcId: 1, scope: { sessionId: SESSION_ID }, message: 'Count?', requestedSchema: { properties: { count: { type: 'integer', default: 0 } } } });
    const id = requests.snapshot()[0]?.interactionId ?? '';
    expect(environment.take()).toContainEqual({ type: 'questions', questions: [expect.objectContaining({ interactionId: id, agentName: 'fake', message: 'Count?', draft: null, fields: [expect.objectContaining({ kind: 'integer', default: 0 })] })] });
    await controller.handleMessage({ type: 'questionDraft', target, interactionId: id, draft: { count: '-' } });
    await controller.handleMessage({ type: 'ready' });
    expect(questionSnapshots(environment.take())).toEqual([{ questions: [expect.objectContaining({ draft: { count: '-' } })] }]);
    target = await issuedTarget(parts);
    await controller.handleMessage({ type: 'questionDraft', target, interactionId: id, draft: {} });
    await controller.handleMessage({ type: 'ready' });
    expect(questionSnapshots(environment.take())).toEqual([{ questions: [expect.objectContaining({ draft: {} })] }]);
    sessions.activeId = 'other';
    controller.notifyActiveSessionChanged();
    expect(questionSnapshots(environment.take())).toEqual([{ questions: [] }]);
    await controller.handleMessage({ type: 'questionResponse', target, interactionId: id, action: 'accept', content: { count: 3 } });
    expect(requests.snapshot()).toHaveLength(1);
    sessions.activeId = SESSION_ID;
    controller.notifyActiveSessionChanged();
    target = await issuedTarget(parts);
    await controller.handleMessage({ type: 'questionResponse', target, interactionId: id, action: 'accept', content: { count: 1.5 } });
    expect(environment.take()).toContainEqual({ type: 'questionErrors', interactionId: id, errors: { count: 'Invalid value' } });
    await controller.handleMessage({ type: 'questionResponse', target, interactionId: id, action: 'accept', content: { count: 3 } });
    expect(await answer).toEqual({ action: 'accept', content: { count: 3 } });
    expect(environment.take()).toContainEqual({ type: 'questions', questions: [] });
    detach();
    requests.close();
  });

  it('stops posting and accepting updates while its command output drains on disposal', async () => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    const parts = setup();
    const { controller, environment, sessions } = parts;
    let outputReleased = false;
    const dispose = Cleaner.prototype.dispose;
    const release = vi.spyOn(Cleaner.prototype, 'dispose').mockImplementation(function (this: Cleaner) {
      return dispose.call(this).then(() => { outputReleased = true; });
    });
    onTestFinished(() => { release.mockRestore(); });
    controller.handleSessionUpdate(SESSION_ID, { kind: 'toolCall', toolCallId: 'c1', toolKind: 'execute', content: [{ kind: 'text', text: 'pending' }] });
    controller.handleSessionUpdate(SESSION_ID, { kind: 'agentText', messageId: null, text: 'pending text' });
    controller.handleSessionUpdate(SESSION_ID, { kind: 'terminalOutput', terminalId: 't1', data: new TextEncoder().encode('pending terminal') });
    const target = await issuedTarget(parts);
    environment.take();
    const disposed = controller.dispose();
    const retainedDisposal = sessions.retained.dispose();
    const releasedAtDisposal = retainedDisposal.then(() => outputReleased);
    expect(controller.dispose()).toBe(disposed);
    controller.handleSessionUpdate(SESSION_ID, { kind: 'agentText', messageId: null, text: 'late' });
    await controller.handleMessage({ type: 'sendPrompt', target, text: 'late' });
    await vi.runAllTimersAsync();
    await disposed;
    await retainedDisposal;

    expect(await releasedAtDisposal).toBe(true);
    expect(environment.take()).toEqual([]);
    expect(sessions.sendPrompt).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  describe('session state', () => {
    it('logs every webview ready handshake at info', async () => {
      const { controller } = setup();
      const calls: unknown[][] = [];
      setLogSink({
        trace() {},
        debug() {},
        info: (...args) => calls.push(['info', ...args]),
        warn() {},
        error() {},
      });
      onTestFinished(() => { setLogSink(undefined); });

      await controller.handleMessage({ type: 'ready' });
      await controller.handleMessage({ type: 'ready' });

      expect(calls).toEqual([
        ['info', 'Chat view ready'],
        ['info', 'Chat view ready'],
      ]);
    });

    it('describes the active session when the webview is ready', async () => {
      const { sessions, environment, controller } = setup();
      sessions.session = sessionInfo({
        title: 'Fix the build',
        availableCommands: [
          { name: 'init', description: 'Init', takesInput: false, hint: null },
          { name: 'review', description: 'Review', takesInput: true, hint: 'what to review' },
        ],
      });

      await controller.handleMessage({ type: 'ready' });

      expect(environment.take()).toEqual([{
        type: 'viewSnapshot', state: {
        activeSessionId: SESSION_ID,
        session: {
          sessionId: SESSION_ID,
          agentName: 'Fake Agent',
          title: 'Fix the build',
          cwd: '/work/project',
          pickers: [modelPicker],
          commands: [
            { name: 'init', description: 'Init', takesInput: false, hint: null },
            { name: 'review', description: 'Review', takesInput: true, hint: 'what to review' },
          ],
        },
      }, tabs: { tabs: [], selectedTabId: null }, running: false, loading: false, questions: [], content: null }]);
    });

    it('leaves the title out when the session has none', () => {
      const { environment, controller } = setup();

      controller.notifyActiveSessionChanged();

      const [state] = environment.take();
      expect(state).toMatchObject({ type: 'viewSnapshot', state: { session: { sessionId: SESSION_ID } } });
      expect(state?.type === 'viewSnapshot' ? state.state.session : undefined).not.toHaveProperty('title');
    });

    it('reports no session when none is active', async () => {
      const { sessions, environment, controller } = setup();
      sessions.activeId = null;

      await controller.handleMessage({ type: 'ready' });

      expect(environment.take()).toEqual([{ type: 'viewSnapshot', state: { activeSessionId: null, session: null }, tabs: { tabs: [], selectedTabId: null }, running: false, loading: false, questions: [], content: null }]);
    });

    it.each([false, true])('keeps loading active until the committed transcript is delivered (success: %s)', async (ok) => {
      const parts = setup();
      const { environment, controller } = parts;
      await issuedTarget(parts);
      controller.handleSessionUpdate(SESSION_ID, { kind: 'agentMessage', messageId: 'old', text: 'Committed answer' });
      controller.notifyLoadSessionStart(SESSION_ID);
      controller.handleSessionUpdate(SESSION_ID, { kind: 'agentMessage', messageId: 'replay', text: 'Replayed answer' });
      environment.take();
      controller.notifyLoadSessionEnd(ok);
      const messages = environment.take();
      expect(messages.map((message) => message.type)).toEqual(['contentSnapshot', 'loadSessionEnd']);
      expect(contentSnapshots(messages)[0]?.entries).toMatchObject([{ kind: 'turn', parts: [{ text: ok ? 'Replayed answer' : 'Committed answer' }] }]);
    });

    it('passes on replays and changes to the pickers', () => {
      const { environment, controller } = setup();

      controller.notifyLoadSessionStart(SESSION_ID);
      controller.notifyLoadSessionEnd(false);
      controller.notifyPickersChanged();

      expect(environment.take()).toEqual([
        { type: 'loadSessionStart' },
        { type: 'loadSessionEnd', ok: false },
        { type: 'pickers', pickers: [modelPicker] },
      ]);
    });

    it('does not publish an old load completion after selection moves to another session', () => {
      const { environment, controller, sessions } = setup();
      controller.notifyLoadSessionStart(SESSION_ID);
      sessions.session = sessionInfo({ sessionId: OTHER_SESSION_ID });
      sessions.activeId = OTHER_SESSION_ID;
      controller.notifyActiveSessionChanged();
      environment.take();

      controller.notifyLoadSessionEnd(false);

      expect(environment.take()).toEqual([]);
    });

    it('says nothing about pickers when no session is active', () => {
      const { sessions, environment, controller } = setup();
      sessions.activeId = null;

      controller.notifyPickersChanged();

      expect(environment.take()).toEqual([]);
    });
  });

  describe('pickers', () => {
    function pickers(session: SessionInfo): Picker[] {
      const { sessions, environment, controller } = setup();
      sessions.session = session;
      controller.notifyPickersChanged();
      const [message] = environment.take();
      return message?.type === 'pickers' ? message.pickers : [];
    }

    it('shows the modes as a picker for a session without config options', () => {
      expect(pickers(sessionInfo({ configOptions: null, modes }))).toEqual([modePicker]);
      expect(pickers(sessionInfo({ configOptions: [], modes }))).toEqual([modePicker]);
    });

    it('shows only the config options when the session has both, as they replace modes', () => {
      expect(pickers(sessionInfo({ configOptions: [modelOption], modes }))).toEqual([modelPicker]);
    });

    it('shows no picker for modes without any, or for config options other than selects with values', () => {
      expect(pickers(sessionInfo({ configOptions: null, modes: { current: 'ask', available: [] } }))).toEqual([]);
      const unpickable: ConfigOption[] = [
        { kind: 'boolean', id: 'fast', name: 'Fast', description: null, category: 'other', current: false },
        { kind: 'select', id: 'empty', name: 'Empty', description: null, category: 'other', current: '', groups: [] },
      ];
      expect(pickers(sessionInfo({ configOptions: unpickable, modes }))).toEqual([]);
    });

    it('keeps the groups and headers of grouped values', () => {
      const grouped: ConfigOption = {
        ...modelOption,
        current: 'b',
        groups: [
          { header: 'Fast models', values: [{ id: 'a', name: 'A', description: null }] },
          { header: 'slow', values: [{ id: 'b', name: 'B', description: 'Slow' }] },
        ],
      };

      expect(pickers(sessionInfo({ configOptions: [grouped] }))).toEqual([{
        ...modelPicker,
        current: 'b',
        groups: [
          { header: 'Fast models', values: [{ id: 'a', name: 'A', description: null }] },
          { header: 'slow', values: [{ id: 'b', name: 'B', description: 'Slow' }] },
        ],
      }]);
    });
  });

  describe('session title', () => {
    function infoUpdate(fields: { title?: string | null; updatedAt?: string }): SessionUpdate {
      return { kind: 'sessionInfo', ...fields };
    }

    function titles(environment: FakeEnvironment): (string | null)[] {
      return environment.take().flatMap((m) => (m.type === 'sessionInfoUpdate' ? [m.title] : []));
    }

    it('shows the title the agent sets', () => {
      const { environment, controller } = setup();

      controller.handleSessionUpdate(SESSION_ID, infoUpdate({ title: 'New title' }));

      expect(titles(environment)).toEqual(['New title']);
    });

    it('keeps the title when an update carries none', () => {
      const { sessions, environment, controller } = setup();
      sessions.session = sessionInfo({ title: 'Fix the build' });

      controller.handleSessionUpdate(SESSION_ID, infoUpdate({ updatedAt: '2026-10-18T12:00:00Z' }));

      expect(titles(environment)).toEqual(['Fix the build']);
    });

    it('removes the title when the agent clears it', () => {
      const { sessions, environment, controller } = setup();
      sessions.session = sessionInfo({ title: 'Fix the build' });

      controller.handleSessionUpdate(SESSION_ID, infoUpdate({ title: null }));

      expect(titles(environment)).toEqual([null]);
    });
  });

  describe('session controls', () => {
    it('rejects Stop captured before a new page projection', async () => {
      const parts = setup();
      const target = await issuedTarget(parts);
      await parts.controller.handleMessage({ type: 'ready' });
      const stop = { type: 'cancelTurn' as const, target };

      await parts.controller.handleMessage(stop);

      expect(parts.sessions.cancelTurn).not.toHaveBeenCalled();
    });

    it('rejects a picker choice captured before a new page projection', async () => {
      const { sessions, environment, controller } = setup();
      controller.handleSessionUpdate(SESSION_ID, { kind: 'commands', commands: [] });
      await controller.handleMessage({ type: 'ready' });
      const snapshot = contentSnapshots(environment.take()).at(-1);
      if (!snapshot) { throw new Error('Missing projection'); }
      await controller.handleMessage({ type: 'ready' });
      const choice = { type: 'pickerValueChosen' as const, target: snapshot.target, pickerId: 'model', value: 'b' };

      await controller.handleMessage(choice);

      expect(sessions.setConfigOption).not.toHaveBeenCalled();
    });

    it('logs a changed picker selection at debug with its picker ID and value', async () => {
      const parts = setup();
      const { sessions, controller } = parts;
      sessions.session = sessionInfo({ configOptions: null, modes });
      const target = await issuedTarget(parts);
      const calls: unknown[][] = [];
      setLogSink({
        trace() {},
        debug: (...args) => calls.push(['debug', ...args]),
        info() {},
        warn() {},
        error() {},
      });
      onTestFinished(() => { setLogSink(undefined); });

      await controller.handleMessage({ type: 'pickerValueChosen', target, pickerId: 'mode', value: 'code' });

      expect(calls).toEqual([['debug', 'Picker value selected', { pickerId: 'mode', value: 'code' }]]);
    });

    it('cancels the active turn', async () => {
      const parts = setup();
      const { sessions, controller } = parts;
      const target = await issuedTarget(parts);

      await controller.handleMessage({ type: 'cancelTurn', target });

      expect(sessions.cancelTurn).toHaveBeenCalledExactlyOnceWith({ configuredName: 'fake', sessionId: SESSION_ID });
    });

    it('ignores cancel when no session is active and keeps quiet when cancel fails', async () => {
      const parts = setup();
      const { sessions, environment, controller } = parts;
      const target = await issuedTarget(parts);
      sessions.activeId = null;
      await controller.handleMessage({ type: 'cancelTurn', target });
      expect(sessions.cancelTurn).not.toHaveBeenCalled();

      sessions.activeId = SESSION_ID;
      sessions.cancelTurn.mockRejectedValueOnce(new Error('gone'));
      await controller.handleMessage({ type: 'cancelTurn', target });
      expect(environment.take()).toEqual([]);
    });

    it("sets the mode when the session's picker stands for its modes, leaving the pickers to the session's report", async () => {
      const parts = setup();
      const { sessions, environment, controller } = parts;
      sessions.session = sessionInfo({ configOptions: null, modes });
      const target = await issuedTarget(parts);

      await controller.handleMessage({ type: 'pickerValueChosen', target, pickerId: 'mode', value: 'code' });

      expect(sessions.setMode).toHaveBeenCalledExactlyOnceWith({ configuredName: 'fake', sessionId: SESSION_ID }, 'code');
      expect(sessions.setConfigOption).not.toHaveBeenCalled();
      expect(environment.take()).toEqual([]);
    });

    it('reports a mode that cannot be set, and rolls the picker back', async () => {
      const parts = setup();
      const { sessions, environment, controller } = parts;
      sessions.session = sessionInfo({ configOptions: null, modes });
      const target = await issuedTarget(parts);
      sessions.setMode.mockRejectedValueOnce(new Error('unknown mode'));

      await controller.handleMessage({ type: 'pickerValueChosen', target, pickerId: 'mode', value: 'nope' });

      expect(environment.take()).toEqual([
        { type: 'error', message: 'Failed to set mode: unknown mode' },
        { type: 'pickers', pickers: [modePicker] },
      ]);
    });

    it('sets a config option, then re-sends the pickers from every option the agent returns', async () => {
      const parts = setup();
      const { sessions, environment, controller } = parts;
      const target = await issuedTarget(parts);
      sessions.setConfigOption.mockImplementationOnce(async (sessionId, _configId, _value) => {
        const returned: ConfigOption[] = [{ ...modelOption, current: 'b' }];
        sessions.applyConfigOptions(sessionId, returned);
        return returned;
      });

      await controller.handleMessage({ type: 'pickerValueChosen', target, pickerId: 'model', value: 'b' });

      expect(sessions.setConfigOption).toHaveBeenCalledExactlyOnceWith({ configuredName: 'fake', sessionId: SESSION_ID }, 'model', 'b');
      expect(sessions.setMode).not.toHaveBeenCalled();
      expect(environment.take()).toEqual([{ type: 'pickers', pickers: [{ ...modelPicker, current: 'b' }] }]);
    });

    it("rolls the picker back to the session's options when setting one fails", async () => {
      const parts = setup();
      const { sessions, environment, controller } = parts;
      const target = await issuedTarget(parts);
      sessions.setConfigOption.mockRejectedValueOnce(new Error('rejected'));

      await controller.handleMessage({ type: 'pickerValueChosen', target, pickerId: 'model', value: 'b' });

      expect(environment.take()).toEqual([
        { type: 'error', message: 'Failed to set model: rejected' },
        { type: 'pickers', pickers: [modelPicker] },
      ]);
    });

    it('ignores a choice when no session is active', async () => {
      const parts = setup();
      const { sessions, environment, controller } = parts;
      const target = await issuedTarget(parts);
      sessions.activeId = null;

      await controller.handleMessage({ type: 'pickerValueChosen', target, pickerId: 'model', value: 'b' });

      expect(sessions.setConfigOption).not.toHaveBeenCalled();
      expect(environment.take()).toEqual([]);
    });
  });

  describe('session updates', () => {
    it('does not charge a background command output image to the displayed transcript', async () => {
      vi.useFakeTimers();
      onTestFinished(() => { vi.useRealTimers(); });
      const { environment, controller, sessions } = setup();
      const header = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR0YAAAAASUVORK5CYII=', 'base64');
      const data = Buffer.concat([header, Buffer.alloc(10 * 1024 * 1024 - header.length)]).toString('base64');
      controller.handleSessionUpdate(SESSION_ID, { kind: 'toolCall', toolCallId: 'background', toolKind: 'execute', content: [
        { kind: 'text', text: 'command output' }, { kind: 'image', data, mimeType: 'image/png' },
      ] });
      sessions.activeId = OTHER_SESSION_ID;
      sessions.session = sessionInfo({ sessionId: OTHER_SESSION_ID });
      controller.notifyActiveSessionChanged();
      await vi.runAllTimersAsync();
      for (let index = 0; index < 5; index++) {
        controller.handleSessionUpdate(OTHER_SESSION_ID, { kind: 'agentImage', messageId: `m${index}`, data, mimeType: 'image/png' });
      }
      const received = environment.parts();
      expect(received.filter((part) => part.kind === 'image').map((part) => part.src !== null)).toEqual([true, true, true, true, true]);
      expect(received.filter((part) => part.kind === 'toolCalls')).toEqual([]);
    });

    it.each([
      ['image/gif', '47494638396101000100800000000000ffffff2c00000000010001000002014c003b'],
      ['image/jpeg', 'ffd8ffe000104a46494600010100000100010000ffc00011080001000103012200021101031101ffd9'],
      ['image/webp', '5249464616000000574542505650384c090000002f000000000710111100'],
    ])('presents %s after inspecting its actual header', (mimeType, hex) => {
      const { environment, controller } = setup();
      const data = Buffer.from(hex, 'hex').toString('base64');
      controller.handleSessionUpdate(SESSION_ID, { kind: 'agentImage', messageId: 'm1', data, mimeType });
      expect(environment.parts()).toEqual([{ kind: 'image', messageId: 'm1', src: `data:${mimeType};base64,${data}` }]);
    });

    it.each([
      [16384, 1, true], [1, 16384, true], [8000, 5000, true],
      [16385, 1, false], [1, 16385, false], [8000, 5001, false], [0, 1, false],
    ])('checks a %s by %s header before presentation', (width, height, accepted) => {
      const { environment, controller } = setup();
      const header = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR0YAAAAASUVORK5CYII=', 'base64');
      header.writeUInt32BE(width, 16);
      header.writeUInt32BE(height, 20);
      const data = header.toString('base64');
      controller.handleSessionUpdate(SESSION_ID, { kind: 'agentImage', messageId: 'm1', data, mimeType: 'image/png' });
      expect(environment.parts()).toEqual([{ kind: 'image', messageId: 'm1', ...(accepted
        ? { src: `data:image/png;base64,${data}` }
        : { src: null, fallback: width === 0 ? 'Invalid image dimensions' : 'Image exceeds dimension or pixel limit' }) }]);
    });

    it.each([10 * 1024 * 1024, 10 * 1024 * 1024 + 1, 10 * 1024 * 1024 + 3])('bounds a %s byte payload', (length) => {
      const { environment, controller } = setup();
      const header = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR0YAAAAASUVORK5CYII=', 'base64');
      const data = Buffer.concat([header, Buffer.alloc(length - header.length)]).toString('base64');
      controller.handleSessionUpdate(SESSION_ID, { kind: 'agentImage', messageId: 'm1', data, mimeType: 'image/png' });
      expect(environment.parts()).toEqual([{ kind: 'image', messageId: 'm1', ...(length === 10 * 1024 * 1024
        ? { src: `data:image/png;base64,${data}` }
        : { src: null, fallback: 'Image exceeds 10 MiB payload limit' }) }]);
    });

    it.each(['', 'A===', 'AAAA=', 'AA A', 'AB==', 'data:image/png;base64,AAAA'])('rejects noncanonical base64 %j', (data) => {
      const { environment, controller } = setup();
      controller.handleSessionUpdate(SESSION_ID, { kind: 'agentImage', messageId: 'm1', data, mimeType: 'image/png' });
      expect(environment.parts()).toEqual([{ kind: 'image', messageId: 'm1', src: null, fallback: 'Invalid image data' }]);
    });

    it.each(['agent', 'thought', 'prompt', 'tool'] as const)('releases %s images on content clearing without evicting other images', (surface) => {
      const { environment, controller } = setup();
      const header = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR0YAAAAASUVORK5CYII=', 'base64');
      const data = Buffer.concat([header, Buffer.alloc(10 * 1024 * 1024 - header.length)]).toString('base64');
      for (let index = 0; index < 4; index++) {
        controller.handleSessionUpdate(SESSION_ID, { kind: 'agentImage', messageId: `kept${index}`, data, mimeType: 'image/png' });
      }
      const content = [{ kind: 'image' as const, data, mimeType: 'image/png' }];
      controller.handleSessionUpdate(SESSION_ID, surface === 'tool'
        ? { kind: 'toolCall', toolCallId: 'replace', content }
        : { kind: surface === 'agent' ? 'agentRichMessage' : surface === 'thought' ? 'thoughtRichMessage' : 'promptRichMessage', messageId: 'replace', content });
      controller.handleSessionUpdate(SESSION_ID, { kind: 'agentImage', messageId: 'blocked', data, mimeType: 'image/png' });
      expect(environment.parts().at(-1)).toEqual({ kind: 'image', messageId: 'blocked', src: null, fallback: 'Session image budget exceeded' });
      controller.handleSessionUpdate(SESSION_ID, surface === 'tool'
        ? { kind: 'toolCall', toolCallId: 'replace', content: [] }
        : { kind: surface === 'agent' ? 'agentMessage' : surface === 'thought' ? 'thoughtMessage' : 'promptMessage', messageId: 'replace', text: '' });
      controller.handleSessionUpdate(SESSION_ID, { kind: 'agentImage', messageId: 'fits', data, mimeType: 'image/png' });
      expect(environment.parts().at(-1)).toEqual({ kind: 'image', messageId: 'fits', src: `data:image/png;base64,${data}` });
      controller.handleSessionUpdate(SESSION_ID, { kind: 'agentImage', messageId: 'stillBlocked', data: header.toString('base64'), mimeType: 'image/png' });
      expect(environment.parts().at(-1)).toEqual({ kind: 'image', messageId: 'stillBlocked', src: null, fallback: 'Session image budget exceeded' });
    });

    it('reconstructs image accounting when returning to retained content', () => {
      const { environment, controller, sessions } = setup();
      const first = sessions.session;
      if (!first) { throw new Error('Missing session'); }
      const header = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR0YAAAAASUVORK5CYII=', 'base64');
      const data = Buffer.concat([header, Buffer.alloc(10 * 1024 * 1024 - header.length)]).toString('base64');
      for (let index = 0; index < 5; index++) {
        controller.handleSessionUpdate(SESSION_ID, { kind: 'agentImage', messageId: `m${index}`, data, mimeType: 'image/png' });
      }
      sessions.session = sessionInfo({ sessionId: OTHER_SESSION_ID });
      sessions.activeId = OTHER_SESSION_ID;
      controller.notifyActiveSessionChanged();
      sessions.session = first;
      sessions.activeId = SESSION_ID;
      controller.notifyActiveSessionChanged();

      controller.handleSessionUpdate(SESSION_ID, { kind: 'agentImage', messageId: 'late', data: header.toString('base64'), mimeType: 'image/png' });

      expect(environment.parts().slice(0, 5)).toEqual(Array.from({ length: 5 }, (_, index) => ({ kind: 'image', messageId: `m${index}`, src: `data:image/png;base64,${data}` })));
      expect(environment.parts().at(-1)).toEqual({ kind: 'image', messageId: 'late', src: null, fallback: 'Session image budget exceeded' });
    });

    it.each(['clear', 'replay', 'switch'] as const)('starts a fresh displayed image budget after %s', (operation) => {
      const { environment, controller, sessions } = setup();
      controller.notifyActiveSessionChanged();
      const header = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR0YAAAAASUVORK5CYII=', 'base64');
      const data = Buffer.concat([header, Buffer.alloc(10 * 1024 * 1024 - header.length)]).toString('base64');
      for (let index = 0; index < 5; index++) {
        controller.handleSessionUpdate(SESSION_ID, { kind: 'agentImage', messageId: `m${index}`, data, mimeType: 'image/png' });
      }
      if (operation === 'clear') {
        controller.clearTranscript();
        sessions.activeId = OTHER_SESSION_ID;
        sessions.session = sessionInfo({ sessionId: OTHER_SESSION_ID });
      }
      else if (operation === 'replay') { controller.notifyLoadSessionStart(SESSION_ID); }
      else { sessions.activeId = OTHER_SESSION_ID; sessions.session = sessionInfo({ sessionId: OTHER_SESSION_ID }); controller.notifyActiveSessionChanged(); }
      environment.take();
      controller.handleSessionUpdate(sessions.activeId ?? '', { kind: 'agentImage', messageId: 'fresh', data, mimeType: 'image/png' });
      if (operation === 'replay') { controller.notifyLoadSessionEnd(true); }
      expect(environment.parts().at(-1)).toEqual({ kind: 'image', messageId: 'fresh', src: `data:image/png;base64,${data}` });
    });

    it.each([
      ['image/png', '!!!!', 'Invalid image data'],
      ['image/svg+xml', 'PHN2Zz48L3N2Zz4=', 'Unsupported image format'],
      ['image/jpeg', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR0YAAAAASUVORK5CYII=', 'Image MIME type does not match its bytes'],
    ])('explains rejected %s content', (mimeType, data, fallback) => {
      const { environment, controller } = setup();
      controller.handleSessionUpdate(SESSION_ID, { kind: 'agentImage', messageId: 'm1', data, mimeType });
      expect(environment.parts()).toEqual([{ kind: 'image', messageId: 'm1', src: null, fallback }]);
    });

    it('does not reset the displayed image budget when a background replay starts', () => {
      const { environment, controller } = setup();
      const header = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR0YAAAAASUVORK5CYII=', 'base64');
      const data = Buffer.concat([header, Buffer.alloc(10 * 1024 * 1024 - header.length)]).toString('base64');
      for (let index = 0; index < 5; index++) {
        controller.handleSessionUpdate(SESSION_ID, { kind: 'agentImage', messageId: `m${index}`, data, mimeType: 'image/png' });
      }
      environment.take();
      controller.notifyLoadSessionStart('background');
      controller.handleSessionUpdate(SESSION_ID, { kind: 'agentImage', messageId: 'late', data: header.toString('base64'), mimeType: 'image/png' });
      expect(environment.parts().at(-1)).toEqual({ kind: 'image', messageId: 'late', src: null, fallback: 'Session image budget exceeded' });
    });

    it.each(['thoughtRichMessage', 'promptRichMessage'] as const)('translates %s in content order', (kind) => {
      const { environment, controller } = setup();
      controller.handleSessionUpdate(SESSION_ID, { kind, messageId: 'm1', content: [
        { kind: 'text', text: 'before' },
        { kind: 'image', data: '', mimeType: 'image/png', reference: true },
        { kind: 'text', text: 'after' },
      ] });
      expect(kind === 'thoughtRichMessage' ? environment.parts() : environment.transcript().entries).toEqual(kind === 'thoughtRichMessage' ? [
        { kind: 'thought', messageId: 'm1', text: 'before', startedAt: expect.any(Number) as number, endedAt: expect.any(Number) as number, open: false },
        { kind: 'thought', messageId: 'm1', text: '', imageSrc: null, imageReference: true, startedAt: expect.any(Number) as number, endedAt: expect.any(Number) as number, open: false },
        { kind: 'thought', messageId: 'm1', text: 'after', startedAt: expect.any(Number) as number, endedAt: null, open: true },
      ] : [
        { kind: 'prompt', id: 1, messageId: 'm1', text: 'before' },
        { kind: 'promptImage', id: 2, messageId: 'm1', text: '', src: null, reference: true },
        { kind: 'prompt', id: 3, messageId: 'm1', text: 'after' },
      ]);
    });

    it('validates an image before delivering it after buffered text', () => {
      const { environment, controller } = setup();
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR0YAAAAASUVORK5CYII=';
      controller.handleSessionUpdate(SESSION_ID, { kind: 'agentText', messageId: 'm1', text: 'Before' });
      controller.handleSessionUpdate(SESSION_ID, { kind: 'agentImage', messageId: 'm1', data: png, mimeType: 'image/png' });
      expect(environment.parts()).toEqual([
        { kind: 'message', messageId: 'm1', text: 'Before' },
        { kind: 'image', messageId: 'm1', src: `data:image/png;base64,${png}` },
      ]);
    });

    it('delivers ordered whole-message content with validated images', () => {
      const { environment, controller } = setup();
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR0YAAAAASUVORK5CYII=';
      controller.handleSessionUpdate(SESSION_ID, { kind: 'agentRichMessage', messageId: 'm1', content: [
        { kind: 'text', text: 'before' }, { kind: 'image', mimeType: 'image/png', data: png }, { kind: 'text', text: 'after' },
      ] });
      expect(environment.parts()).toEqual([
        { kind: 'message', messageId: 'm1', text: 'before' },
        { kind: 'image', messageId: 'm1', src: `data:image/png;base64,${png}` },
        { kind: 'message', messageId: 'm1', text: 'after' },
      ]);
    });

    it('delivers validated images in thoughts and replayed prompts', () => {
      const { environment, controller } = setup();
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR0YAAAAASUVORK5CYII=';
      controller.handleSessionUpdate(SESSION_ID, { kind: 'thoughtImage', messageId: 't1', data: png, mimeType: 'image/png' });
      controller.handleSessionUpdate(SESSION_ID, { kind: 'promptImage', messageId: 'u1', data: png, mimeType: 'image/png' });
      expect(environment.transcript().entries).toEqual([
        { kind: 'turn', id: 1, parts: [{ kind: 'thought', messageId: 't1', text: '', imageSrc: `data:image/png;base64,${png}`,
          startedAt: expect.any(Number) as number, endedAt: expect.any(Number) as number, open: false }] },
        { kind: 'promptImage', id: 2, messageId: 'u1', text: '', src: `data:image/png;base64,${png}` },
      ]);
    });

    it('labels an image resource link as a reference without loading its URI', () => {
      const { environment, controller } = setup();
      controller.handleSessionUpdate(SESSION_ID, { kind: 'agentImage', messageId: 'm1', data: '', mimeType: 'image/png', reference: true });
      expect(environment.parts()).toEqual([{ kind: 'image', messageId: 'm1', src: null, reference: true }]);
    });

    it('delivers validated tool-call images in content order', () => {
      const { environment, controller } = setup();
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR0YAAAAASUVORK5CYII=';
      controller.handleSessionUpdate(SESSION_ID, { kind: 'toolCall', toolCallId: 't1', content: [
        { kind: 'text', text: 'before' }, { kind: 'image', data: png, mimeType: 'image/png' }, { kind: 'text', text: 'after' },
      ] });
      expect(environment.parts()).toEqual([{ kind: 'toolCalls', collapsed: false, toolCalls: [{ toolCallId: 't1', title: '', status: 'pending', open: false, content: [
        { kind: 'text', text: 'before' }, { kind: 'image', src: `data:image/png;base64,${png}` }, { kind: 'text', text: 'after' },
      ] }] }]);
    });

    it.each([
      ['malformed base64', '!!!!', 'image/png', 'Invalid image data'],
      ['unsupported SVG', 'PHN2Zz48L3N2Zz4=', 'image/svg+xml', 'Unsupported image format'],
      ['incorrect MIME type', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR0YAAAAASUVORK5CYII=', 'image/jpeg', 'Image MIME type does not match its bytes'],
      ['truncated bytes', 'iVBORw0KGgo=', 'image/png', 'Invalid image data'],
    ])('reports a fallback for %s', (_reason, data, mimeType, fallback) => {
      const { environment, controller } = setup();
      controller.handleSessionUpdate(SESSION_ID, { kind: 'agentImage', messageId: 'm1', data, mimeType });
      expect(environment.parts()).toEqual([{ kind: 'image', messageId: 'm1', src: null, fallback }]);
    });

    function translated(update: SessionUpdate, session: SessionInfo = sessionInfo()): ExtensionToWebviewMessage[] {
      const { sessions, environment, controller } = setup();
      sessions.session = session;
      vi.useFakeTimers();
      try {
        controller.handleSessionUpdate(SESSION_ID, update);
        vi.advanceTimersByTime(16);
      } finally {
        vi.useRealTimers();
      }
      return environment.take().filter((message) => message.type !== 'sessionInfoUpdate');
    }

    it('tells the webview about updates to the active session only', () => {
      const { environment, controller } = setup();

      controller.handleSessionUpdate(SESSION_ID, toolCall);
      controller.handleSessionUpdate('other', toolCall);

      expect(environment.parts()).toEqual([{ kind: 'toolCalls', collapsed: false, toolCalls: [
        { toolCallId: 't1', title: 'Read', status: 'pending', content: [], open: false },
      ] }]);
    });

    it('delivers reported usage immediately in the webview contract without changing its values', () => {
      const { environment, controller } = setup();

      controller.handleSessionUpdate(SESSION_ID, { kind: 'usage', used: 123456, size: 200001, cost: { amount: 0.123456789, currency: 'EUR' } });
      controller.handleSessionUpdate(SESSION_ID, { kind: 'usage', used: 15000, size: 100000, cost: null });
      controller.handleSessionUpdate(SESSION_ID, { kind: 'usage', used: 0, size: 0, cost: { amount: 0, currency: 'JPY' } });

      expect(environment.take().map((message) => 'usage' in message ? message.usage : undefined)).toEqual([
        { used: 123456, size: 200001, cost: { amount: 0.123456789, currency: 'EUR' } },
        { used: 15000, size: 100000, cost: null },
        { used: 0, size: 0, cost: { amount: 0, currency: 'JPY' } },
      ]);
    });

    it('bounds retained image bytes and reclaims a replaced message budget', () => {
      const { environment, controller } = setup();
      const header = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR0YAAAAASUVORK5CYII=', 'base64');
      const data = Buffer.concat([header, Buffer.alloc(9 * 1024 * 1024 - header.length)]).toString('base64');
      for (let index = 0; index < 6; index++) {
        controller.handleSessionUpdate(SESSION_ID, { kind: 'agentImage', messageId: `m${index}`, data, mimeType: 'image/png' });
      }
      const received = environment.parts().filter((part) => part.kind === 'image');
      expect(received.map((part) => part.src !== null)).toEqual([true, true, true, true, true, false]);
      controller.handleSessionUpdate(SESSION_ID, { kind: 'agentMessage', messageId: 'm0', text: '' });
      controller.handleSessionUpdate(SESSION_ID, { kind: 'agentImage', messageId: 'm6', data, mimeType: 'image/png' });
      expect(environment.parts().at(-1)).toEqual({ kind: 'image', messageId: 'm6', src: `data:image/png;base64,${data}` });
    });

    it('delivers compaction patches and chunks in order between buffered text messages', () => {
      const { environment, controller } = setup();
      controller.handleSessionUpdate(SESSION_ID, { kind: 'agentText', messageId: 'm1', text: 'Before' });
      controller.handleSessionUpdate(SESSION_ID, {
        kind: 'compactionUpdate', compactionId: 'c1', status: '_paused',
        summary: { present: false }, error: { present: false },
      });
      expect(environment.parts()).toMatchObject([{ text: 'Before' }, { kind: 'compaction', compactionId: 'c1', status: '_paused', summary: [], error: null }]);
      controller.handleSessionUpdate(SESSION_ID, {
        kind: 'compactionSummaryChunk', compactionId: 'c1',
        content: { type: 'resource_link', uri: 'file:///summary', name: 'summary', _meta: { nested: [null, true, 3] } },
      });
      expect(environment.parts()[1]).toMatchObject({ summary: [{ type: 'resource_link', uri: 'file:///summary', name: 'summary', _meta: { nested: [null, true, 3] } }] });
      controller.handleSessionUpdate(SESSION_ID, {
        kind: 'compactionUpdate', compactionId: 'c1', status: 'completed',
        summary: { present: true, value: [{ type: 'text', text: 'Summary' }] }, error: { present: true, value: '' },
      });
      expect(environment.parts()[1]).toMatchObject({ status: 'completed', summary: [{ type: 'text', text: 'Summary' }], error: '', open: false });
      controller.handleSessionUpdate(SESSION_ID, {
        kind: 'compactionUpdate', compactionId: 'c1', status: 'completed',
        summary: { present: true, value: null }, error: { present: true, value: null },
      });
      expect(environment.parts()[1]).toMatchObject({ summary: [], error: null });
      controller.handleSessionUpdate(SESSION_ID, {
        kind: 'compactionUpdate', compactionId: 'c1', status: 'completed',
        summary: { present: true, value: [] }, error: { present: false },
      });
      controller.handleSessionUpdate(SESSION_ID, { kind: 'agentText', messageId: 'm2', text: 'After' });
      controller.handleSessionUpdate(SESSION_ID, { kind: 'usage', used: 10, size: 100, cost: null });

      expect(environment.parts()).toEqual([
        { kind: 'message', messageId: 'm1', text: 'Before' },
        { kind: 'compaction', compactionId: 'c1', status: 'completed', summary: [], error: null,
          open: false, startedAt: null, endedAt: null, timingAllowed: false },
        { kind: 'message', messageId: 'm2', text: 'After' },
      ]);
      expect(environment.transcript().usage).toEqual({ used: 10, size: 100, cost: null });
    });

    it('drops both compaction variants for other sessions or without an active session', () => {
      const { sessions, environment, controller } = setup();
      const patch: SessionUpdate = {
        kind: 'compactionUpdate', compactionId: 'c1', status: 'in_progress',
        summary: { present: false }, error: { present: false },
      };
      const chunk: SessionUpdate = { kind: 'compactionSummaryChunk', compactionId: 'c1', content: { type: 'text', text: 'Summary' } };
      controller.handleSessionUpdate('other', patch);
      controller.handleSessionUpdate('other', chunk);
      sessions.activeId = null;
      controller.handleSessionUpdate(SESSION_ID, patch);
      controller.handleSessionUpdate(SESSION_ID, chunk);
      expect(environment.take()).toEqual([]);
    });

    it('drops other-session usage and reports received without an active session', () => {
      const { sessions, environment, controller } = setup();

      controller.handleSessionUpdate('other', { kind: 'usage', used: 999, size: 200000, cost: null });
      controller.handleSessionUpdate(SESSION_ID, { kind: 'usage', used: 1000, size: 200000, cost: null });
      sessions.activeId = null;
      controller.handleSessionUpdate(SESSION_ID, { kind: 'usage', used: 2000, size: 200000, cost: null });

      expect(environment.take()).toHaveLength(1);
      expect(environment.transcript().usage).toEqual({ used: 1000, size: 200000, cost: null });
    });

    it('replaces prior usage only when replay commits and clears absent replay usage', () => {
      const { environment, controller } = setup();
      controller.handleSessionUpdate(SESSION_ID, { kind: 'usage', used: 90000, size: 200000, cost: { amount: 1.25, currency: 'USD' } });
      environment.take();

      controller.notifyLoadSessionStart(SESSION_ID);
      controller.notifyLoadSessionEnd(true);
      expect(environment.take().map((message) => message.type)).toEqual(['loadSessionStart', 'contentSnapshot', 'loadSessionEnd']);
      expect(environment.transcript().usage).toBeNull();

      controller.notifyLoadSessionStart(SESSION_ID);
      controller.handleSessionUpdate(SESSION_ID, { kind: 'usage', used: 15000, size: 100000, cost: null });
      expect(environment.transcript().usage).toBeNull();
      controller.notifyLoadSessionEnd(true);
      expect(environment.transcript().usage).toEqual({ used: 15000, size: 100000, cost: null });
    });

    it("passes on text, tool calls, the plan and slash commands in the webview's terms", () => {
      const projected = (input: SessionUpdate) => {
        const { controller, environment } = setup();
        controller.handleSessionUpdate(SESSION_ID, input);
        return environment;
      };
      expect(projected({ kind: 'agentText', messageId: 'm1', text: 'Hi' }).parts()).toEqual([{ kind: 'message', messageId: 'm1', text: 'Hi' }]);
      expect(projected({ kind: 'thoughtText', messageId: null, text: 'Hm' }).parts()).toMatchObject([{ kind: 'thought', messageId: null, text: 'Hm', open: true }]);
      expect(projected({ kind: 'promptText', messageId: 'u1', text: 'Fix it' }).transcript().entries).toEqual([{ kind: 'prompt', id: 1, messageId: 'u1', text: 'Fix it' }]);
      expect(projected({ kind: 'agentMessage', messageId: 'm1', text: 'Hi all' }).parts()).toEqual([{ kind: 'message', messageId: 'm1', text: 'Hi all' }]);
      expect(projected({ kind: 'thoughtMessage', messageId: 'r1', text: 'Hmm' }).parts()).toMatchObject([{ kind: 'thought', messageId: 'r1', text: 'Hmm', open: true }]);
      expect(projected({ kind: 'promptMessage', messageId: 'u1', text: 'Fix' }).transcript().entries).toEqual([{ kind: 'prompt', id: 1, messageId: 'u1', text: 'Fix' }]);
      expect(projected({ kind: 'toolCall', toolCallId: 't1', title: 'Run tests', status: 'running', content: [
        { kind: 'text', text: 'ok' },
        { kind: 'diff', diff: { kind: 'wholeFile', path: '/work/a.ts', oldText: 'a', newText: 'b' } },
        { kind: 'text', text: 'done' },
      ] }).parts()).toEqual([
        { kind: 'toolCalls', collapsed: false, toolCalls: [{ toolCallId: 't1', title: 'Run tests', status: 'running', open: false, content: [{ kind: 'text', text: 'ok' }, { kind: 'text', text: 'done' }] }] },
      ]);
      for (const input of [{ kind: 'toolCall', toolCallId: 't1', content: [] }, { kind: 'toolCall', toolCallId: 't1' }] satisfies SessionUpdate[]) {
        expect(projected(input).parts()).toEqual([{ kind: 'toolCalls', collapsed: false, toolCalls: [{ toolCallId: 't1', title: '', status: 'pending', open: false, content: [] }] }]);
      }
      expect(projected({ kind: 'plan', steps: [{ text: 'Read', status: 'completed' }, { text: 'Edit', status: 'running' }] }).parts()).toEqual([
        { kind: 'plan', steps: [{ text: 'Read', status: 'completed' }, { text: 'Edit', status: 'running' }] },
      ]);
      expect(translated({ kind: 'commands', commands: [{ name: 'review', description: 'Review', takesInput: true, hint: 'what' }] })).toEqual([
        { type: 'commands', commands: [{ name: 'review', description: 'Review', takesInput: true, hint: 'what' }] },
      ]);
    });

    it("passes on a tool call's diffs of both kinds as their files, while your-turn.showToolCallDiffs is on, in the order reported among its texts", () => {
      const { sessions, environment, controller } = setup();
      sessions.session = sessionInfo();
      environment.showsDiffs = true;

      controller.handleSessionUpdate(SESSION_ID, { kind: 'toolCall', toolCallId: 't1', content: [
        { kind: 'diff', diff: { kind: 'wholeFile', path: '/work/project/new.ts', oldText: null, newText: 'a' } },
        { kind: 'text', text: 'moved' },
        { kind: 'diff', diff: {
          kind: 'changes',
          changes: [
            { operation: 'move', path: '/work/project/to.ts', oldPath: '/work/project/from.ts', fileType: 'text', mimeType: null },
            { operation: 'delete', path: '/work/old.bin', fileType: 'binary', mimeType: 'application/octet-stream' },
          ],
          patch: { format: 'git_patch', text: 'diff --git /work/project/from.ts /work/project/to.ts\n' },
        } },
        { kind: 'diff', diff: { kind: 'changes', changes: [{ operation: 'add', path: '/work/project/dir', fileType: 'directory', mimeType: null }], patch: null } },
      ] });

      const file = { oldPath: null, added: 0, removed: 0, hunks: [], note: null, opens: 'file' } as const;
      expect(environment.parts()).toEqual([{ kind: 'toolCalls', collapsed: false, toolCalls: [{ toolCallId: 't1', title: '', status: 'pending', open: false, content: [
        { kind: 'diff', files: [{
          ...file,
          operation: 'add',
          path: 'new.ts',
          added: 1,
          hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+a'] }],
          opens: 'fileAndChanges',
        }] },
        { kind: 'text', text: 'moved' },
        { kind: 'diff', files: [
          { ...file, operation: 'move', path: 'to.ts', oldPath: 'from.ts', note: 'noLines' },
          { ...file, operation: 'delete', path: '/work/old.bin', note: 'binary' },
        ] },
        { kind: 'diff', files: [{ ...file, operation: 'add', path: 'dir', note: 'noPatch', opens: null }] },
      ] }] }]);
    });

    it('reads your-turn.showToolCallDiffs for each tool call update', () => {
      const { sessions, environment, controller } = setup();
      sessions.session = sessionInfo();
      const edited: SessionUpdate = { kind: 'toolCall', toolCallId: 't1', content: [
        { kind: 'text', text: 'edited' },
        { kind: 'diff', diff: { kind: 'wholeFile', path: '/work/a.ts', oldText: 'a', newText: 'b' } },
      ] };

      controller.handleSessionUpdate(SESSION_ID, edited);
      expect(environment.parts()).toMatchObject([{ toolCalls: [{ content: [{ kind: 'text', text: 'edited' }] }] }]);
      environment.showsDiffs = true;
      controller.handleSessionUpdate(SESSION_ID, edited);
      expect(environment.parts()).toMatchObject([{ toolCalls: [{ content: [
        { kind: 'text', text: 'edited' },
        { kind: 'diff', files: [{ operation: 'modify', path: '/work/a.ts', oldPath: null, added: 1, removed: 1,
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }], note: null, opens: 'fileAndChanges' }] },
      ] }] }]);
      environment.showsDiffs = false;
      controller.handleSessionUpdate(SESSION_ID, edited);
      expect(environment.parts()).toMatchObject([{ toolCalls: [{ content: [{ kind: 'text', text: 'edited' }] }] }]);
    });

    it("passes on a tool call's terminals by ID, and tells the webview of each terminal once its changes settle, for the active session only", async () => {
      vi.useFakeTimers();
      onTestFinished(() => { vi.useRealTimers(); });
      const { sessions, environment, controller } = setup();
      sessions.session = sessionInfo();
      const feed = (sessionId: string, update: SessionUpdate) => {
        controller.handleSessionUpdate(sessionId, update);
      };

      feed(SESSION_ID, { kind: 'toolCall', toolCallId: 'c1', toolKind: 'execute', content: [{ kind: 'terminal', terminalId: 'term' }] });
      feed(SESSION_ID, { kind: 'terminal', terminalId: 'term', command: 'npm test' });
      feed(SESSION_ID, { kind: 'terminalOutput', terminalId: 'term', data: new TextEncoder().encode('\x1b[31mfailed\x1b[0m\n') });
      feed('other', { kind: 'terminalOutput', terminalId: 'term', data: new TextEncoder().encode('elsewhere') });
      feed(SESSION_ID, { kind: 'terminal', terminalId: 'term', exitStatus: { exitCode: 1, signal: null } });
      await vi.runAllTimersAsync();

      expect(environment.parts()).toEqual([{ kind: 'toolCalls', collapsed: false, toolCalls: [
        { toolCallId: 'c1', title: '', status: 'pending', toolKind: 'execute', open: false, content: [{ kind: 'terminal', terminalId: 'term' }] },
      ] }]);
      expect(environment.transcript().terminals).toEqual(new Map([
        ['term', { text: 'failed', truncated: false, exitStatus: { exitCode: 1, signal: null } }],
      ]));
    });

    it("posts an execute tool call's title and status at once, and its text once cleaned, as command output", async () => {
      vi.useFakeTimers();
      onTestFinished(() => { vi.useRealTimers(); });
      const { sessions, environment, controller } = setup();
      sessions.session = sessionInfo();

      controller.handleSessionUpdate(SESSION_ID, { kind: 'toolCall', toolCallId: 'c1', title: 'npm test', toolKind: 'execute', status: 'running', content: [
        { kind: 'text', text: 'Downloading 5%\rDownloading done\n' },
      ] });
      expect(environment.parts()).toMatchObject([{ toolCalls: [{ toolCallId: 'c1', title: 'npm test', status: 'running', content: [] }] }]);
      await vi.runAllTimersAsync();

      expect(environment.parts()).toMatchObject([{ toolCalls: [{ toolCallId: 'c1', title: 'npm test', status: 'running',
        content: [{ kind: 'commandOutput', text: 'Downloading done', truncated: false }],
      }] }]);
    });

    it("drops an execute tool call's cleaned text once its session is no longer shown", async () => {
      vi.useFakeTimers();
      onTestFinished(() => { vi.useRealTimers(); });
      const { sessions, environment, controller } = setup();
      sessions.session = sessionInfo();

      controller.handleSessionUpdate(SESSION_ID, { kind: 'toolCall', toolCallId: 'c1', toolKind: 'execute', content: [{ kind: 'text', text: 'ran' }] });
      expect(environment.parts()).toMatchObject([{ toolCalls: [{ toolCallId: 'c1', content: [] }] }]);
      environment.take();
      sessions.activeId = null;
      await vi.runAllTimersAsync();

      expect(environment.take()).toEqual([]);
      expect(sessions.sessionState({ configuredName: 'fake', sessionId: SESSION_ID })?.content.entries).toMatchObject([
        { parts: [{ toolCalls: [{ toolCallId: 'c1', content: [{ kind: 'commandOutput', output: { text: 'ran', truncated: false } }] }] }] },
      ]);
    });

    describe('retained output belongs to the open tab, not the controller', () => {
    function shown() {
      const { sessions, controller } = setup();
      const selected = sessions.requireSession();
        for (const sessionId of [SESSION_ID, OTHER_SESSION_ID]) {
          const registration = { agentName: 'fake', agentId: 'source', sessionId };
          sessions.retained.attach(registration);
          sessions.retained.accept(registration, { kind: 'terminalOutput', terminalId: 't1', data: new TextEncoder().encode('out') }, 0);
        }
        controller.notifyActiveSessionChanged();
        /** The session is removed, as the session manager removes it, and no session is shown. */
      const removed = () => {
          sessions.retained.retireSource('source');
        controller.notifySessionRemoved(selected);
          sessions.activeId = null;
          controller.notifyActiveSessionChanged();
        };
        const retained = (sessionId: string) => sessions.retained.openCommandOutput({ configuredName: 'fake', sessionId }, { kind: 'terminal', terminalId: 't1' }, 'Output');
      return { sessions, retained, controller, removed, selected };
      }

      it('stays after exit and selection changes until its tab closes', () => {
      const { sessions, retained, controller, removed, selected } = shown();

      controller.notifySessionEnded(selected, 'Fake exited unexpectedly (code 1).');
      removed();
        expect(retained(SESSION_ID)).toBe(true);

        sessions.activeId = OTHER_SESSION_ID;
        controller.notifyActiveSessionChanged();
        expect(retained(SESSION_ID)).toBe(true);
        sessions.retained.release({ configuredName: 'fake', sessionId: SESSION_ID });
        expect(retained(SESSION_ID)).toBe(false);
        expect(retained(OTHER_SESSION_ID)).toBe(true);
      });

      it('stays after disconnect until its tab closes without releasing another tab', () => {
        const { sessions, retained, removed } = shown();

      removed();

        expect(retained(SESSION_ID)).toBe(true);
        sessions.retained.release({ configuredName: 'fake', sessionId: SESSION_ID });
        expect(retained(SESSION_ID)).toBe(false);
        expect(retained(OTHER_SESSION_ID)).toBe(true);
      });

      it('does not release retained output when the presentation is cleared', () => {
      const { retained, controller, removed, selected } = shown();
      controller.notifySessionEnded(selected, 'Fake exited unexpectedly (code 1).');
      removed();

        controller.clearTranscript();

        expect(retained(SESSION_ID)).toBe(true);
      });
    });

    it("replaces a removed session's command kind when the agent loads replacement content", () => {
      const { sessions, environment, controller } = setup();
      sessions.session = sessionInfo();
      controller.handleSessionUpdate(SESSION_ID, { kind: 'toolCall', toolCallId: 'c1', toolKind: 'execute' });

    controller.notifySessionRemoved(sessions.session);
      controller.notifyLoadSessionStart(SESSION_ID);
      environment.take();
      controller.handleSessionUpdate(SESSION_ID, { kind: 'toolCall', toolCallId: 'c1', content: [{ kind: 'text', text: 'ran' }] });
      controller.notifyLoadSessionEnd(true);

      expect(environment.parts()).toEqual([{ kind: 'toolCalls', collapsed: false, toolCalls: [
        { toolCallId: 'c1', title: '', status: 'pending', open: false, content: [{ kind: 'text', text: 'ran' }] },
      ] }]);
    });

    it('reports pickers from the session once it has applied the change', () => {
      expect(translated({ kind: 'configOptions', options: [{ ...modelOption, current: 'b' }] })).toEqual([
        { type: 'pickers', pickers: [{ ...modelPicker, current: 'b' }] },
      ]);
      expect(translated({ kind: 'currentMode', modeId: 'code' }, sessionInfo({ configOptions: null, modes }))).toEqual([
        { type: 'pickers', pickers: [{ ...modePicker, current: 'code' }] },
      ]);
    });

    it('drops the updates the chat view has no place for', () => {
      expect(translated({ kind: 'sessionInfo', updatedAt: '2026-10-20T00:00:00Z' })).toEqual([]);
    });

    it('applies commands, config options, the mode and session info even before the session is active', () => {
      const { sessions, environment, controller } = setup();
      sessions.activeId = null;
      const commands = [{ name: 'init', description: 'Init', takesInput: false, hint: null }];

      controller.handleSessionUpdate(OTHER_SESSION_ID, { kind: 'commands', commands });
      controller.handleSessionUpdate(OTHER_SESSION_ID, { kind: 'configOptions', options: [modelOption] });
      controller.handleSessionUpdate(OTHER_SESSION_ID, { kind: 'currentMode', modeId: 'code' });
      controller.handleSessionUpdate(OTHER_SESSION_ID, { kind: 'sessionInfo', title: 'Title' });

      expect(sessions.applyAvailableCommands).toHaveBeenCalledExactlyOnceWith({ configuredName: 'fake', sessionId: OTHER_SESSION_ID }, commands);
      expect(sessions.applyConfigOptions).toHaveBeenCalledExactlyOnceWith({ configuredName: 'fake', sessionId: OTHER_SESSION_ID }, [modelOption]);
      expect(sessions.applyCurrentMode).toHaveBeenCalledExactlyOnceWith({ configuredName: 'fake', sessionId: OTHER_SESSION_ID }, 'code');
      expect(sessions.applySessionInfoUpdate).toHaveBeenCalledExactlyOnceWith({ configuredName: 'fake', sessionId: OTHER_SESSION_ID }, expect.objectContaining({ title: 'Title' }));
      expect(environment.take()).toEqual([]);
    });
  });

  describe('text chunks', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      onTestFinished(() => { vi.useRealTimers(); });
    });

    const answerChunk = (text: string, messageId: string | null = null): SessionUpdate => ({ kind: 'agentText', messageId, text });

    it('joins the text of a frame into one message', () => {
      const { environment, controller } = setup();
      controller.handleSessionUpdate(SESSION_ID, { kind: 'usage', used: 0, size: 100, cost: null });
      environment.take();

      for (const text of ['Hel', 'lo', ' world']) {
        controller.handleSessionUpdate(SESSION_ID, answerChunk(text));
        vi.advanceTimersByTime(5);
      }
      expect(environment.take()).toEqual([]);

      vi.advanceTimersByTime(1);
      expect(environment.take()).toMatchObject([{ type: 'contentPatch', patches: [{ kind: 'insert', entries: [
        { kind: 'turn', parts: [{ kind: 'message', messageId: null, text: 'Hello world' }] },
      ] }] }]);

      controller.handleSessionUpdate(SESSION_ID, answerChunk('!'));
      vi.advanceTimersByTime(16);
      expect(environment.take()).toMatchObject([{ type: 'contentPatch', patches: [{ kind: 'appendText', text: '!' }] }]);
      expect(environment.parts()).toEqual([{ kind: 'message', messageId: null, text: 'Hello world!' }]);
    });

    it('sends the text before anything that follows it, without waiting', async () => {
      const { sessions, environment, controller } = setup();
      const turn = sendPrompt(controller, sessions, 'hello');
      environment.take();

      controller.handleSessionUpdate(SESSION_ID, answerChunk('reading'));
      controller.handleSessionUpdate(SESSION_ID, toolCall);
      expect(environment.parts()).toEqual([
        { kind: 'message', messageId: null, text: 'reading' },
        { kind: 'toolCalls', collapsed: false, toolCalls: [{ toolCallId: 't1', title: 'Read', status: 'pending', content: [], open: false }] },
      ]);
      controller.handleSessionUpdate(SESSION_ID, answerChunk('done'));
      sessions.answer();
      await turn;

      expect(environment.parts().at(-1)).toEqual({ kind: 'message', messageId: null, text: 'done' });
      expect(environment.take().at(-1)).toEqual({ type: 'promptEnd' });
      vi.advanceTimersByTime(16);
      expect(environment.take()).toEqual([]);
    });

    it("sends a message's whole text without waiting, after the text before it, and joins none of it", () => {
      const { environment, controller } = setup();

      controller.handleSessionUpdate(SESSION_ID, answerChunk('Hel', 'm1'));
      expect(environment.parts()).toEqual([{ kind: 'message', messageId: 'm1', text: 'Hel' }]);
      controller.handleSessionUpdate(SESSION_ID, { kind: 'agentMessage', messageId: 'm1', text: 'Hello' });
      expect(environment.parts()).toEqual([{ kind: 'message', messageId: 'm1', text: 'Hello', markdownRevision: 1 }]);
      environment.take();
      controller.handleSessionUpdate(SESSION_ID, answerChunk('!', 'm1'));

      expect(environment.take()).toEqual([]);
      vi.advanceTimersByTime(16);
      expect(environment.take()).toMatchObject([{ type: 'contentPatch', patches: [{ kind: 'appendText', text: '!' }] }]);
      expect(environment.parts()).toEqual([{ kind: 'message', messageId: 'm1', text: 'Hello!', markdownRevision: 1 }]);
    });

    it('keeps text of different kinds or messages apart', () => {
      const { environment, controller } = setup();

      controller.handleSessionUpdate(SESSION_ID, { kind: 'promptText', messageId: 'u1', text: 'q' });
      controller.handleSessionUpdate(SESSION_ID, { kind: 'promptText', messageId: 'u2', text: 'r' });
      controller.handleSessionUpdate(SESSION_ID, { kind: 'thoughtText', messageId: null, text: 'hm' });
      controller.handleSessionUpdate(SESSION_ID, { kind: 'thoughtText', messageId: null, text: 'm' });
      controller.handleSessionUpdate(SESSION_ID, answerChunk('a', 'm1'));
      controller.handleSessionUpdate(SESSION_ID, answerChunk('b', 'm2'));
      vi.advanceTimersByTime(16);

      expect(environment.transcript().entries).toEqual([
        { kind: 'prompt', id: 1, messageId: 'u1', text: 'q' },
        { kind: 'prompt', id: 2, messageId: 'u2', text: 'r' },
        { kind: 'turn', id: 3, parts: [
          { kind: 'thought', messageId: null, text: 'hmm', startedAt: expect.any(Number) as number, endedAt: expect.any(Number) as number, open: false },
          { kind: 'message', messageId: 'm1', text: 'a' },
          { kind: 'message', messageId: 'm2', text: 'b' },
        ] },
      ]);
    });
  });

  describe('transcript file links', () => {
    it('resolves outside the session directory and ignores a stale click', async () => {
      const parts = setup();
      const target = await issuedTarget(parts);
      const click = { type: 'openTranscriptFile' as const, target, destination: '../plan%23draft.md#overview' };
      parts.editor.exists.mockResolvedValue(true);
      await parts.controller.handleMessage(click);
      await issuedTarget(parts);
      await parts.controller.handleMessage(click);
      expect(parts.editor.open.mock.calls.map(([path]) => path)).toEqual(['/work/plan#draft.md']);
    });

    it.each([
      ['missing.md', 'File not found'],
      ['file://server/share/plan.md', 'Hostless'],
      ['command:workbench.action.files.save', 'Unsupported file link'],
    ])('warns and does not open %s', async (destination, reason) => {
      const parts = setup();
      const target = await issuedTarget(parts);
      await parts.controller.handleMessage({ type: 'openTranscriptFile', target, destination });
      expect(parts.editor.open).not.toHaveBeenCalled();
      expect(parts.editor.warnFileOpen.mock.calls[0]?.[0]).toContain(`${destination}: ${reason}`);
    });
  });

  describe("a tool call's files", () => {
    /** A controller shown a tool call of three files: an edit, a binary file reported without lines, and a patch. */
    function withFiles() {
      const parts = setup();
      parts.environment.showsDiffs = true;
      parts.controller.handleSessionUpdate(SESSION_ID, { kind: 'toolCall', toolCallId: 't1', content: [
        { kind: 'diff', diff: { kind: 'wholeFile', path: '/work/a.ts', oldText: 'a\n', newText: 'b\n' } },
        { kind: 'diff', diff: {
          kind: 'changes',
          changes: [
            { operation: 'modify', path: '/work/b.bin', fileType: 'binary', mimeType: null },
            { operation: 'modify', path: '/work/c.ts', fileType: 'text', mimeType: null },
          ],
          patch: { format: 'git_patch', text: '--- /work/c.ts\n+++ /work/c.ts\n@@ -1 +1 @@\n-a\n+c\n' },
        } },
      ] });
      const snapshot = contentSnapshots(parts.environment.take()).at(-1);
      if (!snapshot) { throw new Error('Missing diff projection'); }
      return { ...parts, target: snapshot.target };
    }

    it("opens the file the webview names by its place across the tool call's diffs, and its changes in the diff editor", async () => {
      const { editor, controller, target } = withFiles();

      await controller.handleMessage({ type: 'openFile', target, toolCallId: 't1', file: 0 });
      await controller.handleMessage({ type: 'openChanges', target, toolCallId: 't1', file: 0 });

      expect(editor.open.mock.calls).toEqual([['/work/a.ts']]);
      expect(editor.showChanges.mock.calls).toEqual([['/work/a.ts', 'a\n', 'b\n']]);
    });

    it("undoes a patch's hunks as the agent sent them on the file as it is now", async () => {
      const { editor, controller, target } = withFiles();
      editor.readText.mockResolvedValueOnce('c\n');

      await controller.handleMessage({ type: 'openChanges', target, toolCallId: 't1', file: 2 });

      expect(editor.showChanges.mock.calls).toEqual([['/work/c.ts', 'a\n', 'c\n']]);
    });

    it('opens a file without lines but shows no changes of it, and opens nothing it was not shown', async () => {
      const { sessions, editor, controller, target } = withFiles();

      await controller.handleMessage({ type: 'openChanges', target, toolCallId: 't1', file: 1 });
      await controller.handleMessage({ type: 'openFile', target, toolCallId: 't1', file: 3 });
      await controller.handleMessage({ type: 'openFile', target, toolCallId: 'unknown', file: 0 });
      sessions.activeId = OTHER_SESSION_ID;
      await controller.handleMessage({ type: 'openFile', target, toolCallId: 't1', file: 0 });
      sessions.activeId = SESSION_ID;
      await controller.handleMessage({ type: 'openFile', target, toolCallId: 't1', file: 1 });

      expect(editor.open.mock.calls).toEqual([['/work/b.bin']]);
      expect(editor.showChanges).not.toHaveBeenCalled();
    });

    it('rejects a native diff command from a superseded projection of the same session', async () => {
      const { environment, editor, controller } = withFiles();
      await controller.handleMessage({ type: 'ready' });
      const snapshot = contentSnapshots(environment.take()).at(-1);
      if (!snapshot) { throw new Error('Missing projection'); }
      const captured = { toolCallId: 't1', file: 0, open: 'changes' as const, target: snapshot.target };
      await controller.handleMessage({ type: 'ready' });
      environment.take();

      await controller.chooseDiffFile(captured);

      expect(editor.showChanges).not.toHaveBeenCalled();
      expect(editor.open).not.toHaveBeenCalled();
    });

    it('rejects a webview diff click from a superseded projection', async () => {
      const { environment, editor, controller } = withFiles();
      await controller.handleMessage({ type: 'ready' });
      const snapshot = contentSnapshots(environment.take()).at(-1);
      if (!snapshot) { throw new Error('Missing projection'); }
      await controller.handleMessage({ type: 'ready' });
      const click = { type: 'openFile' as const, target: snapshot.target, toolCallId: 't1', file: 0 };

      await controller.handleMessage(click);

      expect(editor.open).not.toHaveBeenCalled();
    });

    it('rejects a webview diff click captured before selection moves away and back', async () => {
      const { editor, controller, sessions, target } = withFiles();
      const original = sessions.session;
      sessions.session = sessionInfo({ sessionId: OTHER_SESSION_ID });
      sessions.activeId = OTHER_SESSION_ID;
      controller.notifyActiveSessionChanged();
      sessions.session = original;
      sessions.activeId = SESSION_ID;
      controller.notifyActiveSessionChanged();

      await controller.handleMessage({ type: 'openFile', target, toolCallId: 't1', file: 0 });

      expect(editor.open).not.toHaveBeenCalled();
    });

    it.each(['configuredName', 'sessionId', 'generation', 'projection'] as const)('rejects a native diff command with a different %s', async (field) => {
      const { environment, editor, controller } = withFiles();
      await controller.handleMessage({ type: 'ready' });
      const snapshot = contentSnapshots(environment.take()).at(-1);
      if (!snapshot) { throw new Error('Missing projection'); }
      const target = { ...snapshot.target, [field]: typeof snapshot.target[field] === 'number' ? 999 : 'other' };

      await controller.chooseDiffFile({ target, toolCallId: 't1', file: 0, open: 'changes' });

      expect(editor.showChanges).not.toHaveBeenCalled();
      expect(editor.open).not.toHaveBeenCalled();
    });

    it('rejects a native diff command after controller disposal', async () => {
      const { environment, editor, controller } = withFiles();
      await controller.handleMessage({ type: 'ready' });
      const snapshot = contentSnapshots(environment.take()).at(-1);
      if (!snapshot) { throw new Error('Missing projection'); }
      await controller.dispose();

      await controller.chooseDiffFile({ target: snapshot.target, toolCallId: 't1', file: 0, open: 'changes' });

      expect(editor.showChanges).not.toHaveBeenCalled();
      expect(editor.open).not.toHaveBeenCalled();
    });

    it('opens the file chosen from the context menu itself, telling the webview nothing', async () => {
      const { environment, editor, controller } = withFiles();
      await controller.handleMessage({ type: 'ready' });
      const snapshot = contentSnapshots(environment.take()).at(-1);
      if (!snapshot) { throw new Error('Missing projection'); }

      await controller.chooseDiffFile({ target: snapshot.target, toolCallId: 't1', file: 0, open: 'changes' });

      expect(editor.showChanges.mock.calls).toEqual([['/work/a.ts', 'a\n', 'b\n']]);
      expect(environment.take()).toEqual([]);
    });

    it("retains a removed session's files and replaces them after successful load", async () => {
      const removed = withFiles();
      removed.controller.notifySessionRemoved(removed.sessions.requireSession());
      await removed.controller.handleMessage({ type: 'openFile', target: removed.target, toolCallId: 't1', file: 0 });

      const reloaded = withFiles();
      reloaded.controller.notifyLoadSessionStart(SESSION_ID);
      reloaded.controller.notifyLoadSessionEnd(true);
      await reloaded.controller.handleMessage({ type: 'openFile', target: reloaded.target, toolCallId: 't1', file: 0 });

      expect(removed.editor.open).toHaveBeenCalledExactlyOnceWith('/work/a.ts');
      expect(reloaded.editor.open).not.toHaveBeenCalled();
    });

    it('logs a file the editor fails to open, as nothing else is waiting on it', async () => {
      const { editor, controller, target } = withFiles();
      const failure = new Error('no editor');
      editor.open.mockRejectedValueOnce(failure);
      const errors: unknown[][] = [];
      setLogSink({ trace() {}, debug() {}, info() {}, warn() {}, error: (...args) => errors.push(args) });

      try {
        await expect(controller.handleMessage({ type: 'openFile', target, toolCallId: 't1', file: 0 })).resolves.toBeUndefined();
      } finally {
        setLogSink(undefined);
      }

      expect(errors).toEqual([['Failed to open /work/a.ts', failure]]);
    });
  });
});
