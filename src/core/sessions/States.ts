import type { ChildActivity, SessionUpdate, TerminalExitStatus } from '@/core/acp/AcpDriver';
import {
  initialContent,
  updateContent,
  withSubmittedPrompt,
  withSettledQuestion,
  withChildCompletion,
  withReplayedChildCompletion,
  withChildAnnouncement,
  withChildAssignment,
  withPromptError,
  endContentTurn,
  withCleanedToolContent,
  type SessionContent
} from '@/core/sessions/Content';
import { cleaned, type ShownContent } from '@/core/CommandOutput';
import { logError } from '@/core/Log';
import { ToolCallDiffs, type ShownDiffs } from '@/core/ToolCallDiffs';
import { AgentTerminals, type TerminalDisplays, type CommandSource } from '@/core/AgentTerminals';
import type { SessionIdentity, SessionRegistration, SessionLoad, SessionOrigin } from '@/core/sessions/UpdateHandler';
import type { SettledQuestion } from '@/core/sessions/Interactions';

type Usage = Omit<Extract<SessionUpdate, { kind: 'usage' }>, 'kind'>;

export interface QueuedSubmission {
  readonly revision?: number;
  readonly id: number;
  readonly text: string;
  readonly draft: string | null;
}

export type QueueChange =
  | { readonly kind: 'cancelled'; readonly id: number }
  | { readonly kind: 'editStarted' | 'editSaved' | 'editDiscarded'; readonly id: number; readonly revision: number }
  | { readonly kind: 'edited'; readonly id: number; readonly text: string; readonly revision: number };

interface SessionTerminal {
  readonly text: string;
  readonly truncated: boolean;
  readonly exitStatus: TerminalExitStatus | null;
}

interface ChildContent {
  readonly parentId: string;
  readonly title: string | null;
  readonly content: SessionContent;
  readonly activity: ChildActivity['state'] | null;
  readonly heldId?: number | undefined;
}

export interface SessionStateView {
  readonly queue: readonly QueuedSubmission[];
  readonly composer: { readonly text: string; readonly revision: number };
  readonly generation: number;
  readonly usage: Readonly<Usage> | null;
  readonly content: SessionContent;
  readonly children?: ReadonlyMap<string, ChildContent>;
  readonly terminals: ReadonlyMap<string, SessionTerminal>;
  readonly reviewOpportunity: number | null;
  readonly turnOutcome: 'completed' | 'failed' | null;
}

const emptyState = { queue: [] as readonly QueuedSubmission[], composer: { text: '', revision: 0 }, usage: null, content: initialContent, terminals: new Map<string, SessionTerminal>(), reviewOpportunity: null, turnOutcome: null };

interface SessionOutput {
  readonly terminalTimers: Map<string, ReturnType<typeof setTimeout>>;
  readonly registrations: Set<SessionRegistration>;
  sourceId: string;
  readonly sessionId: string;
  readonly terminals: AgentTerminals;
  state: SessionStateView;
  published: boolean;
  released: boolean;
  replay?: { readonly complete: Set<string>; readonly childActivity: Map<string, ChildContent['activity']> };
  continuation?: { readonly owner: SessionOutput; readonly changes: ({ readonly update: SessionUpdate; readonly now: number } | { readonly question: SettledQuestion })[] };
}

function reduced(state: SessionStateView, update: SessionUpdate, now: number, loading = false): SessionStateView {
  if (update.kind === 'usage') {
    const { used, size, cost } = update;
    return { ...state, usage: { used, size, cost } };
  }
  const content = updateContent(state.content, update, now, loading);
  return content === state.content ? state : { ...state, content };
}

function working(activity: ChildContent['activity'] | undefined): boolean {
  return activity === 'running' || activity === 'requiresAction';
}

export function descendantActivity(children: NonNullable<SessionStateView['children']>) {
  const totals = new Map<string, { running: number; requiresAction: number }>();
  for (const child of children.values()) {
    const activity = child.activity;
    if (activity !== 'running' && activity !== 'requiresAction') { continue; }
    for (let parent = child.parentId; ; ) {
      const ancestor = children.get(parent);
      if (!ancestor) { break; }
      const total = totals.get(parent) ?? { running: 0, requiresAction: 0 };
      total[activity]++;
      totals.set(parent, total);
      parent = ancestor.parentId;
    }
  }
  return totals;
}

