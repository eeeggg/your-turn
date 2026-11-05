import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConnector } from '@agentclientprotocol/sdk';
import {
  connectedDriver,
  fakeAgent,
  fakeV2Agent,
  InProcessAgents
} from '@tests/unit/core/InProcessAgents';

const hooks = vi.hoisted(() => ({ cleanup: [] as (() => Promise<void>)[] }));
vi.mock('vitest', async (original) => ({
  ...await original<typeof import('vitest')>(),
  onTestFinished: (cleanup: () => Promise<void>) => { hooks.cleanup.push(cleanup); },
}));

afterEach(async () => {
  await Promise.all(hooks.cleanup.splice(0).map((cleanup) => cleanup()));
  vi.restoreAllMocks();
});

describe('connected driver ownership', () => {
  it.each([fakeAgent, fakeV2Agent])('closes the SDK connection at the test boundary', async (build) => {
    let closed: Promise<void> | undefined;
    const fixture = await connectedDriver(() => {
      const agent: AgentConnector = build();
      return { connect: (stream) => {
        const connection = agent.connect(stream);
        if (connection && typeof connection === 'object' && 'closed' in connection && connection.closed instanceof Promise) { closed = connection.closed as Promise<void>; }
        return connection;
      } };
    });
    try {
      expect(hooks.cleanup).toHaveLength(1);
      await hooks.cleanup[0]?.();
      expect(await closed?.then(() => 'closed')).toBe('closed');
    } finally { await fixture.exit(); }
  });

  it('registers cleanup before connection setup can fail', async () => {
    const failure = new Error('initialize failed');
    const connect = vi.spyOn(InProcessAgents.prototype, 'launch');
    await expect(connectedDriver(() => { throw failure; })).rejects.toBe(failure);
    expect(connect).toHaveBeenCalledOnce();
    expect(hooks.cleanup).toHaveLength(1);
  });

  it('awaits SDK connection closure before completing fixture shutdown', async () => {
    let finish: () => void = () => {};
    const closing = new Promise<void>((resolve) => { finish = resolve; });
    let closed = false;
    const agents = new InProcessAgents({ fake: () => ({ connect: () => ({ closed: closing.then(() => { closed = true; }) }) }) });
    agents.launch('fake', { command: 'fake' }, '/work', { error() {}, exit: () => { setImmediate(finish); } });
    const agent = agents.launched[0];
    expect(agent).toBeDefined();
    try {
      const stopped = agent?.crash().then(() => closed);
      expect(await stopped).toBe(true);
    } finally { finish(); await agent?.crash(); }
  });
});
