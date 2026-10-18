import { client as createClientApp, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { ClientConnection, InitializeResponse, Stream } from '@agentclientprotocol/sdk';

import { AcpClientImpl, type ClientHandlers } from './AcpClientImpl';
import type { AgentStreams } from './AgentManager';
import { SessionUpdateHandler } from './SessionUpdateHandler';
import { log, logError, logTraffic } from './Log';

export interface ConnectionInfo {
  connection: ClientConnection;
  initResponse: InitializeResponse;
}

/**
 * Opens client-side ACP connections to agents and performs the initialize handshake.
 */
export class ConnectionManager {
  constructor(
    private readonly sessionUpdateHandler: SessionUpdateHandler,
    private readonly clientVersion: string,
    private readonly createHandlers: () => ClientHandlers,
  ) {}

  /** Connect to an agent over its streams and initialize the connection. */
  async connect(agentName: string, streams: AgentStreams): Promise<ConnectionInfo> {
    log(`ConnectionManager: connecting to agent ${agentName}`);

    const stream = ndJsonStream(streams.input, streams.output);

    // Wrap the stream to intercept and log all ACP traffic
    const tappedStream = this.tapStream(stream);

    const { files, terminals, permissions } = this.createHandlers();
    const client = new AcpClientImpl(files, terminals, permissions, this.sessionUpdateHandler);

    // The connection must stay open for the agent's lifetime, so use connect()
    // rather than connectWith(), which closes when its callback returns.
    const app = createClientApp({ name: 'vscode-acp-client' })
      .onRequest(methods.client.session.requestPermission, ({ params }) => client.requestPermission(params))
      .onNotification(methods.client.session.update, ({ params }) => client.sessionUpdate(params))
      .onRequest(methods.client.fs.readTextFile, ({ params }) => client.readTextFile(params))
      .onRequest(methods.client.fs.writeTextFile, ({ params }) => client.writeTextFile(params))
      .onRequest(methods.client.terminal.create, ({ params }) => client.createTerminal(params))
      .onRequest(methods.client.terminal.output, ({ params }) => client.terminalOutput(params))
      .onRequest(methods.client.terminal.waitForExit, ({ params }) => client.waitForTerminalExit(params))
      .onRequest(methods.client.terminal.kill, ({ params }) => client.killTerminal(params))
      .onRequest(methods.client.terminal.release, ({ params }) => client.releaseTerminal(params));
    const connection = app.connect(tappedStream);

    // Initialize the connection
    log(`ConnectionManager: initializing connection to agent ${agentName}`);
    const initResponse = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: {
        name: 'vscode-acp-client',
        version: this.clientVersion,
      },
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        terminal: true,
      },
    });

    log(`ConnectionManager: initialized. Agent: ${initResponse.agentInfo?.name || 'unknown'} v${initResponse.agentInfo?.version || '?'}`);

    return { connection, initResponse };
  }

  /**
   * Wrap a Stream to intercept and log all messages in both directions.
   */
  private tapStream(stream: Stream): Stream {
    // Tap outgoing messages (client → agent)
    const sendTap = new TransformStream({
      transform(chunk: unknown, controller: TransformStreamDefaultController) {
        logTraffic('send', chunk);
        controller.enqueue(chunk);
      },
    });

    // Tap incoming messages (agent → client)
    const recvTap = new TransformStream({
      transform(chunk: unknown, controller: TransformStreamDefaultController) {
        logTraffic('recv', chunk);
        controller.enqueue(chunk);
      },
    });

    // Pipe: sendTap.readable → original writable, original readable → recvTap.writable
    // These run in the background — no need to await
    void sendTap.readable.pipeTo(stream.writable).catch(e => logError('Traffic tap send pipe error', e));
    void stream.readable.pipeTo(recvTap.writable).catch(e => logError('Traffic tap recv pipe error', e));

    return {
      writable: sendTap.writable,
      readable: recvTap.readable,
    };
  }
}