function reduceChild(owner: SessionOutput, sessionId: string, update: SessionUpdate, now: number): void {
  const { state, replay } = owner;
  if (update.kind === 'sessionMessage' || update.kind === 'sessionMessageChunk') {
    const child = state.children?.get(sessionId);
    const content = withChildAssignment(child?.content ?? state.content, update, sessionId,
      (id) => state.children?.get(id)?.parentId === sessionId);
    owner.state = child ? { ...state, children: new Map(state.children).set(sessionId, { ...child, content }) } : { ...state, content };
    return;
  }
  const historical = replay !== undefined && !replay.complete.has(sessionId);
  if (update.kind === 'replayComplete') {
    replay?.complete.add(sessionId);
    return;
  }
  let childId = sessionId;
  let activity: ChildActivity | null | undefined;
  let child = state.children?.get(sessionId);
  const previous = child;
  let content = state.content;
  let updatedParent: ChildContent | undefined;
  if (update.kind === 'childSession') {
    childId = update.childId;
    if (childId === sessionId || childId === owner.sessionId) { return; }
    child = state.children?.get(childId);
    if (child && child.parentId !== sessionId) { return; }
    if (!child) {
      child = { parentId: sessionId, title: null, content: initialContent, activity: null };
      if (previous) { updatedParent = { ...previous, content: withChildAnnouncement(previous.content, childId) }; }
      else { content = withChildAnnouncement(content, childId); }
    }
    if (update.title !== undefined && update.title !== child.title) { child = { ...child, title: update.title }; }
    activity = update.activity;
  } else if (!child) { return; }
  else if (update.kind === 'foreground') {
    // v2 does not replay direct state updates. Only a parent mirror can be historical.
    if (historical) { return; }
    activity = update.state === 'idle' ? { state: 'idle', stopReason: update.stopReason ?? null } : { state: update.state };
  } else if (update.kind === 'activityUnknown') {
    if (historical) { return; }
    activity = { state: 'unknown' };
  } else {
    const content = updateContent(child.content, update, now, historical);
    if (content !== child.content) { child = { ...child, content }; }
  }

  if (activity !== undefined) {
    const before = historical ? replay.childActivity.get(childId) : child.activity;
    const after = activity?.state ?? null;
    const parent = updatedParent ?? state.children?.get(child.parentId);
    const heldId = historical ? undefined : child.heldId;
    let parentContent = parent?.content ?? content;
    if (historical) { replay.childActivity.set(childId, after); }
    else if (before !== after) {
      const nextHeldId = working(after) ? heldId ?? parentContent.nextId : undefined;
      if (nextHeldId !== undefined && heldId === undefined) {
        parentContent = { ...parentContent, nextId: nextHeldId + 1 };
      }
      child = { ...child, activity: after, heldId: nextHeldId };
    }
    if (activity?.state === 'idle' && working(before)) {
      child = { ...child, content: endContentTurn(child.content, now) };
      parentContent = historical ? withReplayedChildCompletion(parentContent, childId, activity.stopReason)
        : withChildCompletion(parentContent, childId, activity.stopReason, heldId,
          activity.stopReason === 'end_turn' && state.children !== undefined && descendantActivity(state.children).has(childId));
    }
    if (parent) {
      if (parent.content !== parentContent) { updatedParent = { ...parent, content: parentContent }; }
    } else {
      content = parentContent;
    }
  }
  if (child !== (update.kind === 'childSession' ? state.children?.get(childId) : previous)) {
    const children = new Map(state.children).set(childId, child);
    if (updatedParent) { children.set(child.parentId, updatedParent); }
    owner.state = { ...state, children, content };
  }
}

/** Runtime-owned values retained independently of selected presentation. */
export class SessionStates {
  private nextGeneration = 0;
  private nextSubmission = 0;
  private nextReviewOpportunity = 0;
  private readonly cleaning = new Set<Promise<void>>();
  private disposed = false;
  private disposal: Promise<void> | undefined;
  constructor(private readonly changed: () => void, private readonly terminalDisplays?: TerminalDisplays) {}
  private readonly entries = new Map<string, SessionOutput>();
  private readonly closedRegistrations = new WeakSet<SessionRegistration>();
  private readonly loads = new Map<SessionRegistration, { load: SessionLoad; output: SessionOutput }>();
  private readonly opening = new Map<string, Map<string, SessionOutput>>();
  private readonly diffs = new WeakMap<readonly ShownContent[], ToolCallDiffs>();
  private readonly releasing = new Set<Promise<void>>();

