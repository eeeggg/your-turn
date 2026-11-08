export type TrafficDirection = 'send' | 'recv';

const MAX_TRAFFIC_BYTES = 50_000_000;
const UTF8_ENCODER = new TextEncoder();

interface RecordNode {
  readonly line: string;
  readonly bytes: number;
  next?: RecordNode;
}

/** Retains the newest complete JSONL records within a UTF-8 byte limit. */
export class TrafficBuffer {
  private firstRecord: RecordNode | undefined;
  private lastRecord: RecordNode | undefined;
  private retainedBytes = 0;

  constructor(
    private readonly maxBytes = MAX_TRAFFIC_BYTES,
    private readonly timestamp: () => string = () => new Date().toISOString(),
  ) {}

  capture(direction: TrafficDirection, message: unknown): void {
    const serialized = JSON.stringify({ timestamp: this.timestamp(), direction, message });
    const line = `${serialized}\n`;
    const bytes = UTF8_ENCODER.encode(line).byteLength;
    if (bytes > this.maxBytes) {
      return;
    }

    while (this.retainedBytes + bytes > this.maxBytes) {
      const oldest = this.firstRecord;
      if (!oldest) {
        break;
      }
      this.firstRecord = oldest.next;
      if (!this.firstRecord) {
        this.lastRecord = undefined;
      }
      this.retainedBytes -= oldest.bytes;
    }

    const record: RecordNode = { line, bytes };
    if (this.lastRecord) {
      this.lastRecord.next = record;
    } else {
      this.firstRecord = record;
    }
    this.lastRecord = record;
    this.retainedBytes += bytes;
  }

  toJsonl(): string {
    const lines: string[] = [];
    for (let record = this.firstRecord; record; record = record.next) {
      lines.push(record.line);
    }
    return lines.join('');
  }

  clear(): void {
    this.firstRecord = undefined;
    this.lastRecord = undefined;
    this.retainedBytes = 0;
  }
}

const trafficBuffer = new TrafficBuffer();
let captureEnabled = false;

/** Enable or pause new captures without clearing records already retained. */
export function setTrafficCaptureEnabled(enabled: boolean): void {
  captureEnabled = enabled;
}

/** Capture an ACP message when traffic capture is enabled. */
export function captureTraffic(direction: TrafficDirection, message: unknown): void {
  if (captureEnabled) {
    trafficBuffer.capture(direction, message);
  }
}

/** Return a snapshot of all retained traffic as JSONL. */
export function getTrafficJsonl(): string {
  return trafficBuffer.toJsonl();
}

/** Clear retained traffic, such as when the extension host deactivates. */
export function clearTraffic(): void {
  trafficBuffer.clear();
}
