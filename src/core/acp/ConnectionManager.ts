import { ndJsonStream } from '@agentclientprotocol/sdk';
import type { Stream } from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';

import type { AgentStreams } from '@/core/AgentManager';
import type { ClientHandlers, Elicitations, ElicitationInteractions } from '@/core/ClientHandlers';
import { ElicitationRequests } from '@/core/ElicitationRequests';
import { captureTraffic } from '@/core/Traffic';
import { logDebug, logError, logInfo } from '@/core/Log';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import type { AcpDriver } from './AcpDriver';
import { negotiate } from './Negotiation';
import { V1Driver } from './V1Driver';
import { V2Driver } from './V2Driver';
import { OutgoingRequests } from './OutgoingRequests';

/**
 * Opens client-side ACP connections to agents, each spoken through an ACP driver.
 */
export class ConnectionManager {
  constructor(
    private readonly sessionUpdateHandler: SessionUpdateHandler,
    private readonly clientVersion: string,
    private readonly createHandlers: (context: { agentName: string; agentId: string; elicitations: Elicitations & ElicitationInteractions }) => ClientHandlers,
  ) {}

  /** Connect to an agent over its streams and initialize the connection. */
  async connect(agentName: string, streams: AgentStreams, agentId: string = randomUUID()): Promise<AcpDriver> {
    logDebug('Connecting to agent', { agentName });

    const stream = ndJsonStream(streams.input, streams.output);
    const updates = new SessionUpdateHandler();
    updates.addListener((sessionId, update, schema) => this.sessionUpdateHandler.handleUpdate(sessionId, update, schema, agentId));

    // Wrap the stream to capture all ACP traffic separately from diagnostics.
    const outgoing = new OutgoingRequests();
    const tappedStream = outgoing.observe(this.tapStream(stream));
    const connectionElicitations = new ElicitationRequests((id) => outgoing.has(id));
    const handlers = this.createHandlers({ agentName, agentId, elicitations: connectionElicitations });
    const elicitations = handlers.elicitations ?? connectionElicitations;
    let closed = false;
    const close = () => {
      if (closed) { return; }
      closed = true;
      updates.dispose();
      try { elicitations.close(); }
      finally { outgoing.close(); handlers.close?.(); }
    };
    const owned = { ...handlers, elicitations, close };
    try {
      const negotiated = await negotiate(agentName, tappedStream, this.clientVersion);
      logInfo('Negotiated ACP protocol', { agentName, version: negotiated.version });
      return await (negotiated.version === 2
        ? V2Driver.connect(agentName, negotiated.stream, this.clientVersion, updates, owned)
        : V1Driver.connect(agentName, negotiated.stream, this.clientVersion, updates, owned));
    } catch (error) {
      close();
      throw error;
    }
  }

  /**
   * Wrap a Stream to capture all messages in both directions.
   */
  private tapStream(stream: Stream): Stream {
    // Tap outgoing messages (client → agent)
    const sendTap = new TransformStream({
      transform(chunk: unknown, controller: TransformStreamDefaultController) {
        captureTraffic('send', chunk);
        controller.enqueue(chunk);
      },
    });

    // Tap incoming messages (agent → client)
    const recvTap = new TransformStream({
      transform(chunk: unknown, controller: TransformStreamDefaultController) {
        captureTraffic('recv', chunk);
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