  openCommandOutput(identity: SessionIdentity, source: CommandSource, name: string): boolean {
    return this.entries.get(this.key(identity))?.terminals.open(identity.sessionId, source, name) ?? false;
  }

  private newOutput(identity: SessionIdentity, sourceId: string): SessionOutput {
    const terminals = new AgentTerminals({ open: (name, closed) => {
      if (!this.terminalDisplays) { throw new Error('Terminal display is unavailable'); }
      return this.terminalDisplays.open(name, closed);
    } });
    const owner: SessionOutput = { terminalTimers: new Map(), registrations: new Set(), sourceId, sessionId: identity.sessionId, terminals, state: { ...emptyState, generation: ++this.nextGeneration }, published: false, released: false };
    terminals.addListener((sessionId, terminalId) => {
      if (owner.released || owner.terminalTimers.has(terminalId)) { return; }
      owner.terminalTimers.set(terminalId, setTimeout(() => {
        owner.terminalTimers.delete(terminalId);
        this.readTerminal(owner, sessionId, terminalId);
      }, 250));
    });
    return owner;
  }

  private readTerminal(owner: SessionOutput, sessionId: string, terminalId: string): void {
    const { terminals } = owner;
    const info = terminals.info(sessionId, terminalId);
    const shown = terminals.shown(sessionId, terminalId);
    if (!info || !shown) { return; }
    const exitStatus = info.exitStatus;
    const work = shown.then((output) => {
      if (owner.released || terminals.info(sessionId, terminalId) !== info) { return; }
      const terminal = { text: output.text, truncated: output.truncated, exitStatus };
      const previous = owner.state.terminals.get(terminalId);
      if (previous?.text === terminal.text && previous.truncated === terminal.truncated && previous.exitStatus === terminal.exitStatus) { return; }
      owner.state = { ...owner.state, terminals: new Map(owner.state.terminals).set(terminalId, terminal) };
      if (owner.published) { this.changed(); }
    });
    this.cleaning.add(work);
    void work.then(() => this.cleaning.delete(work), (error: unknown) => { logError(`Failed to read terminal ${terminalId}`, error); });
  }

  endOutput(registration: SessionRegistration): void {
    this.entries.get(this.key({ configuredName: registration.agentName, sessionId: registration.sessionId }))?.terminals.endSession(registration.sessionId);
  }

  private releaseOutput(output: SessionOutput | undefined): void {
    if (!output || output.released) { return; }
    output.released = true;
    output.published = false;
    for (const timer of output.terminalTimers.values()) { clearTimeout(timer); }
    output.terminalTimers.clear();
    const released = output.terminals.dispose();
    this.releasing.add(released);
    void released.then(() => this.releasing.delete(released), (error: unknown) => { logError('Failed to release session output', error); });
  }

  release(identity: SessionIdentity): void {
    const key = this.key(identity);
    const owner = this.entries.get(key);
    for (const registration of owner?.registrations ?? []) { this.closedRegistrations.add(registration); }
    this.entries.delete(key);
    this.releaseOutput(owner);
    for (const [registration, pending] of this.loads) {
      if (registration.agentName !== identity.configuredName || registration.sessionId !== identity.sessionId) { continue; }
      this.closedRegistrations.add(registration);
      this.loads.delete(registration);
      this.releaseOutput(pending.output);
    }
  }

  private ingestOutput(output: SessionOutput, state: SessionStateView, sessionId: string, update: SessionUpdate): void {
    output.terminals.handleSessionUpdate(sessionId, update);
    if (update.kind !== 'toolCall' || update.content === undefined) { return; }
    const call = state.content.entries.flatMap((entry) => entry.kind === 'turn' ? entry.parts : [])
      .flatMap((part) => part.kind === 'toolCalls' ? part.toolCalls : []).find((call) => call.toolCallId === update.toolCallId);
    if (call?.toolKind === 'execute') {
      output.terminals.keepCommandText(sessionId, call.toolCallId, update.content.flatMap((item) => item.kind === 'text' ? [item.text] : []).join('\n'));
    }
  }

