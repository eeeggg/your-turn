import type { AnyMessage, Stream } from '@agentclientprotocol/sdk';

export class OutgoingRequests {
  private readonly pending = new Set<string | number>();

  observe(stream: Stream): Stream {
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    return {
      writable: new WritableStream<AnyMessage>({
        write: async (message) => {
          if ('method' in message && 'id' in message && message.id !== null
            && !(typeof message.params === 'object' && message.params !== null && 'sessionId' in message.params)) {
            this.pending.add(message.id);
          }
          try { await writer.write(message); }
          catch (error) { this.close(); throw error; }
        },
        close: () => { this.close(); return writer.close(); },
        abort: (reason) => { this.close(); return writer.abort(reason); },
      }),
      readable: new ReadableStream<AnyMessage>({
        pull: async (controller) => {
          try {
            const { done, value } = await reader.read();
            if (done) { this.close(); controller.close(); return; }
            if (!('method' in value) && value.id !== null) { this.pending.delete(value.id); }
            controller.enqueue(value);
          } catch (error) { this.close(); controller.error(error); }
        },
        cancel: (reason) => { this.close(); return reader.cancel(reason); },
      }),
    };
  }

  has(id: string | number): boolean { return this.pending.has(id); }
  close(): void { this.pending.clear(); }
}
