import { connect, createServer, type Socket } from 'node:net';
import { createInterface } from 'node:readline';

/** One in-flight command per isolated test; acknowledgments are observable scheduling boundaries. */
export async function listenControl() {
  let socket: Socket | undefined;
  let failure: Error | undefined;
  let pending: { command: string; response: string; resolve(): void; reject(error: Error): void } | undefined;
  const fail = (error: Error) => {
    failure ??= error;
    pending?.reject(failure);
    pending = undefined;
  };
  const server = createServer((client) => {
    if (socket || failure) { client.destroy(); return; }
    socket = client;
    const lines = createInterface({ input: client });
    client.on('error', fail);
    client.on('close', () => { lines.close(); fail(new Error('UI control connection closed')); });
    lines.on('line', (line) => {
      try {
        const message: unknown = JSON.parse(line);
        if (!pending) { throw new Error('Unexpected UI control acknowledgment'); }
        if (typeof message !== 'object' || message === null) { throw new Error('Invalid UI control acknowledgment'); }
        if ('error' in message && typeof message.error === 'string') { throw new Error(message.error); }
        const response = 'response' in message ? message.response : undefined;
        if (response !== pending.response) { throw new Error(`Expected ${pending.response}, received ${String(response)}`); }
        pending.resolve();
        pending = undefined;
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    if (pending) { client.write(`${JSON.stringify(pending.command)}\n`); }
  });
  server.on('error', fail);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') { throw new Error('Missing UI control endpoint'); }
  let closing: Promise<void> | undefined;
  return {
    port: address.port,
    request(command: string, response: string): Promise<void> {
      if (failure) { return Promise.reject(failure); }
      if (pending) { return Promise.reject(new Error('A UI control request is already pending')); }
      return new Promise<void>((resolve, reject) => {
        pending = { command, response, resolve, reject };
        socket?.write(`${JSON.stringify(command)}\n`);
      });
    },
    close(): Promise<void> {
      fail(new Error('UI control endpoint closed'));
      socket?.destroy();
      closing ??= new Promise<void>((resolve) => { server.close(() => resolve()); });
      return closing;
    },
  };
}

/** The extension-side handler owns scheduling only, never the result of the product operation. */
export function connectControl(port: number, handle: (command: string, signal: AbortSignal) => Promise<string>) {
  const socket = connect(port, '127.0.0.1');
  const lifetime = new AbortController();
  const lines = createInterface({ input: socket });
  const close = () => { lifetime.abort(); lines.close(); socket.destroy(); };
  socket.on('error', close);
  socket.on('close', close);
  void (async () => {
    try {
      for await (const line of lines) {
        try {
          const command: unknown = JSON.parse(line);
          if (typeof command !== 'string') { throw new Error('Invalid UI control command'); }
          const response = await handle(command, lifetime.signal);
          if (!socket.destroyed) { socket.write(`${JSON.stringify({ response })}\n`); }
        } catch (error) {
          if (!socket.destroyed) { socket.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`); }
        }
      }
    } finally { close(); }
  })().catch(close);
  return { close };
}