  view(identity: SessionIdentity): SessionStateView | undefined {
    return this.entries.get(this.key(identity))?.state;
  }

  setTurnOutcome(identity: SessionIdentity, outcome: SessionStateView['turnOutcome']): void {
    const owner = this.entries.get(this.key(identity));
    if (owner && owner.state.turnOutcome !== outcome) { owner.state = { ...owner.state, turnOutcome: outcome }; }
  }

  recordReviewOpportunity(identity: SessionIdentity): void {
    const owner = this.entries.get(this.key(identity));
    if (owner) { owner.state = { ...owner.state, reviewOpportunity: ++this.nextReviewOpportunity }; }
  }

  consumeReviewOpportunity(identity: SessionIdentity, revision: number): void {
    const owner = this.entries.get(this.key(identity));
    if (owner?.state.reviewOpportunity === revision) { owner.state = { ...owner.state, reviewOpportunity: null }; }
  }

  questionSettled(registration: SessionRegistration, question: SettledQuestion): void {
    const pending = this.loads.get(registration)?.output;
    if (pending) { pending.state = { ...pending.state, content: withSettledQuestion(pending.state.content, question, Date.now()) }; }
    const owner = this.entries.get(this.key({ configuredName: registration.agentName, sessionId: registration.sessionId }));
    if (!owner || owner.released || this.closedRegistrations.has(registration) || owner.sourceId !== registration.agentId) { return; }
    owner.state = { ...owner.state, content: withSettledQuestion(owner.state.content, question, Date.now()) };
    this.changed();
  }

  questionSettledOpening(origin: SessionOrigin, question: SettledQuestion): void {
    const owner = this.openingOutput(origin);
    if (owner.continuation) { owner.continuation.changes.push({ question }); return; }
    owner.state = { ...owner.state, content: withSettledQuestion(owner.state.content, question, Date.now()) };
  }

  editComposer(identity: SessionIdentity, generation: number, revision: number, text: string): void {
    const owner = this.entries.get(this.key(identity));
    if (owner?.state.generation !== generation || !Number.isSafeInteger(revision) || revision <= owner.state.composer.revision) { return; }
    owner.state = { ...owner.state, composer: { text, revision } };
    this.changed();
  }

  enqueue(identity: SessionIdentity, generation: number, text: string): void {
    const owner = this.entries.get(this.key(identity));
    if (owner?.state.generation !== generation || !text.trim()) { return; }
    owner.state = { ...owner.state, queue: [...owner.state.queue, { id: ++this.nextSubmission, text, draft: null }] };
    this.changed();
  }

  changeQueue(identity: SessionIdentity, generation: number, change: QueueChange): void {
    const owner = this.entries.get(this.key(identity));
    if (owner?.state.generation !== generation) { return; }
    const entry = owner.state.queue.find((entry) => entry.id === change.id);
    if (!entry) { return; }
    if (change.kind !== 'cancelled' && (!Number.isSafeInteger(change.revision) || change.revision <= (entry.revision ?? 0))) { return; }
    if (change.kind === 'cancelled' || change.kind === 'editSaved' && entry.draft !== null && !entry.draft.trim()) {
      owner.state = { ...owner.state, queue: owner.state.queue.filter((item) => item !== entry) };
    } else {
      let revised: QueuedSubmission;
      switch (change.kind) {
        case 'editStarted': revised = entry.draft === null ? { ...entry, draft: entry.text } : entry; break;
        case 'edited': revised = entry.draft !== null ? { ...entry, draft: change.text } : entry; break;
        case 'editSaved': revised = entry.draft !== null ? { ...entry, text: entry.draft, draft: null } : entry; break;
        case 'editDiscarded': revised = entry.draft !== null ? { ...entry, draft: null } : entry; break;
      }
      revised = { ...revised, revision: change.revision };
      if (revised === entry) { return; }
      owner.state = { ...owner.state, queue: owner.state.queue.map((item) => item === entry ? revised : item) };
    }
    this.changed();
  }

  takeQueued(identity: SessionIdentity, generation: number): QueuedSubmission | undefined {
    const owner = this.entries.get(this.key(identity));
    if (owner?.state.generation !== generation || owner.state.queue[0]?.draft !== null) { return; }
    const [head, ...queue] = owner.state.queue;
    owner.state = { ...owner.state, queue };
    return head;
  }

