import { afterEach, describe, expect, it } from 'vitest';
import {
  captureTraffic,
  clearTraffic,
  getTrafficJsonl,
  setTrafficCaptureEnabled,
  TrafficBuffer
} from '@/core/Traffic';

afterEach(() => {
  clearTraffic();
  setTrafficCaptureEnabled(true);
});

describe('ACP Traffic buffer', () => {
  it('captures each protocol message as a compact timestamped JSONL record', () => {
    const buffer = new TrafficBuffer(1_000, () => '2026-10-28T12:00:00.000Z');

    buffer.capture('send', { method: 'session/prompt', params: { prompt: 'héllo' } });

    expect(buffer.toJsonl()).toBe('{"timestamp":"2026-10-28T12:00:00.000Z","direction":"send","message":{"method":"session/prompt","params":{"prompt":"héllo"}}}\n');
  });

  it('evicts oldest complete records to retain only the newest records within the UTF-8 byte limit', () => {
    const retained = '{"timestamp":"t","direction":"recv","message":{"id":1}}\n';
    const maxBytes = new TextEncoder().encode('{"timestamp":"t","direction":"send","message":{"id":1}}\n').byteLength;
    const buffer = new TrafficBuffer(maxBytes, () => 't');

    buffer.capture('send', { id: 1 });
    buffer.capture('recv', { id: 1 });

    expect(buffer.toJsonl()).toBe(retained);
  });

  it('discards a single record that exceeds the byte limit without disturbing retained records', () => {
    const retained = '{"timestamp":"t","direction":"send","message":{"id":1}}\n';
    const buffer = new TrafficBuffer(new TextEncoder().encode(retained).byteLength, () => 't');
    buffer.capture('send', { id: 1 });

    const multibyteRecord = '{"timestamp":"t","direction":"recv","message":"é"}\n';
    const characterLimit = multibyteRecord.length;
    const constrained = new TrafficBuffer(characterLimit, () => 't');
    constrained.capture('recv', 'é');

    buffer.capture('recv', 'x'.repeat(100));

    expect(constrained.toJsonl()).toBe('');
    expect(buffer.toJsonl()).toBe(retained);
  });

  it('uses UTF-8 byte counts when enforcing the retention limit', () => {
    const record = '{"timestamp":"t","direction":"recv","message":"é"}\n';
    const buffer = new TrafficBuffer(record.length, () => 't');

    buffer.capture('recv', 'é');

    expect(buffer.toJsonl()).toBe('');
  });

  it('clears all retained records and releases their byte budget', () => {
    const buffer = new TrafficBuffer(1_000, () => 't');
    buffer.capture('send', { id: 1 });

    buffer.clear();
    buffer.capture('recv', { id: 2 });

    expect(buffer.toJsonl()).toBe('{"timestamp":"t","direction":"recv","message":{"id":2}}\n');
  });

  it('pauses new captures without clearing retained records', () => {
    clearTraffic();
    setTrafficCaptureEnabled(true);
    captureTraffic('send', { id: 1 });
    setTrafficCaptureEnabled(false);

    captureTraffic('recv', { id: 2 });

    expect(getTrafficJsonl()).toContain('"id":1');
    expect(getTrafficJsonl()).not.toContain('"id":2');
    setTrafficCaptureEnabled(true);
    clearTraffic();
  });
});
