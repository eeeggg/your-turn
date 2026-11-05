import * as V1 from '@agentclientprotocol/sdk';
import * as V2 from '@agentclientprotocol/sdk/experimental/v2';
import {
  ElicitationError,
  type ElicitationRequest,
  type ElicitationResponse,
  type ElicitationSchema,
  type ElicitationProperty,
  type ElicitationScope
} from '@/core/acp/AcpDriver';
import type { Elicitations } from '@/core/ClientHandlers';

export async function v1Elicitation(request: V1.CreateElicitationRequest, id: string | number | null, signal: AbortSignal, requests: Elicitations): Promise<V1.CreateElicitationResponse> {
  try {
    const base = { rpcId: id, message: request.message, scope: scope(request) };
    let translated: ElicitationRequest;
    if (V1.CreateElicitationRequest.isForm(request)) {
      translated = { ...base, mode: 'form', requestedSchema: formSchema(request.requestedSchema, v1Property) };
    } else if (V1.CreateElicitationRequest.isUrl(request)) {
      translated = { ...base, mode: 'url', url: request.url, elicitationId: request.elicitationId };
    } else { throw new ElicitationError('invalid', 'Unknown or malformed elicitation mode'); }
    return wireResponse(await requests.create(translated, signal));
  }
  catch (error) {
    if (!(error instanceof ElicitationError)) { throw error; }
    throw error.kind === 'invalid' ? new V1.RequestError(-32602, error.message) : V1.RequestError.requestCancelled();
  }
}

export async function v2Elicitation(request: V2.CreateElicitationRequest, id: string | number | null, signal: AbortSignal, requests: Elicitations): Promise<V2.CreateElicitationResponse> {
  try {
    const base = { rpcId: id, message: request.message, scope: scope(request) };
    let translated: ElicitationRequest;
    if (V2.CreateElicitationRequest.isForm(request)) {
      translated = { ...base, mode: 'form', requestedSchema: formSchema(request.requestedSchema, v2Property) };
    } else if (V2.CreateElicitationRequest.isUrl(request)) {
      translated = { ...base, mode: 'url', url: request.url, elicitationId: request.elicitationId };
    } else { throw new ElicitationError('invalid', 'Unknown or malformed elicitation mode'); }
    return wireResponse(await requests.create(translated, signal));
  }
  catch (error) {
    if (!(error instanceof ElicitationError)) { throw error; }
    throw error.kind === 'invalid' ? new V2.RequestError(-32602, error.message) : V2.RequestError.requestCancelled();
  }
}

function scope(request: V1.CreateElicitationRequest | V2.CreateElicitationRequest): ElicitationScope {
  const sessionId = 'sessionId' in request ? request.sessionId : undefined;
  const requestId = 'requestId' in request ? request.requestId : undefined;
  const toolCallId = 'toolCallId' in request ? request.toolCallId : undefined;
  if ((sessionId != null) === (requestId != null)
    || (sessionId != null && typeof sessionId !== 'string')
    || (requestId != null && typeof requestId !== 'string' && typeof requestId !== 'number')
    || (toolCallId != null && typeof toolCallId !== 'string')) {
    throw new ElicitationError('invalid', 'Invalid elicitation scope');
  }
  return {
    ...(typeof sessionId === 'string' ? { sessionId } : {}),
    ...(typeof requestId === 'string' || typeof requestId === 'number' ? { requestId } : {}),
    ...(typeof toolCallId === 'string' || toolCallId === null ? { toolCallId } : {}),
  };
}

function formSchema<P>(schema: { title?: string | null; description?: string | null; required?: string[] | null; properties?: Record<string, P> }, property: (value: P) => ElicitationProperty): ElicitationSchema {
  return {
    title: schema.title ?? null, description: schema.description ?? null, required: schema.required ?? [],
    properties: Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, value]) => [name, property(value)])),
  };
}