  toolCallDiffs(identity: SessionIdentity, toolCallId: string, cwd: string | null): ShownDiffs | undefined {
    const state = this.view(identity);
    const call = state?.content.entries.flatMap((entry) => entry.kind === 'turn' ? entry.parts : [])
      .flatMap((part) => part.kind === 'toolCalls' ? part.toolCalls : []).find((call) => call.toolCallId === toolCallId);
    if (!call) { return undefined; }
    let prepared = this.diffs.get(call.content);
    if (!prepared) { prepared = new ToolCallDiffs(); this.diffs.set(call.content, prepared); }
    return prepared.shown('', toolCallId, call.content.flatMap((item) => item.kind === 'diff' ? [item.diff] : []), cwd);
  }

  submitted(registration: SessionRegistration, text: string): void {
    if (this.closedRegistrations.has(registration)) { return; }
    const key = this.key({ configuredName: registration.agentName, sessionId: registration.sessionId });
    let owner = this.entries.get(key);
    if (!owner) {
      owner = this.newOutput({ configuredName: registration.agentName, sessionId: registration.sessionId }, registration.agentId);
      owner.published = true;
      this.entries.set(key, owner);
    }
    owner.registrations.add(registration);
    owner.state = { ...owner.state, content: withSubmittedPrompt(owner.state.content, text) };
  }

  promptFailed(registration: SessionRegistration, text: string): void {
    if (this.closedRegistrations.has(registration)) { return; }
    const owner = this.entries.get(this.key({ configuredName: registration.agentName, sessionId: registration.sessionId }));
    if (owner) { owner.state = { ...owner.state, content: withPromptError(owner.state.content, text) }; }
  }

  turnEnded(registration: SessionRegistration, now: number): void {
    if (this.closedRegistrations.has(registration)) { return; }
    const key = this.key({ configuredName: registration.agentName, sessionId: registration.sessionId });
    const owner = this.entries.get(key);
    if (!owner) { return; }
    const state = owner.state;
    const content = endContentTurn(state.content, now);
    if (content !== state.content) { owner.state = { ...state, content }; }
  }

  accept(registration: SessionRegistration, update: SessionUpdate, now: number): void {
    if (this.disposed || this.closedRegistrations.has(registration)) { return; }
    const key = this.key({ configuredName: registration.agentName, sessionId: registration.sessionId });
    const pending = this.loads.get(registration);
    let owner = pending?.output ?? this.entries.get(key);
    if (!owner) {
      owner = this.newOutput({ configuredName: registration.agentName, sessionId: registration.sessionId }, registration.agentId);
      owner.published = true;
      this.entries.set(key, owner);
    }
    owner.registrations.add(registration);
    const before = owner.state;
    if (update.kind === 'childSession' || update.kind === 'replayComplete' || update.kind === 'sessionMessage' || update.kind === 'sessionMessageChunk') {
      reduceChild(owner, owner.sessionId, update, now);
    }
    else { owner.state = reduced(before, update, now, pending !== undefined); }
    this.ingestOutput(owner, owner.state, registration.sessionId, update);
    if (owner.state === before) { return; }
    if ((update.kind === 'childSession' || update.kind === 'sessionMessage' || update.kind === 'sessionMessageChunk') && !pending) { this.changed(); }
    if (update.kind === 'toolCall' && update.content?.some((item) => item.kind === 'text')) {
      this.cleanToolCall(owner, update.toolCallId);
    }
  }

  /** Route only announced children, using the same staged output as their root during Load. */
  acceptChild(origin: SessionOrigin, update: SessionUpdate, now: number, ownsRoot: (rootId: string) => boolean): { rootId: string; historical: boolean } | undefined {
    const target = this.findChild(origin, ownsRoot);
    if (!target) { return undefined; }
    const historical = target.replay !== undefined && !target.replay.complete.has(origin.identity.sessionId);
    const before = target.state;
    reduceChild(target, origin.identity.sessionId, update, now);
    if (target.published && target.state !== before) { this.changed(); }
    return { rootId: target.sessionId, historical };
  }

  childPermissionLabel(origin: SessionOrigin, ownsRoot: (rootId: string) => boolean): string | undefined {
    const child = this.findChild(origin, ownsRoot)?.state.children?.get(origin.identity.sessionId);
    return child ? child.title?.trim() || origin.identity.sessionId : undefined;
  }

