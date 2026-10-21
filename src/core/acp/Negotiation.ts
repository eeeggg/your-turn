import { RequestError } from '@agentclientprotocol/sdk';
import type { AnyMessage, AnyResponse, ErrorResponse, Stream } from '@agentclientprotocol/sdk';

import { v1InitializeRequest } from './V1Driver';
import { v2InitializeRequest } from './V2Driver';

type AcpVersion = 1 | 2;

const SPOKEN = 'this extension speaks versions 1 and 2';

/** ACP v2's error for an agent that speaks no version at or below the requested one. */
const UNSUPPORTED_VERSION = -32022;

/** The version the agent and the extension agreed on, and the stream that version's client connects to. */
export interface Negotiated {
  version: AcpVersion;
  stream: Stream;
}

/**
 * Agree an ACP version with the agent on `stream`: ask for v2, and for v1 when the agent refuses. SDK 2.0.0 has no
 * client-side negotiation and its clients cannot fall back once connected, so the requests go out on the stream
 * itself, and the chosen client's own `initialize` is answered from the agent's answer (see `replaying`).
 */
export async function negotiate(agentName: string, stream: Stream, clientVersion: string): Promise<Negotiated> {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const ask = async (id: string, params: unknown): Promise<AnyResponse> => {
    await writer.write({ jsonrpc: '2.0', id, method: 'initialize', params });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error(`Agent "${agentName}" closed the connection before answering initialize`);
      }
      if (isAnswer(value, id)) {
        return value;
      }
    }
  };

  let answer = await ask('acp-negotiation-v2', v2InitializeRequest(clientVersion));
  if ('error' in answer) {
    refuseUnspoken(agentName, answer.error);
    answer = await ask('acp-negotiation-v1', v1InitializeRequest(clientVersion));
    if ('error' in answer) {
      throw new RequestError(answer.error.code, answer.error.message, answer.error.data);
    }
  }
  const version = protocolVersionOf(answer.result);
  if (version !== 1 && version !== 2) {
    throw new Error(`Agent "${agentName}" answered initialize with ACP version ${String(version)}; ${SPOKEN}`);
  }
  return { version, stream: replaying(reader, writer, answer.result) };
}

function isAnswer(message: AnyMessage, id: string): message is AnyResponse {
  return !('method' in message) && message.id === id;
}

/** A `-32022` lists the versions the agent speaks; without 1 among them, the follow-up cannot succeed either. */
function refuseUnspoken(agentName: string, error: ErrorResponse): void {
  if (error.code !== UNSUPPORTED_VERSION) {
    return;
  }
  const supported = supportedVersions(error.data);
  if (supported && !supported.includes(1)) {
    throw new Error(`Agent "${agentName}" speaks ACP versions ${supported.join(', ')}; ${SPOKEN}`);
  }
}

function supportedVersions(data: unknown): unknown[] | null {
  return typeof data === 'object' && data !== null && 'supported' in data && Array.isArray(data.supported)
    ? data.supported
    : null;
}

function protocolVersionOf(result: unknown): unknown {
  return typeof result === 'object' && result !== null && 'protocolVersion' in result ? result.protocolVersion : undefined;
}

/**
 * The stream the chosen client connects to. Its own `initialize` is answered here with the agent's answer, under the
 * client's request ID, and never reaches the agent, which has answered it already; this holds only while each
 * driver's request is the one the negotiation sent for it. Everything else passes through.
 */
function replaying(
  reader: ReadableStreamDefaultReader<AnyMessage>,
  writer: WritableStreamDefaultWriter<AnyMessage>,
  result: unknown,
): Stream {
  let toClient!: ReadableStreamDefaultController<AnyMessage>;
  let replayed = false;
  return {
    readable: new ReadableStream<AnyMessage>({
      start: (controller) => { toClient = controller; },
      pull: async (controller) => {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    }),
    writable: new WritableStream<AnyMessage>({
      write: async (message) => {
        if (!replayed && 'method' in message && 'id' in message && message.method === 'initialize') {
          replayed = true;
          toClient.enqueue({ jsonrpc: '2.0', id: message.id, result });
          return;
        }
        await writer.write(message);
      },
      close: () => writer.close(),
      abort: (reason) => writer.abort(reason),
    }),
  };
}