function v1Property(property: V1.ElicitationPropertySchema): ElicitationProperty {
  if (V1.ElicitationPropertySchema.isString(property)) { return stringProperty(property); }
  if (V1.ElicitationPropertySchema.isNumber(property)) { return numberProperty('number', property); }
  if (V1.ElicitationPropertySchema.isInteger(property)) { return numberProperty('integer', property); }
  if (V1.ElicitationPropertySchema.isBoolean(property)) { return { type: 'boolean', ...labels(property), default: property.default ?? null }; }
  if (V1.ElicitationPropertySchema.isArray(property)) {
    const items = property.items;
    const translated = V1.MultiSelectItems.isString(items) ? { type: 'string' as const, enum: [...items.enum] }
      : V1.MultiSelectItems.isTitled(items) ? { anyOf: items.anyOf.map(option) } : { type: 'other' as const };
    return arrayProperty(property, translated);
  }
  if (V1.ElicitationPropertySchema.isCustom(property)) { return { type: 'other' }; }
  throw new ElicitationError('invalid', 'Malformed elicitation field');
}

function v2Property(property: V2.ElicitationPropertySchema): ElicitationProperty {
  if (V2.ElicitationPropertySchema.isString(property)) { return stringProperty(property); }
  if (V2.ElicitationPropertySchema.isNumber(property)) { return numberProperty('number', property); }
  if (V2.ElicitationPropertySchema.isInteger(property)) { return numberProperty('integer', property); }
  if (V2.ElicitationPropertySchema.isBoolean(property)) { return { type: 'boolean', ...labels(property), default: property.default ?? null }; }
  if (V2.ElicitationPropertySchema.isArray(property)) {
    const items = property.items;
    const translated = V2.MultiSelectItems.isString(items) ? { type: 'string' as const, enum: [...items.enum] }
      : V2.MultiSelectItems.isTitled(items) ? { anyOf: items.anyOf.map(option) } : { type: 'other' as const };
    return arrayProperty(property, translated);
  }
  if (V2.ElicitationPropertySchema.isCustom(property)) { return { type: 'other' }; }
  throw new ElicitationError('invalid', 'Malformed elicitation field');
}

function labels(value: { title?: string | null; description?: string | null }) {
  return { title: value.title ?? null, description: value.description ?? null };
}

function option(value: V1.EnumOption) {
  return { const: value.const, title: value.title, description: value.description ?? null };
}

function stringProperty(property: V1.StringPropertySchema | V2.StringPropertySchema): ElicitationProperty {
  return {
    type: 'string', ...labels(property), minLength: property.minLength ?? null, maxLength: property.maxLength ?? null,
    pattern: property.pattern ?? null, format: property.format ?? null, default: property.default ?? null,
    enum: property.enum ? [...property.enum] : null, oneOf: property.oneOf ? property.oneOf.map(option) : null,
  };
}

function numberProperty(type: 'number' | 'integer', property: V1.NumberPropertySchema): ElicitationProperty {
  return { type, ...labels(property), minimum: property.minimum ?? null, maximum: property.maximum ?? null, default: property.default ?? null };
}

function arrayProperty(property: V1.MultiSelectPropertySchema | V2.MultiSelectPropertySchema, items: Extract<ElicitationProperty, { type: 'array' }>['items']): ElicitationProperty {
  return { type: 'array', ...labels(property), minItems: property.minItems ?? null, maxItems: property.maxItems ?? null, default: property.default ? [...property.default] : null, items };
}

function wireResponse(response: ElicitationResponse): { action: 'accept'; content?: Record<string, string | number | boolean | string[]> } | { action: 'decline' } | { action: 'cancel' } {
  if (response.action === 'decline') { return { action: 'decline' }; }
  if (response.action === 'cancel') { return { action: 'cancel' }; }
  if (response.content === undefined) { return { action: 'accept' }; }
  return { action: 'accept', content: Object.fromEntries(Object.entries(response.content).map(([key, value]) => [key, typeof value === 'object' ? [...value] : value])) };
}