  private findChild(origin: SessionOrigin, ownsRoot: (rootId: string) => boolean): SessionOutput | undefined {
    const { sourceId, identity: { configuredName, sessionId } } = origin;
    const ownsChild = (owner: SessionOutput) => owner.sourceId === sourceId && owner.state.children?.has(sessionId);
    for (const [registration, { output }] of this.loads) {
      if (registration.agentName === configuredName && ownsChild(output)) { return output; }
    }
    for (const owner of this.entries.values()) {
      if (owner !== this.entries.get(this.key({ configuredName, sessionId: owner.sessionId })) || !ownsRoot(owner.sessionId)
        || [...owner.registrations].some((registration) => this.loads.has(registration))) { continue; }
      if (ownsChild(owner)) { return owner; }
    }
    return undefined;
  }

  private cleanToolCall(owner: SessionOutput, toolCallId: string): void {
    const state = owner.state;
    const call = state.content.entries.flatMap((entry) => entry.kind === 'turn' ? entry.parts : [])
      .flatMap((part) => part.kind === 'toolCalls' ? part.toolCalls : []).find((call) => call.toolCallId === toolCallId);
    if (call?.toolKind !== 'execute' || !call.content.some((item) => item.kind === 'text')) { return; }
    const expected = call.content;
    const work = Promise.allSettled(expected.map(async (item): Promise<ShownContent> => item.kind === 'text'
      ? { kind: 'commandOutput', output: await cleaned(item.text) } : item)).then((results) => {
      const shown = results.map((result) => {
        if (result.status === 'rejected') { throw result.reason; }
        return result.value;
      });
      const current = owner.state;
      const content = withCleanedToolContent(current.content, toolCallId, expected, shown);
      if (this.disposed || owner.released || content === current.content) { return; }
      owner.state = { ...current, content };
      if (owner.published) { this.changed(); }
    });
    this.cleaning.add(work);
    void work.then(() => this.cleaning.delete(work), (error: unknown) => { logError(`Failed to clean the output of tool call ${toolCallId}`, error); });
  }

  acceptOpening(origin: SessionOrigin, update: SessionUpdate, now: number): void {
    const owner = this.openingOutput(origin);
    if (owner.continuation) { owner.continuation.changes.push({ update, now }); return; }
    owner.state = reduced(owner.state, update, now);
    this.ingestOutput(owner, owner.state, origin.identity.sessionId, update);
    if (update.kind === 'toolCall' && update.content?.some((item) => item.kind === 'text')) {
      this.cleanToolCall(owner, update.toolCallId);
    }
  }

  private openingOutput(origin: SessionOrigin): SessionOutput {
    let sessions = this.opening.get(origin.sourceId);
    if (!sessions) { sessions = new Map(); this.opening.set(origin.sourceId, sessions); }
    let owner = sessions.get(origin.identity.sessionId);
    if (!owner) {
      owner = this.newOutput(origin.identity, origin.sourceId);
      const retained = this.entries.get(this.key(origin.identity));
      if (retained) { owner.continuation = { owner: retained, changes: [] }; }
      sessions.set(origin.identity.sessionId, owner);
    }
    return owner;
  }

  attach(registration: SessionRegistration): void {
    if (this.closedRegistrations.has(registration)) { return; }
    const sessions = this.opening.get(registration.agentId);
    const owner = sessions?.get(registration.sessionId);
    const identity = { configuredName: registration.agentName, sessionId: registration.sessionId };
    const key = this.key(identity);
    if (!owner) {
      if (!this.entries.has(key)) {
        const empty = this.newOutput(identity, registration.agentId);
        empty.published = true;
        this.entries.set(key, empty);
      }
      const retained = this.entries.get(key);
      if (retained) { retained.sourceId = registration.agentId; retained.registrations.add(registration); }
      return;
    }
    sessions?.delete(registration.sessionId);
    if (sessions?.size === 0) { this.opening.delete(registration.agentId); }
    if (owner.continuation) {
      const { owner: retained, changes } = owner.continuation;
      this.releaseOutput(owner);
      if (retained.released || this.entries.get(key) !== retained) { this.closedRegistrations.add(registration); return; }
      retained.sourceId = registration.agentId;
      retained.registrations.add(registration);
      for (const change of changes) {
        if ('update' in change) { this.accept(registration, change.update, change.now); }
        else { this.questionSettled(registration, change.question); }
      }
      return;
    }
    this.releaseOutput(this.entries.get(key));
    owner.published = true;
    owner.registrations.add(registration);
    this.entries.set(key, owner);
  }

