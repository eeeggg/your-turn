import { ndJsonStream } from '@agentclientprotocol/sdk';
import type { Stream } from '@agentclientprotocol/sdk';

import type { AgentStreams } from '@/core/AgentManager';
import type { ClientHandlers } from '@/core/ClientHandlers';
import { log, logError, logTraffic } from '@/core/Log';
import type { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import type { AcpDriver } from './AcpDriver';
import { negotiate } from './Negotiation';
import { V1Driver } from './V1Driver';
import { V2Driver } from './V2Driver';

/**
 * Opens client-side ACP connections to agents, each spoken through an ACP driver.
 */
export class ConnectionManager {
  constructor(
    private readonly sessionUpdateHandler: SessionUpdateHandler,
    private readonly clientVersion: string,
    private readonly createHandlers: () => ClientHandlers,
  ) {}

  /** Connect to an agent over its streams and initialize the connection. */
  async connect(agentName: string, streams: AgentStreams): Promise<AcpDriver> {
    log(`ConnectionManager: connecting to agent ${agentName}`);

    const stream = ndJsonStream(streams.input, streams.output);

    // Wrap the stream to intercept and log all ACP traffic
    const tappedStream = this.tapStream(stream);

    const negotiated = await negotiate(agentName, tappedStream, this.clientVersion);
    log(`ConnectionManager: negotiated ACP v${negotiated.version} with agent ${agentName}`);
    return negotiated.version === 2
      ? V2Driver.connect(agentName, negotiated.stream, this.clientVersion, this.sessionUpdateHandler, this.createHandlers())
      : V1Driver.connect(agentName, negotiated.stream, this.clientVersion, this.sessionUpdateHandler, this.createHandlers());
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
    void sendTap.readable.pipeTo(stream.writable).catch((e: unknown) => logError('Traffic tap send pipe error', e));
    void stream.readable.pipeTo(recvTap.writable).catch((e: unknown) => logError('Traffic tap recv pipe error', e));

    return {
      writable: sendTap.writable,
      readable: recvTap.readable,
    };
  }
}
