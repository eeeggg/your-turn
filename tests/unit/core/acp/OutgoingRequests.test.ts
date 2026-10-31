import { expect, it } from 'vitest';
import type { AnyMessage } from '@agentclientprotocol/sdk';
import { OutgoingRequests } from '@/core/acp/OutgoingRequests';

it('tracks actual outside-session wire IDs, preserves ID types, and removes answered or closed requests', async () => {
  const tracker = new OutgoingRequests();
  const outgoing = new TransformStream<AnyMessage, AnyMessage>();
  const incoming = new TransformStream<AnyMessage, AnyMessage>();
  const stream = tracker.observe({ writable: outgoing.writable, readable: incoming.readable });
  const writer = stream.writable.getWriter();
  const agentReads = outgoing.readable.getReader();
  const agentWrites = incoming.writable.getWriter();
  const reader = stream.readable.getReader();
  const initialize: AnyMessage = { jsonrpc: '2.0', id: 'acp-negotiation-v2', method: 'initialize', params: {} };
  const sent = writer.write(initialize);
  expect((await agentReads.read()).value).toEqual(initialize);
  await sent;
  expect(tracker.has('acp-negotiation-v2')).toBe(true);
  expect(tracker.has(0)).toBe(false);
  const reply: AnyMessage = { jsonrpc: '2.0', id: 'acp-negotiation-v2', result: {} };
  const replied = agentWrites.write(reply);
  expect((await reader.read()).value).toEqual(reply);
  await replied;
  expect(tracker.has('acp-negotiation-v2')).toBe(false);
  for (const message of [
    { jsonrpc: '2.0', id: 7, method: 'authenticate', params: {} },
    { jsonrpc: '2.0', id: '7', method: 'session/prompt', params: { sessionId: 's1' } },
  ] as AnyMessage[]) {
    const sending = writer.write(message);
    await agentReads.read();
    await sending;
  }
  expect(tracker.has(7)).toBe(true);
  expect(tracker.has('7')).toBe(false);
  tracker.close();
  expect(tracker.has(7)).toBe(false);
  const closing = agentWrites.close();
  expect((await reader.read()).done).toBe(true);
  await closing;
  await writer.close();
});