  retireSource(sourceId: string): void {
    for (const output of this.opening.get(sourceId)?.values() ?? []) { this.releaseOutput(output); }
    for (const output of this.entries.values()) {
      if (output.sourceId !== sourceId) { continue; }
      if (output.state.queue.length > 0) { output.state = { ...output.state, queue: [] }; }
      if (output.state.children && [...output.state.children.values()].some((child) => child.activity !== null)) {
        output.state = { ...output.state, children: new Map([...output.state.children].map(([id, child]) => [id, { ...child, activity: null, heldId: undefined }])) };
      }
      output.terminals.endSession(output.sessionId);
    }
    this.opening.delete(sourceId);
  }

  discardOpening(sourceId: string, sessionId: string): void {
    const sessions = this.opening.get(sourceId);
    this.releaseOutput(sessions?.get(sessionId));
    sessions?.delete(sessionId);
    if (sessions?.size === 0) { this.opening.delete(sourceId); }
  }

  discardOpenings(sourceId: string, discard: (sessionId: string) => boolean): void {
    for (const id of this.opening.get(sourceId)?.keys() ?? []) {
      if (discard(id)) { this.discardOpening(sourceId, id); }
    }
  }

  beginLoad(load: SessionLoad): void {
    if (this.closedRegistrations.has(load.registration)) { return; }
    this.releaseOutput(this.loads.get(load.registration)?.output);
    const output = this.newOutput({ configuredName: load.registration.agentName, sessionId: load.registration.sessionId }, load.registration.agentId);
    output.replay = { complete: new Set(), childActivity: new Map() };
    this.loads.set(load.registration, { load, output });
  }

  endLoad(load: SessionLoad, ok: boolean, keepTurnOpen = false): void {
    const pending = this.loads.get(load.registration);
    if (pending?.load !== load) { return; }
    this.loads.delete(load.registration);
    if (ok) {
      delete pending.output.replay;
      if (!keepTurnOpen) {
        pending.output.state = { ...pending.output.state, content: endContentTurn(pending.output.state.content, Date.now()) };
      }
      const key = this.key({ configuredName: load.registration.agentName, sessionId: load.registration.sessionId });
      const previous = this.entries.get(key);
      if (previous) { pending.output.state = { ...pending.output.state, composer: previous.state.composer, queue: previous.state.queue,
        reviewOpportunity: previous.state.reviewOpportunity, turnOutcome: previous.state.turnOutcome }; }
      for (const registration of previous?.registrations ?? []) {
        if (registration !== load.registration) { this.closedRegistrations.add(registration); }
      }
      this.releaseOutput(previous);
      pending.output.published = true;
      pending.output.registrations.add(load.registration);
      this.entries.set(key, pending.output);
    } else { this.releaseOutput(pending.output); }
  }

  rename(from: string, to: string): void {
    for (const [key, value] of this.entries) {
      const identity: unknown = JSON.parse(key);
      if (!Array.isArray(identity) || identity[0] !== from || typeof identity[1] !== 'string') { continue; }
      this.entries.delete(key);
      this.entries.set(this.key({ configuredName: to, sessionId: identity[1] }), value);
    }
  }

  dispose(): Promise<void> {
    if (this.disposal) { return this.disposal; }
    this.disposed = true;
    for (const output of this.entries.values()) { this.releaseOutput(output); }
    for (const outputs of this.opening.values()) {
      for (const output of outputs.values()) { this.releaseOutput(output); }
    }
    for (const pending of this.loads.values()) { this.releaseOutput(pending.output); }
    this.opening.clear();
    this.loads.clear();
    this.entries.clear();
    this.disposal = Promise.allSettled([...this.cleaning, ...this.releasing]).then((results) => {
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length > 0) { throw new AggregateError(failures.map((result) => result.reason as unknown), 'Failed to dispose session output'); }
    });
    return this.disposal;
  }

  private key({ configuredName, sessionId }: SessionIdentity): string {
    return JSON.stringify([configuredName, sessionId]);
  }
}
